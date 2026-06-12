import {
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import {
    type GateOutcome
} from '../task-audit/task-audit-summary-collectors';
import {
    buildCommand
} from './next-step-command-formatters';
import {
    redactSecretText
} from '../../core/redaction';
import type {
    NextStepCommand,
    NextStepStatus
} from './';

export interface NextStepFullSuiteValidationRoute {
    status: NextStepStatus;
    nextGate: string;
    title: string;
    reason: string;
    commands: NextStepCommand[];
}

export interface InterruptedFullSuiteValidationRunRouteInput {
    markerPath: string;
    startedAtUtc: string;
    command: string;
    timeoutMs: number;
    gatePid: number;
    gateProcessAlive: boolean;
    childPid: number | null;
    childProcessAlive: boolean | null;
    childCommand: string | null;
    descendantProcessCandidates?: Array<{
        pid: number;
        parentPid: number | null;
        commandLine: string;
    }>;
    processScanWarning?: string | null;
}

export interface NextStepFullSuiteValidationRoutingOptions {
    enabled: boolean;
    placement: FullSuiteValidationPlacement;
    notRequiredForCurrentScope: boolean;
    gateStatus: GateOutcome['status'] | null;
    gatePassed: boolean;
    timedOutRetryAvailable: boolean;
    transientRetryEvidenceAvailable: boolean;
    transientRetryEvidenceReason: string | null;
    configPath: string;
    commandText: string;
    timeoutForecastLine: string | null;
    command: string;
    runMarkerRecoveryCommand: string;
    runMarkerCleanupCommand: string;
    navigatorCommand: string;
    nextReviewType: string | null;
    interruptedRun?: InterruptedFullSuiteValidationRunRouteInput | null;
    unresolvedRunMarkerPath?: string | null;
}

export function resolveNextStepFullSuiteValidationRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    if (shouldRunFullSuiteAfterCompileBeforeReviews(
        options.enabled,
        options.placement,
        options.notRequiredForCurrentScope
    )) {
        return resolveAfterCompileBeforeReviewsRoute(options);
    }

    if (
        shouldRunFullSuiteBeforeTestReview(
            options.enabled,
            options.placement,
            options.notRequiredForCurrentScope
        )
        && options.nextReviewType === 'test'
    ) {
        return resolveBeforeTestReviewRoute(options);
    }

    return null;
}

export function shouldRunFullSuiteAfterCompileBeforeReviews(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'after_compile_before_reviews'
        && !fullSuiteNotRequiredForCurrentScope;
}

export function shouldRunFullSuiteBeforeTestReview(
    enabled: boolean,
    placement: FullSuiteValidationPlacement,
    fullSuiteNotRequiredForCurrentScope: boolean
): boolean {
    return enabled
        && placement === 'before_test_review'
        && !fullSuiteNotRequiredForCurrentScope;
}

function resolveAfterCompileBeforeReviewsRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    if (options.gateStatus === 'FAIL') {
        if (options.timedOutRetryAvailable) {
            return buildRetryRoute(
                options,
                'Retry full-suite validation with updated timeout forecast.',
                'Rerun the configured full-suite command before launching independent reviewers.'
            );
        }
        if (options.transientRetryEvidenceAvailable) {
            return buildManualTransientRetryRoute(
                options,
                'Retry full-suite validation after focused transient evidence.',
                'Rerun the configured full-suite command before launching independent reviewers.'
            );
        }
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Fix full-suite failures before reviewer launch.',
            reason:
                `Full-suite validation is configured for placement '${options.placement}' and already failed for the current compiled scope. ` +
                `Do not launch independent reviewers until the configured full-suite command passes; ` +
                `fix the failures, rerun compile-gate if implementation changed, then rerun full-suite-validation.`,
            commands: [
                buildCommand(
                    'Rerun navigator after fixing implementation',
                    options.navigatorCommand
                )
            ]
        };
    }

    if (!options.gatePassed) {
        const interruptedRoute = buildInterruptedRunRecoveryRoute(
            options,
            'Recover interrupted full-suite validation run.',
            'Recover the interrupted full-suite run before launching independent reviewers.'
        );
        if (interruptedRoute) {
            return interruptedRoute;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run full-suite validation after compile before reviews.',
            reason:
                `Effective workflow config enables full-suite validation at ${options.configPath} with placement '${options.placement}'. ` +
                `Run it after compile-gate and before launching independent reviewers so suite failures fail fast on the same compiled scope. ` +
                `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                `Command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    options.command
                )
            ]
        };
    }

    return null;
}

