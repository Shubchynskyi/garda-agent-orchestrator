import * as path from 'node:path';

import {
    normalizeOrchestratorStartBanner,
    ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE
} from '../../core/orchestrator-start-banner';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { joinOrchestratorPath, resolvePathInsideRepo } from '../shared/helpers';
import { normalizeDirtyWorkspaceBaseline } from '../workspace/dirty-worktree-protection';
import { normalizeWorkflowConfigFileHashes } from '../workflow-config/workflow-config-work';
import {
    TASK_MODE_ENTRY_MODES,
    type BuildTaskModeArtifactOptions,
    type TaskModeArtifact,
    type TaskModeEntryMode
} from './task-mode-contracts';

const TASK_MODE_ENTRY_MODE_ALIASES = Object.freeze({
    explicit: 'EXPLICIT_TASK_EXECUTION',
    explicit_task_execution: 'EXPLICIT_TASK_EXECUTION',
    explicitexecute: 'EXPLICIT_TASK_EXECUTION',
    execute: 'EXPLICIT_TASK_EXECUTION',
    task_created_from_request: 'TASK_CREATED_FROM_REQUEST',
    taskcreatedfromrequest: 'TASK_CREATED_FROM_REQUEST',
    transparent_task_creation: 'TASK_CREATED_FROM_REQUEST',
    transparenttaskcreation: 'TASK_CREATED_FROM_REQUEST',
    create: 'TASK_CREATED_FROM_REQUEST',
    created: 'TASK_CREATED_FROM_REQUEST'
} satisfies Record<string, TaskModeEntryMode>);

function normalizeOptionalString(value: unknown): string | null {
    return String(value || '').trim() || null;
}

export function normalizeTaskModePathList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(value.map((entry) => String(entry || '').trim().replace(/\\/g, '/')).filter(Boolean))].sort();
}

export function normalizeTaskModeEntryMode(value: unknown): TaskModeEntryMode {
    const raw = String(value || '').trim();
    if (!raw) {
        return 'EXPLICIT_TASK_EXECUTION';
    }
    const normalized = raw.toLowerCase().replace(/[\s-]+/g, '_');
    const aliasMatch = TASK_MODE_ENTRY_MODE_ALIASES[normalized as keyof typeof TASK_MODE_ENTRY_MODE_ALIASES];
    if (aliasMatch) {
        return aliasMatch;
    }

    const canonicalMatch = TASK_MODE_ENTRY_MODES.find(function (mode) {
        return mode.toLowerCase() === normalized;
    });
    if (canonicalMatch) {
        return canonicalMatch;
    }

    throw new Error(
        `EntryMode must be one of: ${TASK_MODE_ENTRY_MODES.join(', ')}. ` +
        "Supported aliases: explicit, explicit_task_execution, task_created_from_request, transparent_task_creation."
    );
}

export function parseTaskModeDepth(value: unknown, label: string, fallback: number): number {
    if (value == null || String(value).trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(parsed) || parsed < 1 || parsed > 3) {
        throw new Error(`${label} must be an integer between 1 and 3. Got '${value}'.`);
    }
    return parsed;
}

