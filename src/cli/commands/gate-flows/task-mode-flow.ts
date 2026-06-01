import * as fs from 'node:fs';
import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../exit-codes';
import {
    emitHandshakeDiagnosticsEvent,
    emitShellSmokePreflightEvent,
    emitCommandTimeoutDiagnosticsEvent,
    emitPlanCreatedEvent,
    emitProviderRoutingEvent,
    emitStatusChangedEvent
} from '../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../../../gate-runtime/task-events';
import { withFilesystemLock } from '../../../gate-runtime/task-events-locking';
import {
    buildHandshakeDiagnostics,
    formatHandshakeDiagnosticsResult,
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    resolveHandshakeArtifactPath
} from '../../../gates/handshake-diagnostics';
import {
    buildShellSmokePreflight,
    formatShellSmokePreflightResult,
    getShellSmokeEvidence,
    resolveShellSmokeArtifactPath
} from '../../../gates/shell-smoke-preflight';
import {
    buildCommandTimeoutDiagnostics,
    formatCommandTimeoutDiagnosticsResult,
    resolveCommandTimeoutArtifactPath,
    type CommandPhaseRecord
} from '../../../gates/command-timeout-diagnostics';
import {
    buildTaskModeArtifact,
    parseTaskModeDepth,
    readOptionalMarkdownWorkingPlan,
    resolveTaskModeArtifactPath,
    type TaskModePlanMetadata
} from '../../../gates/task-mode';
import { captureDirtyWorkspaceBaseline } from '../../../gates/dirty-worktree-protection';
import {
    validateTaskPlan,
    computeTaskPlanDigest,
    isApprovedPlan
} from '../../../schemas/task-plan';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigPreTaskBaselineState
} from '../../../gates/workflow-config-work';
import {
    readTaskQueueMetadata
} from '../../../gates/task-audit-summary-collectors';
import * as gateHelpers from '../../../gates/helpers';
import {
    resolveTaskProfileSelection
} from '../../../policy/task-profile-selection';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../gates-artifacts';
import {
    parseBooleanOption
} from '../gates-parser';
import { requireResolvedPath } from '../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    appendMetricsIfEnabled
} from './gate-flow-helpers';
import { readRoutingDecision } from './routing-decision';
import { readTaskQueueStatus, syncTaskQueueStatus } from './task-queue-sync';
import {
    buildGateCommandPrefix,
    quotePowerShellCliValue
} from './task-mode-command-format';
import {
    assertTaskModeProtectedEntryAllowed,
    WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE
} from './task-mode-entry-protection';
import { resolveTaskModeEntryScope } from './task-mode-entry-scope';
import { resolveTaskModeStartBanner } from './task-mode-entry-start-banner';
import {
    assertResolvedRuntimeIdentityForDependentPreflightGate,
    assertTaskModeRuntimeIdentity,
    resolveTaskModeReviewerRoutingFields
} from './task-mode-runtime-identity';
import {
    runBindRulePackToPreflightCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runRecordStrictDecompositionDecisionCommand,
    type BindRulePackToPreflightCommandOptions,
    type LoadRulePackCommandOptions,
    type RecordNoOpCommandOptions,
    type RecordStrictDecompositionDecisionCommandOptions
} from './task-mode-record-commands';
import {
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    type RecordReviewCycleContinuationCommandOptions,
    type RecordReviewCycleSplitDecisionCommandOptions
} from './task-mode-review-cycle-commands';

export { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE };
export {
    runBindRulePackToPreflightCommand,
    runLoadRulePackCommand,
    runRecordNoOpCommand,
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRecordStrictDecompositionDecisionCommand
};
export type {
    BindRulePackToPreflightCommandOptions,
    LoadRulePackCommandOptions,
    RecordNoOpCommandOptions,
    RecordReviewCycleContinuationCommandOptions,
    RecordReviewCycleSplitDecisionCommandOptions,
    RecordStrictDecompositionDecisionCommandOptions
};

