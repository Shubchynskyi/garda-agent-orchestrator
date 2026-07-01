import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildGardaSelfGuardPolicyChangeCommand,
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle
} from '../../core/workflow-config';
import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    buildCoherentCycleRestartCommand
} from '../completion/completion-reporting';
import {
    collectOrderedTimelineEvents
} from '../completion/completion-evidence';
import {
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations,
    type PostPreflightRulePackRebindDecision
} from '../rule-pack/rule-pack';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    buildCompileEvidenceDocsOnlyExtensionReadiness,
    readCurrentGitWorkspaceSnapshot
} from './next-step-compile-full-suite-readiness';
import {
    buildBundleRelativePath
} from './next-step-command-formatters';
import {
    buildOrchestratorWorkRestartCommand
} from './next-step-lifecycle-command-builders';
import {
    findLatestTimelineEvent,
    getTimelineEventDetailString
} from './next-step-timeline-readers';

export interface FailedGateRecovery {
    nextGate: string;
    title: string;
    reason: string;
    label: string;
    command: string;
}

export interface RulePackReadiness {
    ready: boolean;
    reason: string;
    rebind: PostPreflightRulePackRebindDecision | null;
}

export interface CoherentCycleReadiness {
    ready: boolean;
    reason: string;
    command: string | null;
}

const COHERENT_CYCLE_BOUNDARY_EVENTS = new Set([
    'IMPLEMENTATION_STARTED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

const RESTART_COMPLETED_EVENT_TYPES = new Set([
    'COHERENT_CYCLE_RESTARTED',
    'REVIEW_CYCLE_RESTARTED'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function resolveBundleRootForNextStep(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

export function readPostPreflightRulePackReadiness(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    rulePackPath: string,
    taskModePath: string
): RulePackReadiness {
    const rebind = getPostPreflightRulePackRebindDecision(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', {
        preflightPath,
        artifactPath: rulePackPath,
        taskModePath
    });
    const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath,
        taskModePath
    });
    const violations = [
        ...getRulePackEvidenceViolations(evidence),
        ...sequenceEvidence.violations
    ];
    if (violations.length === 0 && evidence.binding_equivalent_to_current_preflight && sequenceEvidence.binding_equivalent_to_current_preflight) {
        return {
            ready: true,
            reason: 'POST_PREFLIGHT rule-pack evidence is current for the latest preflight.',
            rebind: null
        };
    }
    if (violations.length === 0) {
        violations.push('POST_PREFLIGHT rule-pack evidence is not bound to the latest preflight.');
    }
    return {
        ready: false,
        reason: violations.join(' '),
        rebind
    };
}

function hasProtectedOrchestratorWorkRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('protected')
        && normalized.includes('control-plane')
        && normalized.includes('enter-task-mode')
        && normalized.includes('--orchestrator-work');
}

function hasWorkflowConfigWorkRecoverySignal(message: string): boolean {
    const normalized = String(message || '').toLowerCase();
    return normalized.includes('workflow config files changed before')
        && normalized.includes('task-mode')
        && normalized.includes('--workflow-config-work');
}

function isSha256(value: unknown): value is string {
    return /^[0-9a-f]{64}$/u.test(String(value || '').trim().toLowerCase());
}

function resolveEventPath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath) {
        return null;
    }
    try {
        return resolvePathInsideRepo(rawPath, repoRoot, { allowMissing: true, enforceInside: true });
    } catch {
        return null;
    }
}