function resolveBeforeTestReviewRoute(
    options: NextStepFullSuiteValidationRoutingOptions
): NextStepFullSuiteValidationRoute | null {
    if (options.gateStatus === 'FAIL') {
        if (options.timedOutRetryAvailable) {
            return buildRetryRoute(
                options,
                'Retry full-suite validation with updated timeout forecast.',
                'Rerun it before launching the mandatory test reviewer.'
            );
        }
        if (options.transientRetryEvidenceAvailable) {
            return buildManualTransientRetryRoute(
                options,
                'Retry full-suite validation after focused transient evidence.',
                'Rerun it before launching the mandatory test reviewer.'
            );
        }
        return {
            status: 'BLOCKED',
            nextGate: 'implementation',
            title: 'Fix full-suite failures before launching test review.',
            reason:
                `Full-suite validation is enabled and already failed for the current compiled scope. ` +
                `Do not launch the mandatory test reviewer until the configured full-suite command passes; ` +
                `fix the failures, rerun compile-gate if implementation changed, then rerun full-suite-validation.`,
            commands: [
                buildCommand(
                    'Rerun navigator after fixing implementation',
                    options.navigatorCommand
                )
            ]
        };
    }

    if (!options.gatePassed) {
        const interruptedRoute = buildInterruptedRunRecoveryRoute(
            options,
            'Recover interrupted full-suite validation run.',
            'Recover the interrupted full-suite run before launching the mandatory test reviewer.'
        );
        if (interruptedRoute) {
            return interruptedRoute;
        }
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run full-suite validation before test review.',
            reason:
                `Effective workflow config enables full-suite validation at ${options.configPath} with placement '${options.placement}'. ` +
                `Run it before launching the mandatory test reviewer so suite failures fail fast on the same compiled scope. ` +
                `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                `Command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    options.command
                )
            ]
        };
    }

    return null;
}

function buildInterruptedRunRecoveryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute | null {
    const interruptedRun = options.interruptedRun;
    if (!interruptedRun) {
        if (options.unresolvedRunMarkerPath) {
            return {
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Inspect unresolved full-suite run marker state.',
                reason:
                    `A full-suite run marker exists at ${options.unresolvedRunMarkerPath}, but it is stale, invalid, malformed, or not bound to the current preflight/compile cycle. ` +
                    `Do not start a fresh full-suite run until the marker is inspected because a new run would overwrite the diagnostic marker. ` +
                    `Run the recovery command to preserve evidence and report the exact marker state before any cleanup. ${retryInstruction} ` +
                    `Retry command after recovery: ${redactDiagnosticText(options.commandText)}. ${options.timeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Inspect unresolved full-suite run marker state',
                        options.runMarkerRecoveryCommand
                    )
                ]
            };
        }
        return null;
    }
    if (interruptedRun.gateProcessAlive) {
        return {
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Wait for active full-suite validation run.',
            reason:
                `A full-suite validation run started at ${interruptedRun.startedAtUtc} and is still active for the current compiled scope. ` +
                `The run marker is ${interruptedRun.markerPath}; gate pid ${interruptedRun.gatePid} is still alive. ` +
                `Do not start a second full-suite run. Wait for the active run to write terminal evidence, or inspect only task-owned processes if the run appears stuck. ` +
                `Interrupted command: ${redactDiagnosticText(interruptedRun.command)}. Timeout configured for this run: ${interruptedRun.timeoutMs} ms. ${options.timeoutForecastLine || ''}`.trim(),
            commands: [
                buildCommand(
                    'Rerun navigator after the active full-suite run completes',
                    options.navigatorCommand
                )
            ]
        };
    }

    const childState = interruptedRun.childPid == null
        ? 'no child PID was recorded'
        : interruptedRun.childProcessAlive
            ? `child pid ${interruptedRun.childPid} is still alive`
            : `child pid ${interruptedRun.childPid} is no longer alive`;
    const childCommand = interruptedRun.childCommand
        ? ` Child command: ${redactDiagnosticText(interruptedRun.childCommand)}.`
        : '';
    const descendantCandidates = interruptedRun.descendantProcessCandidates || [];
    const hasLiveChildTree =
        interruptedRun.childProcessAlive === true
        || descendantCandidates.length > 0
        || !!interruptedRun.processScanWarning;
    const descendantState = descendantCandidates.length > 0
        ? ` Live descendant candidates from the recorded child process: ${formatProcessCandidates(descendantCandidates)}.`
        : interruptedRun.processScanWarning
            ? ` No descendant process candidates were listed because process scanning failed: ${redactDiagnosticText(interruptedRun.processScanWarning)}.`
            : ' No live descendant process candidates were discovered from the recorded child pid; do not kill generic node.exe or IDE/Codex Node processes without separate task-owned command-line or working-directory evidence.';
    const actionCommand = hasLiveChildTree
        ? options.runMarkerRecoveryCommand
        : options.runMarkerCleanupCommand;
    const actionLabel = hasLiveChildTree
        ? 'Inspect interrupted full-suite run marker'
        : 'Clear dead full-suite run marker after preserving recovery evidence';

    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `A previous full-suite validation run started at ${interruptedRun.startedAtUtc}, but no terminal full-suite artifact was materialized for the current compiled scope. ` +
            `The run marker is ${interruptedRun.markerPath}; gate pid ${interruptedRun.gatePid} is no longer alive; ${childState}.${childCommand}${descendantState} ` +
            `Inspect and terminate only task-owned processes confirmed by the marker, descendant scan, command line, or working-directory evidence, then rerun full-suite-validation. ${retryInstruction} ` +
            `Interrupted command: ${redactDiagnosticText(interruptedRun.command)}. Retry command: ${redactDiagnosticText(options.commandText)}. Timeout configured for the interrupted run: ${interruptedRun.timeoutMs} ms. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                actionLabel,
                actionCommand
            )
        ]
    };
}

function formatProcessCandidates(candidates: Array<{
    pid: number;
    parentPid: number | null;
    commandLine: string;
}>): string {
    return candidates.slice(0, 5).map((candidate) => {
        const parent = candidate.parentPid == null ? 'unknown' : String(candidate.parentPid);
        const redactedCommandLine = redactDiagnosticText(candidate.commandLine);
        const commandLine = redactedCommandLine.length > 160
            ? `${redactedCommandLine.slice(0, 157)}...`
            : redactedCommandLine;
        return `pid=${candidate.pid}, ppid=${parent}, command=${commandLine || '<unavailable>'}`;
    }).join('; ');
}

function redactDiagnosticText(text: string): string {
    return redactSecretText(text);
}

function buildRetryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute {
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `Full-suite validation timed out for the current compiled scope, and duration history now recommends a longer timeout. ` +
            `${retryInstruction} ` +
            `Command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                'Retry full-suite validation',
                options.command
            )
        ]
    };
}

function buildManualTransientRetryRoute(
    options: NextStepFullSuiteValidationRoutingOptions,
    title: string,
    retryInstruction: string
): NextStepFullSuiteValidationRoute {
    const evidenceReason = options.transientRetryEvidenceReason
        ? ` ${options.transientRetryEvidenceReason}`
        : '';
    return {
        status: 'BLOCKED',
        nextGate: 'full-suite-validation',
        title,
        reason:
            `Full-suite validation failed for the current compiled scope, but task-scoped focused validation evidence marks the failure as transient or already cleared.${evidenceReason} ` +
            `${retryInstruction} Focused validation is recovery guidance only and does not replace mandatory full-suite evidence. ` +
            `Command: ${options.commandText}. ${options.timeoutForecastLine || ''}`.trim(),
        commands: [
            buildCommand(
                'Retry full-suite validation',
                options.command
            )
        ]
    };
}