export interface EnterTaskModeCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    entryMode?: unknown;
    requestedDepth?: unknown;
    effectiveDepth?: unknown;
    taskSummary?: unknown;
    startBanner?: unknown;
    plannedChangedFiles?: unknown;
    orchestratorWork?: unknown;
    workflowConfigWork?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface HandshakeDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    taskModePath?: string;
    cliPath?: unknown;
    effectiveCwd?: unknown;
    canonicalEntrypoint?: unknown;
    providerBridge?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface ShellSmokePreflightCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    probeTimeoutMs?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface CommandTimeoutDiagnosticsCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    taskModePath?: string;
    effectiveCwd?: unknown;
    commandRecordsPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function buildGateRerunCommand(repoRoot: string, taskId: string, gateName: string, taskModePath = ''): string {
    const parts = [
        `${buildGateCommandPrefix(repoRoot)} gate ${gateName}`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`
    ];
    const trimmedTaskModePath = String(taskModePath || '').trim();
    if (trimmedTaskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(trimmedTaskModePath)}`);
    }
    return parts.join(' ');
}

function resolvePrePreflightSequenceLockPath(repoRoot: string, taskId: string): string {
    return gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`)
    );
}

export function runEnterTaskModeCommand(options: EnterTaskModeCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const artifactPath = resolveTaskModeArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    // A new task-mode entry must never inherit runtime identity from an older task-mode artifact.
    const routingDecision = readRoutingDecision(repoRoot, options.provider, options.routedTo);
    assertTaskModeRuntimeIdentity(repoRoot, taskId, routingDecision, artifactPath);
    const dirtyWorkspaceBaseline = captureDirtyWorkspaceBaseline(repoRoot);
    const workflowConfigFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const {
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles
    } = resolveTaskModeEntryScope(repoRoot, options.plannedChangedFiles);
    const orchestratorWork = parseBooleanOption(options.orchestratorWork, false);
    const workflowConfigWork = parseBooleanOption(options.workflowConfigWork, false);
    const workflowConfigPreTaskBaseline = getWorkflowConfigPreTaskBaselineState(repoRoot, workflowConfigFileHashes);
    const dirtyWorkflowConfigFiles = [...workflowConfigPreTaskBaseline.changed_files].sort();
    const startBanner = resolveTaskModeStartBanner(options.startBanner);

    let planMetadata: TaskModePlanMetadata | null = null;
    const rawPlanPath = String(options.planPath || '').trim();
    if (rawPlanPath) {
        const resolvedPlanPath = gateHelpers.resolvePathInsideRepo(rawPlanPath, repoRoot, { allowMissing: false });
        if (!resolvedPlanPath || !fs.existsSync(resolvedPlanPath) || !fs.statSync(resolvedPlanPath).isFile()) {
            throw new Error(`PlanPath not found or not a file: '${rawPlanPath}'.`);
        }
        const planJson = JSON.parse(fs.readFileSync(resolvedPlanPath, 'utf8'));
        const validated = validateTaskPlan(planJson);
        if (validated.task_id !== taskId) {
            throw new Error(`Plan task_id '${validated.task_id}' does not match --task-id '${taskId}'.`);
        }
        if (!isApprovedPlan(validated)) {
            throw new Error(`Plan status is '${validated.status}'; only approved plans can be attached at task-mode entry.`);
        }
        const digest = computeTaskPlanDigest(validated);
        if (validated.plan_sha256 && validated.plan_sha256 !== digest) {
            throw new Error(`Plan plan_sha256 mismatch: embedded '${validated.plan_sha256}' vs computed '${digest}'.`);
        }
        planMetadata = {
            plan_path: gateHelpers.normalizePath(resolvedPlanPath),
            plan_sha256: digest,
            plan_summary: validated.goal
        };
    }
    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);

    const taskQueueMetadata = readTaskQueueMetadata(repoRoot, taskId);

    assertTaskModeProtectedEntryAllowed({
        repoRoot,
        orchestratorRoot,
        taskId,
        options,
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles,
        dirtyWorkflowConfigFiles,
        orchestratorWork,
        workflowConfigWork,
        taskQueueMetadata
    });

    const rawTaskProfile = taskQueueMetadata?.profile || null;
    let taskProfile: string | null = null;
    let profileSelectionSource: 'task_queue' | 'workspace_active' | null = null;
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let runtimeActiveProfile: string | null = null;
    let runtimeProfileSource: 'built_in' | 'user' | null = null;
    const profilesConfigPath = path.join(orchestratorRoot, 'live', 'config', 'profiles.json');
    try {
        if (fs.existsSync(profilesConfigPath) && fs.statSync(profilesConfigPath).isFile()) {
            const resolvedProfile = resolveTaskProfileSelection(orchestratorRoot, rawTaskProfile);
            taskProfile = resolvedProfile.selection.task_profile;
            profileSelectionSource = resolvedProfile.selection.profile_selection_source;
            activeProfile = resolvedProfile.selection.effective_profile;
            profileSource = resolvedProfile.selection.effective_profile_source;
            runtimeActiveProfile = resolvedProfile.selection.runtime_active_profile;
            runtimeProfileSource = resolvedProfile.selection.runtime_profile_source;
        } else if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            throw new Error(
                `Task profile '${String(rawTaskProfile).trim()}' cannot be resolved because profiles config is missing: ${gateHelpers.normalizePath(profilesConfigPath)}`
            );
        }
    } catch (error: unknown) {
        if (String(rawTaskProfile || '').trim() && String(rawTaskProfile || '').trim().toLowerCase() !== 'default') {
            throw error;
        }
    }

    const reviewerRoutingFields = resolveTaskModeReviewerRoutingFields(routingDecision.provider);
    const taskModeArtifact = buildTaskModeArtifact({
        taskId,
        entryMode: options.entryMode,
        requestedDepth: parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2),
        effectiveDepth: parseTaskModeDepth(options.effectiveDepth, 'EffectiveDepth', parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2)),
        taskSummary: String(options.taskSummary || ''),
        orchestratorWork,
        workflowConfigWork,
        startBanner,
        provider: routingDecision.provider,
        canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
        executionProviderSource: routingDecision.executionProviderSource,
        reviewerCapabilityLevel: reviewerRoutingFields.reviewerCapabilityLevel,
        reviewerExpectedExecutionMode: reviewerRoutingFields.reviewerExpectedExecutionMode,
        reviewerFallbackAllowed: reviewerRoutingFields.reviewerFallbackAllowed,
        reviewerFallbackReasonRequired: reviewerRoutingFields.reviewerFallbackReasonRequired,
        reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
        reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
        reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
        reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
        runtimeIdentityStatus: routingDecision.identityStatus,
        runtimeIdentityViolations: routingDecision.violations,
        routedTo: routingDecision.routedTo,
        actor: String(options.actor || 'orchestrator'),
        plan: planMetadata,
        markdownWorkingPlan,
        plannedChangedFiles,
        taskProfile,
        profileSelectionSource,
        activeProfile,
        profileSource,
        runtimeActiveProfile,
        runtimeProfileSource,
        dirtyWorkspaceBaseline,
        workflowConfigFileHashes,
        workflowConfigCompatibilityBaselineFiles: workflowConfigPreTaskBaseline.compatibility_baseline_files
    });
    writeJsonArtifact(artifactPath, taskModeArtifact);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: taskModeArtifact.timestamp_utc,
        event_type: 'task_mode_entered',
        status: taskModeArtifact.status,
        task_id: taskModeArtifact.task_id,
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        actor: taskModeArtifact.actor,
        plan_guided: !!taskModeArtifact.plan,
        markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
        markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
        task_profile: taskModeArtifact.task_profile,
        profile_selection_source: taskModeArtifact.profile_selection_source,
        active_profile: taskModeArtifact.active_profile,
        profile_source: taskModeArtifact.profile_source,
        runtime_active_profile: taskModeArtifact.runtime_active_profile,
        runtime_profile_source: taskModeArtifact.runtime_profile_source,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    }, parseBooleanOption(options.emitMetrics, true));

    try {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            'TASK_MODE_ENTERED',
            'PASS',
            taskModeArtifact.plan
                ? `Task mode entered via ${taskModeArtifact.entry_mode} (plan-guided).`
                : `Task mode entered via ${taskModeArtifact.entry_mode}.`,
            {
                artifact_path: normalizeOptionalPath(artifactPath),
                entry_mode: taskModeArtifact.entry_mode,
                requested_depth: taskModeArtifact.requested_depth,
                effective_depth: taskModeArtifact.effective_depth,
                task_summary: taskModeArtifact.task_summary,
                orchestrator_work: taskModeArtifact.orchestrator_work,
                workflow_config_work: taskModeArtifact.workflow_config_work,
                start_banner: taskModeArtifact.start_banner,
                provider: taskModeArtifact.provider,
                canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
                execution_provider_source: taskModeArtifact.execution_provider_source,
                reviewer_capability_level: taskModeArtifact.reviewer_capability_level,
                reviewer_expected_execution_mode: taskModeArtifact.reviewer_expected_execution_mode,
                reviewer_fallback_allowed: taskModeArtifact.reviewer_fallback_allowed,
                reviewer_fallback_reason_required: taskModeArtifact.reviewer_fallback_reason_required,
                reviewer_subagent_launch_status: taskModeArtifact.reviewer_subagent_launch_status,
                reviewer_subagent_launch_route: taskModeArtifact.reviewer_subagent_launch_route,
                reviewer_subagent_launch_reason: taskModeArtifact.reviewer_subagent_launch_reason,
                reviewer_subagent_launch_remediation: taskModeArtifact.reviewer_subagent_launch_remediation,
                runtime_identity_status: taskModeArtifact.runtime_identity_status,
                runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
                routed_to: taskModeArtifact.routed_to,
                actor: taskModeArtifact.actor,
                plan_guided: !!taskModeArtifact.plan,
                plan_path: taskModeArtifact.plan?.plan_path ?? null,
                plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
                markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
                markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
                task_profile: taskModeArtifact.task_profile,
                profile_selection_source: taskModeArtifact.profile_selection_source,
                active_profile: taskModeArtifact.active_profile,
                profile_source: taskModeArtifact.profile_source,
                runtime_active_profile: taskModeArtifact.runtime_active_profile,
                runtime_profile_source: taskModeArtifact.runtime_profile_source,
                dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
                dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
                workflow_config_file_hash_count: Object.keys(taskModeArtifact.workflow_config_file_hashes || {}).length,
                workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
            }
        );
    } catch (error: unknown) {
        removeArtifactIfExists(artifactPath);
        throw new Error(
            `enter-task-mode failed because mandatory lifecycle event 'TASK_MODE_ENTERED' could not be appended. ${getErrorMessage(error)}`
        );
    }

    emitPlanCreatedEvent(orchestratorRoot, taskModeArtifact.task_id, {
        artifact_path: normalizeOptionalPath(artifactPath),
        entry_mode: taskModeArtifact.entry_mode,
        requested_depth: taskModeArtifact.requested_depth,
        effective_depth: taskModeArtifact.effective_depth,
        task_summary: taskModeArtifact.task_summary,
        start_banner: taskModeArtifact.start_banner,
        orchestrator_work: taskModeArtifact.orchestrator_work,
        workflow_config_work: taskModeArtifact.workflow_config_work,
        provider: taskModeArtifact.provider,
        canonical_source_of_truth: taskModeArtifact.canonical_source_of_truth,
        execution_provider_source: taskModeArtifact.execution_provider_source,
        runtime_identity_status: taskModeArtifact.runtime_identity_status,
        runtime_identity_violations: taskModeArtifact.runtime_identity_violations,
        routed_to: taskModeArtifact.routed_to,
        plan_guided: !!taskModeArtifact.plan,
        plan_path: taskModeArtifact.plan?.plan_path ?? null,
        plan_sha256: taskModeArtifact.plan?.plan_sha256 ?? null,
        markdown_working_plan_path: taskModeArtifact.markdown_working_plan?.working_plan_path ?? null,
        markdown_working_plan_sha256: taskModeArtifact.markdown_working_plan?.working_plan_sha256 ?? null,
        dirty_workspace_baseline_count: taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0,
        dirty_workspace_baseline_sha256: taskModeArtifact.dirty_workspace_baseline?.changed_files_sha256 || null,
        workflow_config_compatibility_baseline_count: taskModeArtifact.workflow_config_compatibility_baseline_files.length
    });

    const previousStatus = readTaskQueueStatus(repoRoot, taskModeArtifact.task_id);
    if (previousStatus && previousStatus !== 'IN_PROGRESS') {
        emitStatusChangedEvent(orchestratorRoot, taskModeArtifact.task_id, previousStatus, 'IN_PROGRESS');
        syncTaskQueueStatus(repoRoot, taskModeArtifact.task_id, 'IN_PROGRESS');
    }

    if (routingDecision.provider && routingDecision.routedTo) {
        emitProviderRoutingEvent(
            orchestratorRoot,
            taskModeArtifact.task_id,
            routingDecision.provider,
            routingDecision.routedTo,
            'task_mode_entry'
        );
    }

    return {
        outputLines: [
            'TASK_MODE_ENTERED',
            `TaskModeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            `EntryMode: ${taskModeArtifact.entry_mode}`,
            `RequestedDepth: ${taskModeArtifact.requested_depth}`,
            `EffectiveDepth: ${taskModeArtifact.effective_depth}`,
            ...(taskModeArtifact.start_banner ? [`StartBanner: ${taskModeArtifact.start_banner}`] : []),
            `OrchestratorWork: ${taskModeArtifact.orchestrator_work}`,
            `WorkflowConfigWork: ${taskModeArtifact.workflow_config_work}`,
            ...(routingDecision.provider ? [`Provider: ${routingDecision.provider}`] : []),
            ...(routingDecision.canonicalSourceOfTruth ? [`CanonicalSourceOfTruth: ${routingDecision.canonicalSourceOfTruth}`] : []),
            ...(routingDecision.executionProviderSource ? [`ExecutionProviderSource: ${routingDecision.executionProviderSource}`] : []),
            ...(routingDecision.identityStatus ? [`RuntimeIdentityStatus: ${routingDecision.identityStatus}`] : []),
            ...(routingDecision.routedTo ? [`RoutedTo: ${routingDecision.routedTo}`] : []),
            ...(routingDecision.reviewerSubagentLaunchStatus ? [`ReviewerSubagentLaunchStatus: ${routingDecision.reviewerSubagentLaunchStatus}`] : []),
            ...(routingDecision.reviewerSubagentLaunchRoute ? [`ReviewerSubagentLaunchRoute: ${routingDecision.reviewerSubagentLaunchRoute}`] : []),
            ...(taskModeArtifact.plan ? [`PlanGuided: true`, `PlanPath: ${taskModeArtifact.plan.plan_path}`] : [`PlanGuided: false`]),
            ...(taskModeArtifact.markdown_working_plan
                ? [
                    `MarkdownWorkingPlanPath: ${taskModeArtifact.markdown_working_plan.working_plan_path}`,
                    `MarkdownWorkingPlanSha256: ${taskModeArtifact.markdown_working_plan.working_plan_sha256}`
                ]
                : []),
            ...(taskModeArtifact.profile_selection_source
                ? [`TaskProfile: ${taskModeArtifact.task_profile || 'default'} (${taskModeArtifact.profile_selection_source})`]
                : []),
            ...(taskModeArtifact.active_profile ? [`ActiveProfile: ${taskModeArtifact.active_profile} (${taskModeArtifact.profile_source || 'unknown'})`] : []),
            ...(taskModeArtifact.runtime_active_profile
                ? [`RuntimeActiveProfile: ${taskModeArtifact.runtime_active_profile} (${taskModeArtifact.runtime_profile_source || 'unknown'})`]
                : []),
            ...(plannedChangedFiles.length > 0 ? [`PlannedChangedFilesCount: ${plannedChangedFiles.length}`] : []),
            ...(protectedPlannedFiles.length > 0 ? [`PlannedProtectedFilesCount: ${protectedPlannedFiles.length}`] : []),
            `DirtyWorkspaceBaselineCount: ${taskModeArtifact.dirty_workspace_baseline?.changed_files.length || 0}`,
            `WorkflowConfigCompatibilityBaselineCount: ${taskModeArtifact.workflow_config_compatibility_baseline_files.length}`
        ],
        exitCode: 0
    };
}