function validateRestartCompletedEvent(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string,
    restartEvent: NonNullable<ReturnType<typeof findLatestTimelineEvent>>
): string[] {
    const details = restartEvent.details || {};
    const violations: string[] = [];
    if (String(details.task_id || '').trim() !== taskId) {
        violations.push('task_id does not match the current task');
    }
    for (const [fieldName, label] of [
        ['task_mode_sha256', 'task-mode'],
        ['preflight_sha256', 'preflight'],
        ['compile_evidence_sha256', 'compile evidence']
    ] as const) {
        if (!isSha256(details[fieldName])) {
            violations.push(`${label} hash is missing or invalid`);
        }
    }
    if (!Number.isInteger(Number(details.detected_changed_files_count)) || Number(details.detected_changed_files_count) < 0) {
        violations.push('detected_changed_files_count is missing or invalid');
    }
    if (!Number.isInteger(Number(details.elapsed_ms)) || Number(details.elapsed_ms) < 0) {
        violations.push('elapsed_ms is missing or invalid');
    }
    if (!String(details.restart_reason || '').trim()) {
        violations.push('restart_reason is missing');
    }
    if (!String(details.next_step_summary || '').trim()) {
        violations.push('next_step_summary is missing');
    }

    const taskModePath = resolveEventPath(repoRoot, details.task_mode_path);
    if (!taskModePath) {
        violations.push('task_mode_path is missing or outside the repository');
    } else if (!isSha256(details.task_mode_sha256) || !fs.existsSync(taskModePath) || fileSha256(taskModePath) !== details.task_mode_sha256) {
        violations.push('task-mode hash does not match the current artifact');
    }

    const eventPreflightPath = resolveEventPath(repoRoot, details.preflight_path);
    const normalizedExpectedPreflightPath = normalizePath(path.resolve(preflightPath));
    if (!eventPreflightPath) {
        violations.push('preflight_path is missing or outside the repository');
    } else if (normalizePath(path.resolve(eventPreflightPath)) !== normalizedExpectedPreflightPath) {
        violations.push('preflight_path does not match the latest preflight');
    } else if (!isSha256(details.preflight_sha256) || !fs.existsSync(eventPreflightPath) || fileSha256(eventPreflightPath) !== details.preflight_sha256) {
        violations.push('preflight hash does not match the current artifact');
    }

    const compileEvidencePath = resolveEventPath(repoRoot, details.compile_evidence_path);
    const normalizedExpectedCompileEvidencePath = normalizePath(path.resolve(reviewsRoot, `${taskId}-compile-gate.json`));
    if (!compileEvidencePath) {
        violations.push('compile_evidence_path is missing or outside the repository');
    } else if (normalizePath(path.resolve(compileEvidencePath)) !== normalizedExpectedCompileEvidencePath) {
        violations.push('compile_evidence_path does not match the latest compile evidence artifact');
    } else if (!isSha256(details.compile_evidence_sha256) || !fs.existsSync(compileEvidencePath) || fileSha256(compileEvidencePath) !== details.compile_evidence_sha256) {
        violations.push('compile evidence hash does not match the current artifact');
    }

    return violations;
}

export function readFailedGateRecovery(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    cliPrefix: string,
    taskMode: Record<string, unknown> | null
): FailedGateRecovery | null {
    if (!taskMode) {
        return null;
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return null;
    }

    const latestPreflightFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_FAILED'
    );
    if (!latestPreflightFailure) {
        return null;
    }

    const latestPreflightSuccess = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (latestPreflightSuccess && latestPreflightSuccess.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestTaskMode.sequence > latestPreflightFailure.sequence) {
        return null;
    }

    const errorText = getTimelineEventDetailString(latestPreflightFailure, 'error');
    const hasProtectedRecoverySignal = hasProtectedOrchestratorWorkRecoverySignal(errorText);
    const hasWorkflowConfigRecoverySignal = hasWorkflowConfigWorkRecoverySignal(errorText);
    if (!hasProtectedRecoverySignal && !hasWorkflowConfigRecoverySignal) {
        return null;
    }
    if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
        return {
            nextGate: 'operator-maintenance',
            title: 'Garda self-guard blocks agent-owned protected control-plane recovery.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected ${hasWorkflowConfigRecoverySignal ? 'workflow-config' : 'control-plane'} recovery signal. ` +
                formatGardaSelfGuardProtectedControlPlaneGuidance(),
            label: 'Operator policy change',
            command: buildGardaSelfGuardPolicyChangeCommand(cliPrefix)
        };
    }
    const currentWorkspace = readCurrentGitWorkspaceSnapshot(repoRoot, true);
    const currentChangedFiles = Array.isArray(currentWorkspace?.changed_files)
        ? currentWorkspace.changed_files
        : [];

    return {
        nextGate: 'enter-task-mode',
        title: hasWorkflowConfigRecoverySignal
            ? 'Recover failed classify-change as workflow-config work.'
            : 'Recover failed classify-change as orchestrator work.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected ${hasWorkflowConfigRecoverySignal ? 'workflow-config' : 'control-plane'} recovery signal. ` +
            'Run the deterministic recovery command rebuilt from current task-mode and workspace state before reclassifying, after fresh operator approval for protected task-mode entry.',
        label: hasWorkflowConfigRecoverySignal
            ? 'Restart task mode with workflow-config work'
            : 'Restart task mode with orchestrator work',
        command: buildOrchestratorWorkRestartCommand(
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            currentChangedFiles,
            hasWorkflowConfigRecoverySignal
        )
    };
}

function getDefaultCommandsPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md'));
}

function getDefaultOutputFiltersPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/config/output-filters.json'));
}

export function readCoherentCycleReadiness(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null
): CoherentCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.',
            command: null
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.',
            command: null
        };
    }

    const latestBoundary = findLatestTimelineEvent(
        events,
        (entry) => entry.sequence < latestPreflight.sequence && COHERENT_CYCLE_BOUNDARY_EVENTS.has(entry.event_type)
    );
    const lowerBoundExclusive = latestBoundary?.sequence ?? Number.NEGATIVE_INFINITY;
    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );
    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => (
            entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
            && entry.sequence > lowerBoundExclusive
            && entry.sequence < latestPreflight.sequence
        )
    );

    const violations: string[] = [];
    if (!latestHandshake) {
        violations.push('HANDSHAKE_DIAGNOSTICS_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (!latestShellSmoke) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED is missing before the latest PREFLIGHT_CLASSIFIED inside the latest execution cycle');
    }
    if (latestHandshake && latestShellSmoke && latestShellSmoke.sequence < latestHandshake.sequence) {
        violations.push('SHELL_SMOKE_PREFLIGHT_RECORDED predates HANDSHAKE_DIAGNOSTICS_RECORDED inside the latest execution cycle');
    }

    if (violations.length === 0) {
        const latestCompilePass = findLatestTimelineEvent(
            events,
            (entry) => entry.event_type === 'COMPILE_GATE_PASSED' && entry.sequence > latestPreflight.sequence
        );
        if (latestBoundary && latestCompilePass) {
            const restartCompletedEvent = findLatestTimelineEvent(
                events,
                (entry) => RESTART_COMPLETED_EVENT_TYPES.has(entry.event_type) && entry.sequence > latestCompilePass.sequence
            );
            if (!restartCompletedEvent) {
                const compileAnchor = ` after COMPILE_GATE_PASSED (seq ${latestCompilePass.sequence})`;
                const cycleAnchor = ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`;
                const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
                const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
                    ? compileEvidence.commands_path.trim()
                    : getDefaultCommandsPath(repoRoot);
                const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
                    ? compileEvidence.output_filters_path.trim()
                    : getDefaultOutputFiltersPath(repoRoot);
                const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
                const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
                    && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
                return {
                    ready: false,
                    reason:
                        `Latest restarted compile cycle${cycleAnchor} has no persisted restart-completed event${compileAnchor}. ` +
                        'Rerun restart-coherent-cycle so long compile recovery cannot advance from stdout-only success.',
                    command: buildCoherentCycleRestartCommand(
                        repoRoot,
                        taskId,
                        normalizePath(preflightPath),
                        taskModePath,
                        commandsPath,
                        outputFiltersPath,
                        { requiresOperatorConfirmation }
                    )
                };
            }
            const restartEventViolations = validateRestartCompletedEvent(
                repoRoot,
                reviewsRoot,
                taskId,
                preflightPath,
                restartCompletedEvent
            );
            if (restartEventViolations.length > 0) {
                const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
                const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
                    ? compileEvidence.commands_path.trim()
                    : getDefaultCommandsPath(repoRoot);
                const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
                    ? compileEvidence.output_filters_path.trim()
                    : getDefaultOutputFiltersPath(repoRoot);
                const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
                const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
                    && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
                return {
                    ready: false,
                    reason:
                        `Latest restart-completed event ${restartCompletedEvent.event_type} (seq ${restartCompletedEvent.sequence}) is not valid durable recovery evidence: ` +
                        `${restartEventViolations.join('; ')}. Rerun restart-coherent-cycle to refresh task-mode, preflight, compile, and restart evidence together.`,
                    command: buildCoherentCycleRestartCommand(
                        repoRoot,
                        taskId,
                        normalizePath(preflightPath),
                        taskModePath,
                        commandsPath,
                        outputFiltersPath,
                        { requiresOperatorConfirmation }
                    )
                };
            }
        }
        return {
            ready: true,
            reason: 'Latest preflight has current-cycle handshake and shell-smoke evidence.',
            command: null
        };
    }

    const preflightPayload = safeReadJson(preflightPath);
    const latestBoundaryType = String(latestBoundary?.event_type || '').trim();
    if (
        isPlainRecord(preflightPayload)
        && [
            'REVIEW_GATE_PASSED',
            'REVIEW_GATE_PASSED_WITH_OVERRIDE',
            'COMPLETION_GATE_FAILED'
        ].includes(latestBoundaryType)
    ) {
        const docsOnlyExtensionReadiness = buildCompileEvidenceDocsOnlyExtensionReadiness(
            repoRoot,
            reviewsRoot,
            taskId,
            preflightPayload
        );
        if (docsOnlyExtensionReadiness) {
            return {
                ready: true,
                reason:
                    `Latest preflight was refreshed after ${latestBoundaryType}, but the refreshed scope only adds ordinary docs/closeout files ` +
                    'while implementation/test/config domains remain bound to the latest compile evidence. ' +
                    docsOnlyExtensionReadiness.reason,
                command: null
            };
        }
    }

    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
        ? compileEvidence.commands_path.trim()
        : getDefaultCommandsPath(repoRoot);
    const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
        ? compileEvidence.output_filters_path.trim()
        : getDefaultOutputFiltersPath(repoRoot);
    const taskModePayload = taskModePath ? safeReadJson(taskModePath) : null;
    const requiresOperatorConfirmation = isPlainRecord(taskModePayload)
        && (taskModePayload.orchestrator_work === true || taskModePayload.workflow_config_work === true);
    const cycleAnchor = latestBoundary
        ? ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`
        : '';

    return {
        ready: false,
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) is not in a coherent preflight cycle${cycleAnchor}: ${violations.join('; ')}. Run restart-coherent-cycle before compile/review/completion so expensive review work is not launched against stage-sequence evidence that completion-gate will reject.`,
        command: buildCoherentCycleRestartCommand(
            repoRoot,
            taskId,
            normalizePath(preflightPath),
            taskModePath,
            commandsPath,
            outputFiltersPath,
            { requiresOperatorConfirmation }
        )
    };
}

export function resolveActiveTaskModeArtifactPath(
    repoRoot: string,
    eventsRoot: string,
    reviewsRoot: string,
    taskId: string
): string {
    const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return defaultTaskModePath;
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    const rawArtifactPath = latestTaskMode?.details?.artifact_path ?? latestTaskMode?.details?.artifactPath;
    const artifactPath = typeof rawArtifactPath === 'string' ? rawArtifactPath.trim() : '';
    if (!artifactPath) {
        return defaultTaskModePath;
    }
    return resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true }) || defaultTaskModePath;
}

function getLatestTimelineSequence(eventsRoot: string, taskId: string, eventType: string): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const errors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, errors);
    let latestSequence: number | null = null;
    for (const event of events) {
        if (event.event_type !== eventType) {
            continue;
        }
        const sequence = event.integrity?.task_sequence ?? event.sequence;
        if (!Number.isFinite(sequence)) {
            continue;
        }
        latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}

export function isLatestCompletionCurrent(eventsRoot: string, taskId: string): boolean {
    const latestCompletionSequence = getLatestTimelineSequence(eventsRoot, taskId, 'COMPLETION_GATE_PASSED');
    if (latestCompletionSequence == null) {
        return false;
    }
    const latestTaskModeSequence = getLatestTimelineSequence(eventsRoot, taskId, 'TASK_MODE_ENTERED');
    return latestTaskModeSequence == null || latestCompletionSequence >= latestTaskModeSequence;
}
