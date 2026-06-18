import type { DirtyWorkspaceBaseline } from '../workspace/dirty-worktree-protection';

export const TASK_MODE_ENTRY_MODES = Object.freeze([
    'EXPLICIT_TASK_EXECUTION',
    'TASK_CREATED_FROM_REQUEST'
] as const);

export const TASK_MODE_ENTRY_EXECUTION_PROVIDER_SOURCES = Object.freeze([
    'provider_bridge',
    'provider_entrypoint',
    'explicit_provider'
] as const);

export const TASK_MODE_RUNTIME_IDENTITY_STATUSES = Object.freeze([
    'resolved',
    'legacy_fallback',
    'missing',
    'contradictory'
] as const);

export type TaskModeEntryMode = (typeof TASK_MODE_ENTRY_MODES)[number];

export interface TaskModePlanMetadata {
    plan_path: string;
    plan_sha256: string;
    plan_summary: string;
}

export interface TaskModeMarkdownWorkingPlanMetadata {
    format: 'markdown';
    working_plan_path: string;
    working_plan_sha256: string;
    byte_count: number;
}

export interface TaskModeArtifact {
    timestamp_utc: string;
    event_source: 'enter-task-mode';
    task_id: string;
    status: 'PASSED';
    outcome: 'PASS';
    entry_mode: TaskModeEntryMode;
    requested_depth: number;
    effective_depth: number;
    requested_depth_source?: 'explicit' | 'profile_default' | 'legacy_default';
    effective_depth_source?: 'explicit' | 'requested_depth';
    task_summary: string;
    orchestrator_work: boolean;
    workflow_config_work: boolean;
    start_banner: string | null;
    provider: string | null;
    canonical_source_of_truth: string | null;
    execution_provider_source: string | null;
    reviewer_capability_level: string | null;
    reviewer_expected_execution_mode: string | null;
    reviewer_fallback_allowed: boolean | null;
    reviewer_fallback_reason_required: boolean | null;
    reviewer_subagent_launch_status: string | null;
    reviewer_subagent_launch_route: string | null;
    reviewer_subagent_launch_reason: string | null;
    reviewer_subagent_launch_remediation: string | null;
    runtime_identity_status: string | null;
    runtime_identity_violations: string[];
    routed_to: string | null;
    actor: string;
    plan: TaskModePlanMetadata | null;
    markdown_working_plan: TaskModeMarkdownWorkingPlanMetadata | null;
    planned_changed_files: string[];
    task_profile: string | null;
    profile_selection_source: 'task_queue' | 'workspace_active' | null;
    active_profile: string | null;
    profile_source: 'built_in' | 'user' | null;
    runtime_active_profile: string | null;
    runtime_profile_source: 'built_in' | 'user' | null;
    dirty_workspace_baseline: DirtyWorkspaceBaseline | null;
    workflow_config_file_hashes: Record<string, string | null> | null;
    workflow_config_compatibility_baseline_files: string[];
}

export interface BuildTaskModeArtifactOptions {
    taskId: string;
    entryMode: unknown;
    requestedDepth: unknown;
    effectiveDepth: unknown;
    requestedDepthSource?: 'explicit' | 'profile_default' | 'legacy_default' | null;
    effectiveDepthSource?: 'explicit' | 'requested_depth' | null;
    taskSummary: string;
    orchestratorWork?: boolean;
    workflowConfigWork?: boolean;
    startBanner?: string | null;
    provider?: string | null;
    canonicalSourceOfTruth?: string | null;
    executionProviderSource?: string | null;
    reviewerCapabilityLevel?: string | null;
    reviewerExpectedExecutionMode?: string | null;
    reviewerFallbackAllowed?: boolean | null;
    reviewerFallbackReasonRequired?: boolean | null;
    reviewerSubagentLaunchStatus?: string | null;
    reviewerSubagentLaunchRoute?: string | null;
    reviewerSubagentLaunchReason?: string | null;
    reviewerSubagentLaunchRemediation?: string | null;
    runtimeIdentityStatus?: string | null;
    runtimeIdentityViolations?: string[] | null;
    routedTo?: string | null;
    actor?: string;
    plan?: TaskModePlanMetadata | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
    plannedChangedFiles?: string[] | null;
    taskProfile?: string | null;
    profileSelectionSource?: 'task_queue' | 'workspace_active' | null;
    activeProfile?: string | null;
    profileSource?: 'built_in' | 'user' | null;
    runtimeActiveProfile?: string | null;
    runtimeProfileSource?: 'built_in' | 'user' | null;
    dirtyWorkspaceBaseline?: DirtyWorkspaceBaseline | null;
    workflowConfigFileHashes?: Record<string, string | null> | null;
    workflowConfigCompatibilityBaselineFiles?: string[] | null;
}

export interface TaskModeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    timeline_artifact_path: string | null;
    timeline_declares_runtime_identity_metadata: boolean;
    timeline_declares_start_banner: boolean;
    timeline_start_banner: string | null;
    evidence_hash: string | null;
    declares_runtime_identity_metadata: boolean;
    identity_backfilled_from_legacy: boolean;
    evidence_status: string;
    evidence_outcome: string | null;
    evidence_task_id: string | null;
    evidence_source: string | null;
    entry_mode: string | null;
    requested_depth: number | null;
    effective_depth: number | null;
    requested_depth_source?: 'explicit' | 'profile_default' | 'legacy_default' | null;
    effective_depth_source?: 'explicit' | 'requested_depth' | null;
    task_summary: string | null;
    orchestrator_work: boolean | null;
    workflow_config_work: boolean | null;
    start_banner: string | null;
    provider: string | null;
    canonical_source_of_truth: string | null;
    execution_provider_source: string | null;
    reviewer_capability_level: string | null;
    reviewer_expected_execution_mode: string | null;
    reviewer_fallback_allowed: boolean | null;
    reviewer_fallback_reason_required: boolean | null;
    reviewer_subagent_launch_status: string | null;
    reviewer_subagent_launch_route: string | null;
    reviewer_subagent_launch_reason: string | null;
    reviewer_subagent_launch_remediation: string | null;
    runtime_identity_status: string | null;
    runtime_identity_violations: string[];
    routed_to: string | null;
    plan: TaskModePlanMetadata | null;
    markdown_working_plan: TaskModeMarkdownWorkingPlanMetadata | null;
    planned_changed_files: string[];
    task_profile: string | null;
    profile_selection_source: string | null;
    active_profile: string | null;
    profile_source: string | null;
    runtime_active_profile: string | null;
    runtime_profile_source: string | null;
    dirty_workspace_baseline: DirtyWorkspaceBaseline | null;
    workflow_config_file_hashes: Record<string, string | null> | null;
    workflow_config_compatibility_baseline_files: string[];
}