export function runHandshakeDiagnosticsCommand(options: HandshakeDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.providerBridge,
        taskId,
        options.taskModePath || ''
    );
    const provider = routingDecision.provider;
    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
        const shellSmokeEvidence = getShellSmokeEvidence(repoRoot, taskId, { timelinePath });
        const handshakePrecheckViolations = shellSmokeEvidence.evidence_status === 'PASS'
            ? [
                `Current task cycle in '${gateHelpers.normalizePath(timelinePath)}' already has valid SHELL_SMOKE_PREFLIGHT_RECORDED evidence. ` +
                'Re-running handshake-diagnostics now would invalidate the existing shell-smoke artifact for this cycle. ' +
                `Suggested rerun commands for the next cycle: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
                `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
            ]
            : [];

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveHandshakeArtifactPath(repoRoot, taskId, '');
        const reviewerRoutingFields = resolveTaskModeReviewerRoutingFields(provider);

        const artifact = buildHandshakeDiagnostics({
            taskId,
            repoRoot,
            provider,
            canonicalSourceOfTruth: routingDecision.canonicalSourceOfTruth,
            cliPath: options.cliPath ? String(options.cliPath) : undefined,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            canonicalEntrypoint: options.canonicalEntrypoint ? String(options.canonicalEntrypoint) : undefined,
            providerBridge: options.providerBridge ? String(options.providerBridge) : undefined,
            routedTo: routingDecision.routedTo,
            executionProviderSource: routingDecision.executionProviderSource,
            reviewerCapabilityLevel: reviewerRoutingFields.reviewerCapabilityLevel,
            reviewerExpectedExecutionMode: reviewerRoutingFields.reviewerExpectedExecutionMode,
            reviewerFallbackAllowed: reviewerRoutingFields.reviewerFallbackAllowed,
            reviewerFallbackReasonRequired: reviewerRoutingFields.reviewerFallbackReasonRequired,
            reviewerSubagentLaunchStatus: routingDecision.reviewerSubagentLaunchStatus,
            reviewerSubagentLaunchRoute: routingDecision.reviewerSubagentLaunchRoute,
            reviewerSubagentLaunchReason: routingDecision.reviewerSubagentLaunchReason,
            reviewerSubagentLaunchRemediation: routingDecision.reviewerSubagentLaunchRemediation,
            runtimeIdentityStatus: routingDecision.identityStatus,
            runtimeIdentityViolations: routingDecision.violations,
            precheckViolations: handshakePrecheckViolations
        });

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'handshake_diagnostics_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            cli_path: artifact.cli_path,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitHandshakeDiagnosticsEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.cli_path,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatHandshakeDiagnosticsResult(artifact);
        outputLines.push(`HandshakeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runShellSmokePreflightCommand(options: ShellSmokePreflightCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'shell-smoke-preflight',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const sequenceLockPath = resolvePrePreflightSequenceLockPath(repoRoot, taskId);

    return withFilesystemLock(sequenceLockPath, {}, () => {
        const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));

        const artifactPath = options.artifactPath
            ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
            : resolveShellSmokeArtifactPath(repoRoot, taskId, '');

        const probeTimeoutMs = options.probeTimeoutMs ? parseInt(String(options.probeTimeoutMs), 10) : undefined;
        const handshakeEvidence = getHandshakeEvidence(repoRoot, taskId, {
            taskModePath: options.taskModePath || '',
            timelinePath
        });
        const handshakeViolations = getHandshakeEvidenceViolations(handshakeEvidence).map((violation) => (
            `${violation} Suggested rerun commands: ${buildGateRerunCommand(repoRoot, taskId, 'handshake-diagnostics', String(options.taskModePath || ''))} ; ` +
            `${buildGateRerunCommand(repoRoot, taskId, 'shell-smoke-preflight', String(options.taskModePath || ''))}.`
        ));

        const artifact = buildShellSmokePreflight({
            taskId,
            repoRoot,
            provider,
            effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
            probeTimeoutMs: (probeTimeoutMs && probeTimeoutMs > 0) ? probeTimeoutMs : undefined,
            precheckViolations: handshakeViolations
        });

        writeJsonArtifact(artifactPath, artifact);

        const artifactHash = gateHelpers.fileSha256(artifactPath);

        const metricsPath = options.metricsPath
            ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
            : resolveDefaultMetricsPath(repoRoot);
        appendMetricsIfEnabled(repoRoot, metricsPath, {
            timestamp_utc: artifact.timestamp_utc,
            event_type: 'shell_smoke_preflight_recorded',
            task_id: taskId,
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_hash: artifactHash,
            provider: artifact.provider,
            execution_context: artifact.execution_context,
            outcome: artifact.outcome
        }, parseBooleanOption(options.emitMetrics, true));

        emitShellSmokePreflightEvent(
            orchestratorRoot,
            taskId,
            artifact.provider,
            artifact.execution_context,
            artifact.outcome === 'PASS',
            artifactHash
        );

        const outputLines = formatShellSmokePreflightResult(artifact);
        outputLines.push(`ShellSmokeArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

        return {
            outputLines,
            exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
        };
    }).result;
}

