import {
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import {
    type GateOutcome
} from '../task-audit/task-audit-summary-collectors';
import {
    buildCommand
} from './next-step-command-formatters';
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
    navigatorCommand: string;
    nextReviewType: string | null;
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