export function resolveTaskModeArtifactPath(repoRoot: string, taskId: string, artifactPath: string): string {
    const explicitPath = String(artifactPath || '').trim();
    if (explicitPath) {
        const resolvedPath = resolvePathInsideRepo(explicitPath, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            throw new Error('TaskModeArtifactPath must not be empty.');
        }
        return resolvedPath;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-task-mode.json`));
}

export function buildTaskModeArtifact(options: BuildTaskModeArtifactOptions): TaskModeArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const entryMode = normalizeTaskModeEntryMode(options.entryMode);
    const requestedDepth = parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2);
    const effectiveDepth = parseTaskModeDepth(options.effectiveDepth, 'EffectiveDepth', requestedDepth);
    const requestedDepthSource = options.requestedDepthSource === 'explicit'
        || options.requestedDepthSource === 'profile_default'
        || options.requestedDepthSource === 'legacy_default'
        ? options.requestedDepthSource
        : undefined;
    const effectiveDepthSource = options.effectiveDepthSource === 'explicit'
        || options.effectiveDepthSource === 'requested_depth'
        ? options.effectiveDepthSource
        : undefined;
    const taskSummary = String(options.taskSummary || '').trim();
    if (taskSummary.length < 8) {
        throw new Error('TaskSummary is required (>= 8 characters).');
    }
    const requestedStartBanner = String(options.startBanner || '').trim();
    const normalizedStartBanner = requestedStartBanner
        ? normalizeOrchestratorStartBanner(requestedStartBanner)
        : null;
    if (requestedStartBanner && !normalizedStartBanner) {
        throw new Error(
            `StartBanner must be one of the repo-owned banners (${ORCHESTRATOR_START_BANNER_EXAMPLES_INLINE}). ` +
            `Got '${requestedStartBanner}'.`
        );
    }

    const actor = String(options.actor || 'orchestrator').trim() || 'orchestrator';
    const plan = options.plan && options.plan.plan_path && options.plan.plan_sha256 && options.plan.plan_summary
        ? {
            plan_path: options.plan.plan_path,
            plan_sha256: options.plan.plan_sha256,
            plan_summary: options.plan.plan_summary
        }
        : null;
    const markdownWorkingPlan = options.markdownWorkingPlan
        && options.markdownWorkingPlan.format === 'markdown'
        && options.markdownWorkingPlan.working_plan_path
        && options.markdownWorkingPlan.working_plan_sha256
        ? {
            format: 'markdown' as const,
            working_plan_path: options.markdownWorkingPlan.working_plan_path,
            working_plan_sha256: options.markdownWorkingPlan.working_plan_sha256,
            byte_count: Number.isFinite(options.markdownWorkingPlan.byte_count)
                ? Math.max(0, Math.trunc(options.markdownWorkingPlan.byte_count))
                : 0
        }
        : null;
    const plannedChangedFiles = normalizeTaskModePathList(options.plannedChangedFiles);
    const dirtyWorkspaceBaseline = normalizeDirtyWorkspaceBaseline(options.dirtyWorkspaceBaseline || null);
    return {
        timestamp_utc: new Date().toISOString(),
        event_source: 'enter-task-mode',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        entry_mode: entryMode,
        requested_depth: requestedDepth,
        effective_depth: effectiveDepth,
        ...(requestedDepthSource ? { requested_depth_source: requestedDepthSource } : {}),
        ...(effectiveDepthSource ? { effective_depth_source: effectiveDepthSource } : {}),
        task_summary: taskSummary,
        orchestrator_work: !!options.orchestratorWork,
        workflow_config_work: !!options.workflowConfigWork,
        start_banner: normalizedStartBanner,
        provider: normalizeOptionalString(options.provider),
        canonical_source_of_truth: normalizeOptionalString(options.canonicalSourceOfTruth),
        execution_provider_source: normalizeOptionalString(options.executionProviderSource),
        reviewer_capability_level: normalizeOptionalString(options.reviewerCapabilityLevel),
        reviewer_expected_execution_mode: normalizeOptionalString(options.reviewerExpectedExecutionMode),
        reviewer_fallback_allowed: typeof options.reviewerFallbackAllowed === 'boolean' ? options.reviewerFallbackAllowed : null,
        reviewer_fallback_reason_required: typeof options.reviewerFallbackReasonRequired === 'boolean'
            ? options.reviewerFallbackReasonRequired
            : null,
        reviewer_subagent_launch_status: normalizeOptionalString(options.reviewerSubagentLaunchStatus),
        reviewer_subagent_launch_route: normalizeOptionalString(options.reviewerSubagentLaunchRoute),
        reviewer_subagent_launch_reason: normalizeOptionalString(options.reviewerSubagentLaunchReason),
        reviewer_subagent_launch_remediation: normalizeOptionalString(options.reviewerSubagentLaunchRemediation),
        runtime_identity_status: normalizeOptionalString(options.runtimeIdentityStatus),
        runtime_identity_violations: Array.isArray(options.runtimeIdentityViolations)
            ? options.runtimeIdentityViolations.map((entry) => String(entry || '').trim()).filter(Boolean)
            : [],
        routed_to: normalizeOptionalString(options.routedTo),
        actor,
        plan,
        markdown_working_plan: markdownWorkingPlan,
        planned_changed_files: plannedChangedFiles,
        task_profile: normalizeOptionalString(options.taskProfile),
        profile_selection_source: options.profileSelectionSource || null,
        active_profile: normalizeOptionalString(options.activeProfile),
        profile_source: options.profileSource || null,
        runtime_active_profile: normalizeOptionalString(options.runtimeActiveProfile),
        runtime_profile_source: options.runtimeProfileSource || null,
        dirty_workspace_baseline: dirtyWorkspaceBaseline,
        workflow_config_file_hashes: normalizeWorkflowConfigFileHashes(options.workflowConfigFileHashes || null),
        workflow_config_compatibility_baseline_files: normalizeTaskModePathList(options.workflowConfigCompatibilityBaselineFiles)
    };
}