export function runCommandTimeoutDiagnosticsCommand(options: CommandTimeoutDiagnosticsCommandOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const routingDecision = readRoutingDecision(
        repoRoot,
        options.provider,
        options.routedTo,
        taskId,
        options.taskModePath || ''
    );
    assertResolvedRuntimeIdentityForDependentPreflightGate(
        repoRoot,
        taskId,
        'command-timeout-diagnostics',
        routingDecision,
        String(options.taskModePath || '')
    );
    const provider = routingDecision.provider;

    const artifactPath = options.artifactPath
        ? requireResolvedPath(resolvePathForWrite(options.artifactPath, repoRoot), 'ArtifactPath')
        : resolveCommandTimeoutArtifactPath(repoRoot, taskId, '');

    let commands: CommandPhaseRecord[] = [];
    const commandRecordsPath = options.commandRecordsPath ? String(options.commandRecordsPath).trim() : '';
    if (commandRecordsPath) {
        const resolvedRecordsPath = path.resolve(repoRoot, commandRecordsPath);
        if (fs.existsSync(resolvedRecordsPath) && fs.statSync(resolvedRecordsPath).isFile()) {
            try {
                const raw = JSON.parse(fs.readFileSync(resolvedRecordsPath, 'utf8'));
                if (Array.isArray(raw)) {
                    commands = raw as CommandPhaseRecord[];
                } else if (raw && typeof raw === 'object' && Array.isArray((raw as Record<string, unknown>).commands)) {
                    commands = (raw as Record<string, unknown>).commands as CommandPhaseRecord[];
                }
            } catch {
                return {
                    outputLines: [`ERROR: Failed to parse command records from '${commandRecordsPath}'.`],
                    exitCode: 3 // EXIT_USAGE_ERROR
                };
            }
        }
    }

    const artifact = buildCommandTimeoutDiagnostics({
        taskId,
        repoRoot,
        provider,
        effectiveCwd: options.effectiveCwd ? String(options.effectiveCwd) : undefined,
        commands
    });

    writeJsonArtifact(artifactPath, artifact);

    const artifactHash = gateHelpers.fileSha256(artifactPath);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.timestamp_utc,
        event_type: 'command_timeout_diagnostics_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_hash: artifactHash,
        provider: artifact.provider,
        execution_context: artifact.execution_context,
        outcome: artifact.outcome,
        command_count: artifact.commands.length,
        timed_out_count: artifact.commands.filter(c => c.timed_out).length
    }, parseBooleanOption(options.emitMetrics, true));

    emitCommandTimeoutDiagnosticsEvent(
        orchestratorRoot,
        taskId,
        artifact.provider,
        artifact.execution_context,
        artifact.outcome === 'PASS',
        artifact.commands.length,
        artifact.commands.filter(c => c.timed_out).length,
        artifactHash
    );

    const outputLines = formatCommandTimeoutDiagnosticsResult(artifact);
    outputLines.push(`CommandTimeoutArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`);

    return {
        outputLines,
        exitCode: artifact.outcome === 'PASS' ? 0 : EXIT_GATE_FAILURE
    };
}
