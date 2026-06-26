import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    emitPlanCreatedEvent,
    emitProviderRoutingEvent,
    emitStatusChangedEvent
} from '../../../../gate-runtime/lifecycle-events';
import {
    appendMandatoryTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import {
    buildTaskModeArtifact,
    parseTaskModeDepth,
    readOptionalMarkdownWorkingPlan,
    resolveTaskModeArtifactPath,
    type TaskModePlanMetadata
} from '../../../../gates/task-mode/task-mode';
import { captureDirtyWorkspaceBaseline } from '../../../../gates/workspace/dirty-worktree-protection';
import {
    validateTaskPlan,
    computeTaskPlanDigest,
    isApprovedPlan
} from '../../../../schemas/task-plan';
import {
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigPreTaskBaselineState,
    normalizeWorkflowConfigFileHashes
} from '../../../../gates/workflow-config/workflow-config-work';
import {
    readTaskQueueMetadata
} from '../../../../gates/task-audit/task-audit-summary-collectors';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveTaskProfileSelection
} from '../../../../policy/task-profile-selection';
import {
    normalizeOptionalPath,
    removeArtifactIfExists,
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../../gates/gates-artifacts';
import {
    parseBooleanOption
} from '../../gates/gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    getErrorMessage,
    resolveOrchestratorRoot,
    appendMetricsIfEnabled
} from '../compile/gate-flow-helpers';
import { readRoutingDecision } from './routing-decision';
import { readTaskQueueStatus, syncTaskQueueStatus } from '../task/task-queue-sync';
import {
    assertTaskModeProtectedEntryAllowed,
    WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE
} from './task-mode-entry-protection';
import { resolveTaskModeEntryScope } from './task-mode-entry-scope';
import { resolveTaskModeStartBanner } from './task-mode-entry-start-banner';
import {
    assertTaskModeRuntimeIdentity,
    resolveTaskModeReviewerRoutingFields
} from './task-mode-runtime-identity';
import {
    runCommandTimeoutDiagnosticsCommand,
    runHandshakeDiagnosticsCommand,
    runShellSmokePreflightCommand,
    type CommandTimeoutDiagnosticsCommandOptions,
    type HandshakeDiagnosticsCommandOptions,
    type ShellSmokePreflightCommandOptions
} from './task-mode-diagnostics-commands';
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
    runCommandTimeoutDiagnosticsCommand,
    runHandshakeDiagnosticsCommand,
    runRecordReviewCycleContinuationCommand,
    runRecordReviewCycleSplitDecisionCommand,
    runRecordStrictDecompositionDecisionCommand,
    runShellSmokePreflightCommand
};
export type {
    BindRulePackToPreflightCommandOptions,
    CommandTimeoutDiagnosticsCommandOptions,
    HandshakeDiagnosticsCommandOptions,
    LoadRulePackCommandOptions,
    RecordNoOpCommandOptions,
    RecordReviewCycleContinuationCommandOptions,
    RecordReviewCycleSplitDecisionCommandOptions,
    RecordStrictDecompositionDecisionCommandOptions,
    ShellSmokePreflightCommandOptions
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
    allowedDirtyWorkflowConfigFiles?: unknown;
    workflowConfigFileHashesOverride?: Record<string, string | null> | null;
    workflowConfigCompatibilityBaselineFilesOverride?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
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
        workflowConfigPreTaskBaseline,
        orchestratorWork,
        workflowConfigWork,
        allowedDirtyWorkflowConfigFiles: options.allowedDirtyWorkflowConfigFiles,
        taskQueueMetadata
    });
    const workflowConfigFileHashesForArtifact = normalizeWorkflowConfigFileHashes(options.workflowConfigFileHashesOverride)
        || workflowConfigFileHashes;
    const workflowConfigCompatibilityBaselineFiles = options.workflowConfigCompatibilityBaselineFilesOverride === undefined
        ? workflowConfigPreTaskBaseline.compatibility_baseline_files
        : options.workflowConfigCompatibilityBaselineFilesOverride as string[];

    const rawTaskProfile = taskQueueMetadata?.profile || null;
    let taskProfile: string | null = null;
    let profileSelectionSource: 'task_queue' | 'workspace_active' | null = null;
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let runtimeActiveProfile: string | null = null;
    let runtimeProfileSource: 'built_in' | 'user' | null = null;
    let defaultTaskModeDepth = 2;
    let defaultTaskModeDepthResolvedFromProfile = false;
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
            if (
                Number.isInteger(resolvedProfile.effective_policy.depth)
                && resolvedProfile.effective_policy.depth >= 1
                && resolvedProfile.effective_policy.depth <= 3
            ) {
                defaultTaskModeDepth = resolvedProfile.effective_policy.depth;
                defaultTaskModeDepthResolvedFromProfile = true;
            }
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
    const requestedDepthWasExplicit = String(options.requestedDepth || '').trim() !== '';
    const effectiveDepthWasExplicit = String(options.effectiveDepth || '').trim() !== '';
    const requestedDepthSource = requestedDepthWasExplicit
        ? 'explicit'
        : defaultTaskModeDepthResolvedFromProfile ? 'profile_default' : 'legacy_default';
    const taskModeArtifact = buildTaskModeArtifact({
        taskId,
        entryMode: options.entryMode,
        requestedDepth: parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', defaultTaskModeDepth),
        effectiveDepth: parseTaskModeDepth(
            options.effectiveDepth,
            'EffectiveDepth',
            parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', defaultTaskModeDepth)
        ),
        requestedDepthSource,
        effectiveDepthSource: effectiveDepthWasExplicit ? 'explicit' : 'requested_depth',
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
        workflowConfigFileHashes: workflowConfigFileHashesForArtifact,
        workflowConfigCompatibilityBaselineFiles
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
