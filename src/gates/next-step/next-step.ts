import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode,
    type ResolvedReviewExecutionPolicyConfig
} from '../../core/review-execution-policy';
import {
    DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER,
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../gate-runtime/review/reviewer-identity-contract';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../../gate-runtime/reviewer-session-contract';
import {
    buildReviewVerdictTokenSet,
    formatAcceptedReviewVerdictTokens
} from '../../gate-runtime/review-context';
import {
    buildTaskAuditSummary,
    type TaskAuditSummaryResult
} from '../task-audit/task-audit-summary';
import {
    type GateOutcome
} from '../task-audit/task-audit-summary-collectors';
import {
    readOrderedTaskEvents,
    type TaskAuditEvent
} from '../task-audit/task-audit-summary-lifecycle';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuitePerformanceGuidance,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import {
    readInterruptedFullSuiteValidationRunMarker,
    resolveFullSuiteValidationRunMarkerPath
} from '../full-suite/full-suite-validation-run-marker';
import type {
    ReviewTrustSummary
} from '../review/review-trust-summary';
import {
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    testPathPrefix
} from '../shared/helpers';
import {
    collectKnownNonBlockingSignals,
    type KnownNonBlockingSignal
} from '../shared/known-nonblocking-signals';
import {
    resolveBundleNameForTarget
} from '../../core/constants';
import {
    buildGardaSelfGuardPolicyChangeCommand,
    buildDefaultWorkflowConfig,
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle,
    type FullSuiteValidationPlacement
} from '../../core/workflow-config';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';
import {
    getProjectMemoryImpactLifecycleEvidence
} from '../project-memory-impact/project-memory-impact';
import {
    getNoOpEvidence
} from '../task-mode/no-op';
import {
    readOptionalMarkdownWorkingPlan,
    type TaskModeMarkdownWorkingPlanMetadata
} from '../task-mode/task-mode';
import {
    buildCurrentCycleOptionalSkillActivationIndex,
    readOptionalSkillSelectionArtifact,
    readOptionalSkillSelectionTimelineEvidence
} from '../../runtime/optional-skill-selection';
import {
    readStartupCycleReadiness
} from './next-step-startup-readiness';
import {
    resolveNextStepStartupRoute
} from './next-step-startup-routing';
import {
    readCompileReadiness,
    readPreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    resolveProviderFromEnvironment as resolveProviderFromRegistryEnvironment
} from '../../core/provider-registry';
import {
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardEvaluation
} from '../../core/scope-budget-guard';
import {
    assessReviewCycleContinuationEvidence
} from '../review-cycle/review-cycle-continuation';
import { resolveTaskProfileSelection } from '../../policy/task-profile-selection';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    buildForcedSourceCheckoutRuntimeBuildCommand,
    detectSourceCheckoutRuntimeStaleness,
    type SourceCheckoutRuntimeStalenessResult
} from '../../validators';
import {
    buildDefaultReviewScratchCommandPath
} from '../review/review-scratch-paths';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import {
    parseTaskQueueEntriesFromContent,
    type TaskQueueEntry
} from './next-step-task-queue';
import {
    buildNextStepCoreArtifactSpecs,
    fullSuiteArtifactMatchesCurrentCycle,
    hasAcceptedDocsOnlyFullSuiteSkipArtifact
} from './next-step-readiness-readers';
import {
    getScopedDiffMetadataReadiness,
    readReviewArtifactState,
    readReviewTrust,
    scopedDiffExpectedForReview,
    type ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    applyFullSuiteReadinessToReviewLaunchPlan,
    buildNextStepReviewLaunchPlan,
    describeBlockedReviewDependencies,
    getDownstreamReviewTypesFor,
    toNextStepBlockedReviewLanes
} from './next-step-review-launch-planner';
import {
    resolveReviewLaunchableLanePreparationRoute
} from './next-step-review-cycle-routing';
import {
    buildProviderNativeReviewerLaunchTargetSummary,
    buildReviewerReadinessChainSummary,
    getCurrentReviewerLaunchArtifactEvidenceForInvocation,
    timelineHasDelegatedReviewInvocationForCurrentContext,
    timelineHasDelegatedReviewRoutingAfterCompile
} from './next-step-reviewer-launch-evidence';
import {
    resolveDownstreamDependencyRebindRoute,
    resolveFailedReviewRemediationRoute,
    resolveReviewGateStaleContextPrecheckRecoveryRoute,
    resolveReviewGateStaleUpstreamRecoveryRoute,
    resolveStrictSequentialUpstreamReuseRoute,
    type ReviewReuseCandidateHint
} from './next-step-review-reuse-routing';
import {
    buildReviewGateChainStatusSummary,
    findDownstreamReviewNeedingDependencyRebind,
    findReviewGateStaleContextPrecheckRecovery,
    findReviewGateStaleUpstreamRecovery,
    findStrictSequentialUpstreamNeedingCurrentCycleReuse,
    getHiddenReviewTimingTrustRemediation,
    reviewStateHasCurrentRecordedEvidence,
    reviewStateHasSatisfiedEvidence,
    timelineHasReviewContextPreparedAfterCompile,
    timelineHasReviewReuseRecordedAfterCompile
} from './next-step-review-evidence';
import {
    resolveCompletedCloseoutRouteFromState,
    resolvePostReviewCloseoutRouteFromState
} from './next-step-closeout-routing';
import {
    resolveNextStepCompileGateRoute,
    resolveNextStepPreGuardRoute
} from './next-step-pre-review-routing';
import {
    readPostDoneWorkspaceDriftDecision,
    readReadyFinalReportSummary,
    type NextStepFinalReportSummary
} from './next-step-closeout-status-readers';
import {
    isSuccessfulSplitRequiredStatusSync,
    materializeSplitRequiredLatch,
    sanitizeScopeBudgetGuardSummary,
    type SplitRequiredLatchResult
} from './next-step-split-required-latch';
import {
    resolveDelegatedReviewDecisionRoute,
    resolveFullSuiteDecisionRoute,
    resolveTaskQueueTerminalDecisionRoute
} from './next-step-decision-route-groups';
import {
    buildReviewCycleContinuationCommand,
    buildReviewCycleOperatorBlock,
    buildReviewCycleSplitDecisionCommand,
    readReviewCycleGuardEvaluation,
    type NextStepReviewCycleBlock,
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleGuardEvaluation
} from './next-step-review-cycle-guard';
import {
    buildCommand,
    buildBundleRelativePath,
    buildNavigatorCommand,
    buildProjectMemoryImpactCommand,
    formatNextStepInlineList,
    formatNextStepInlineValue,
    quoteCommandValue,
    toRepoDisplayPath
} from './next-step-command-formatters';
export { formatNextStepText } from './next-step-command-formatters';
import {
    buildCompleteReviewerLaunchCommand,
    buildPrepareReviewerLaunchCommand,
    buildRecordReviewerDelegationStartedCommand,
    buildRecordReviewResultCommand,
    buildRecordReviewerInvocationCommand,
    buildRestartReviewCycleCommand,
    buildReviewRoutingCommand,
    buildScopedDiffCommand,
    buildTaskModePathCommandParts
} from './next-step-review-command-builders';
import {
    buildDocImpactCommand,
    buildDocImpactCompatibilityHint,
    buildProjectMemoryNextStepSummary,
    buildStaleCompletionFailureDocCloseoutAllowance,
    readPreflightCycleReadiness,
    type NextStepProjectMemorySummary
} from './next-step-doc-closeout-readiness';
import {
    readCurrentGitWorkspaceSnapshot
} from '../scope/docs-only-delta-readiness';
import {
    buildClassifyChangeCommand,
    buildCompileGateCommand,
    buildCompletionGateCommand,
    buildEnterTaskModeCommand,
    buildOrchestratorWorkRestartCommand,
    buildPostPreflightRulePackBindCommand,
    buildPostPreflightRulePackCommandForFiles,
    buildRequiredReviewsCheckCommand,
    buildReviewContextCommand,
    getEffectiveDepthForPostPreflightRules,
    getPostPreflightRuleFileNames,
    getPreflightRefreshChangedFiles,
    getStringField,
    getTaskModeDirtyWorkspaceBaselineChangedFiles,
    getTaskModeDirtyWorkspaceBaselineFileHashes,
    getTaskModePlannedChangedFiles
} from './next-step-lifecycle-command-builders';
import {
    isLatestCompletionCurrent,
    readCoherentCycleReadiness,
    readFailedGateRecovery,
    readPostPreflightRulePackReadiness
} from './next-step-preflight-recovery';
import {
    buildStrictDecompositionDecisionRequirement,
    resolveStrictDecompositionContinuationRoute
} from './next-step-strict-decomposition-routing';
import {
    createNextStepResolutionContext,
    type NextStepOptions,
    type NextStepResolutionContext
} from './next-step-resolution-context';
import {
    renderNextStepOutput
} from './next-step-output-rendering';

const REVIEW_PREPARATION_ORDER = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
]);

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE' | 'DECOMPOSED' | 'SPLIT_REQUIRED';

export interface NextStepCommand {
    label: string;
    command: string;
}

export interface NextStepArtifactState {
    key: string;
    path: string;
    exists: boolean;
}

export interface NextStepFullSuiteSummary {
    enabled: boolean;
    command: string;
    placement: FullSuiteValidationPlacement;
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
    recommended_timeout_seconds?: number | null;
    timeout_forecast_note?: string | null;
    performance_guidance_note?: string | null;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: ReviewExecutionPolicySource;
    launchable_review_types: string[];
    blocked_review_lanes: NextStepBlockedReviewLane[];
    failed_review_type: string | null;
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    ordinary_doc_review_skips: { path: string; pattern: string }[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepBlockedReviewLane {
    review_type: string;
    blocked_by: string[];
    reason: string;
}

export type { NextStepFinalReportSummary } from './next-step-closeout-status-readers';
export type { NextStepProjectMemorySummary } from './next-step-doc-closeout-readiness';

export interface NextStepInvalidationImpactSummary {
    stale_artifact_classes: string[];
    affected_review_lanes: string[];
    minimal_recovery_chain: string[];
    reuse_candidates: string[];
}

export interface NextStepProfileSummary {
    task_selected_profile: string | null;
    profile_selection_source: string | null;
    effective_profile: string | null;
    effective_profile_source: string | null;
    runtime_active_profile: string | null;
    runtime_active_profile_source: string | null;
    requested_depth: number | null;
    effective_depth: number | null;
    depth_escalation_reason: string | null;
    total_forecast_tokens: number | null;
    effective_forecast_tokens: number | null;
    token_economy_active_for_depth: boolean | null;
}

export interface NextStepOptionalSkillSelectionSummary {
    artifact_path: string | null;
    artifact_present: boolean;
    timeline_invalid_json: boolean;
    policy_mode: string | null;
    decision: string | null;
    selected_skill_ids: string[];
    activated_skill_ids: string[];
    pending_activation_skill_ids: string[];
    recommended_missing_pack_ids: string[];
    as_is_reason: string | null;
    visible_summary_line: string | null;
    activation_commands: string[];
    skill_catalog_path: string | null;
    task_start_instruction: string;
}

export type {
    NextStepReviewCycleAutoSplitPrompt,
    NextStepReviewCycleBlock,
    NextStepReviewCycleLatestFailedReview
} from './next-step-review-cycle-guard';

export interface NextStepResult {
    schema_version: 1;
    task_id: string;
    generated_utc: string;
    navigator_command: string;
    status: NextStepStatus;
    next_gate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missing_artifacts: NextStepArtifactState[];
    present_artifacts: NextStepArtifactState[];
    full_suite_validation: NextStepFullSuiteSummary;
    project_memory: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    task_queue_status_contract: TaskQueueStatusContract;
    audit_status: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdown_working_plan: TaskModeMarkdownWorkingPlanMetadata | null;
    optional_skill_selection: NextStepOptionalSkillSelectionSummary | null;
    warnings: string[];
    invalidation_impact: NextStepInvalidationImpactSummary | null;
    known_non_blocking_signals: KnownNonBlockingSignal[];
    review_cycle_block: NextStepReviewCycleBlock | null;
    final_report: NextStepFinalReportSummary | null;
}


interface ArtifactSpec {
    key: string;
    path: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function fullSuiteFailedTimeoutRetryAvailable(
    artifact: Record<string, unknown> | null,
    forecast: { recommended_timeout_seconds?: unknown; configured_timeout_seconds?: unknown } | null
): boolean {
    if (!isPlainRecord(artifact) || artifact.status !== 'FAILED' || artifact.timed_out !== true || !forecast) {
        return false;
    }

    const recommendedTimeoutSeconds = Number(forecast.recommended_timeout_seconds);
    if (!Number.isFinite(recommendedTimeoutSeconds) || recommendedTimeoutSeconds <= 0) {
        return false;
    }

    const artifactForecast = isPlainRecord(artifact.timeout_forecast) ? artifact.timeout_forecast : null;
    const priorConfiguredTimeoutSeconds = Number(artifactForecast?.configured_timeout_seconds);
    if (Number.isFinite(priorConfiguredTimeoutSeconds) && priorConfiguredTimeoutSeconds > 0) {
        return recommendedTimeoutSeconds > priorConfiguredTimeoutSeconds;
    }

    const durationMs = Number(artifact.duration_ms);
    return Number.isFinite(durationMs) && durationMs > 0 && recommendedTimeoutSeconds * 1000 > durationMs;
}

interface FullSuiteManualRetryEvidence {
    available: boolean;
    reason: string | null;
}

interface FullSuiteTargetedDiagnosticEvidence {
    available: boolean;
    reason: string | null;
}

function readFullSuiteManualRetryEvidence(options: {
    repoRoot: string;
    taskId: string;
    fullSuiteArtifact: Record<string, unknown> | null;
    fullSuiteArtifactPath: string;
    preflightSha256: string | null;
    currentFailedFullSuite: boolean;
}): FullSuiteManualRetryEvidence {
    if (!options.currentFailedFullSuite || !isPlainRecord(options.fullSuiteArtifact)) {
        return { available: false, reason: null };
    }
    const evidencePath = joinOrchestratorPath(
        options.repoRoot,
        path.join('runtime', 'manual-validation', options.taskId, 'full-suite-retry-evidence.json')
    );
    if (!fileExists(evidencePath)) {
        return { available: false, reason: null };
    }
    let evidence: Record<string, unknown>;
    try {
        const parsed = JSON.parse(fs.readFileSync(evidencePath, 'utf8')) as unknown;
        if (!isPlainRecord(parsed)) {
            return { available: false, reason: null };
        }
        evidence = parsed;
    } catch {
        return { available: false, reason: null };
    }
    if (String(evidence.task_id || '').trim() !== options.taskId) {
        return { available: false, reason: null };
    }
    const allowedReasonKinds = new Set(['transient', 'out_of_scope', 'harness', 'focused_pass_after_failure']);
    const reasonKind = String(evidence.reason_kind || '').trim();
    if (!allowedReasonKinds.has(reasonKind)) {
        return { available: false, reason: null };
    }
    const expectedFailureArtifactSha256 = String(fileSha256(options.fullSuiteArtifactPath) || '').trim().toLowerCase();
    if (!expectedFailureArtifactSha256) {
        return { available: false, reason: null };
    }
    if (String(evidence.full_suite_failure_artifact_sha256 || '').trim().toLowerCase() !== expectedFailureArtifactSha256) {
        return { available: false, reason: null };
    }
    const expectedPreflightSha256 = String(options.preflightSha256 || '').trim().toLowerCase();
    if (!expectedPreflightSha256 || String(evidence.preflight_sha256 || '').trim().toLowerCase() !== expectedPreflightSha256) {
        return { available: false, reason: null };
    }
    const focusedValidation = isPlainRecord(evidence.focused_validation)
        ? evidence.focused_validation
        : null;
    const focusedCommand = String(focusedValidation?.command || '').trim();
    if (!focusedCommand) {
        return { available: false, reason: null };
    }
    const focusedStatus = String(focusedValidation?.status || '').trim().toUpperCase();
    const focusedExitCode = focusedValidation?.exit_code;
    const focusedExitCodePresent = Object.prototype.hasOwnProperty.call(focusedValidation || {}, 'exit_code');
    const focusedExitCodePassed = focusedExitCodePresent
        && typeof focusedExitCode === 'number'
        && Number.isInteger(focusedExitCode)
        && focusedExitCode === 0;
    const focusedStatusFailed = focusedStatus === 'FAILED' || focusedStatus === 'FAIL' || focusedStatus === 'ERROR';
    const focusedStatusPassed = focusedStatus === 'PASSED' || focusedStatus === 'PASS';
    const focusedExitCodeContradictsPass = focusedExitCodePresent && !focusedExitCodePassed;
    const focusedPassed = !focusedStatusFailed && !focusedExitCodeContradictsPass && (focusedExitCodePassed || focusedStatusPassed);
    if (!focusedPassed) {
        return { available: false, reason: null };
    }
    const reason = `Evidence: ${normalizePath(evidencePath)}; reason_kind=${reasonKind}${focusedCommand ? `; focused_command=${focusedCommand}` : ''}.`;
    return { available: true, reason };
}

function readFullSuiteTargetedDiagnosticEvidence(options: {
    eventsRoot: string;
    taskId: string;
    currentFailedFullSuite: boolean;
}): FullSuiteTargetedDiagnosticEvidence {
    if (!options.currentFailedFullSuite) {
        return { available: false, reason: null };
    }
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const events = readOrderedTaskEvents(timelinePath).events;
    const failedIndex = findLatestCurrentTaskEventIndex(events, options.taskId, 'FULL_SUITE_VALIDATION_FAILED');
    if (failedIndex < 0) {
        return { available: false, reason: null };
    }
    for (let index = events.length - 1; index > failedIndex; index -= 1) {
        const event = events[index];
        if (String(event.task_id || '').trim() !== options.taskId) {
            continue;
        }
        if (String(event.event_type || '') !== 'INTERMEDIATE_COMMAND_RUN') {
            continue;
        }
        if (!isPassedIntermediateCommandEvent(event)) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const artifactPath = String(details.artifact_path || '').trim();
        const commandSource = String(details.command_source || '').trim();
        const command = String(details.command || '').trim();
        const evidenceParts = [
            artifactPath ? `artifact=${normalizePath(artifactPath)}` : null,
            commandSource ? `command_source=${commandSource}` : null,
            command ? `command=${command}` : null
        ].filter((part): part is string => !!part);
        const reason = evidenceParts.length > 0
            ? `Evidence: ${evidenceParts.join('; ')}.`
            : null;
        return { available: true, reason };
    }
    return { available: false, reason: null };
}

function findLatestCurrentTaskEventIndex(
    events: TaskAuditEvent[],
    taskId: string,
    eventType: string
): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (
            String(event.task_id || '').trim() === taskId
            && String(event.event_type || '') === eventType
        ) {
            return index;
        }
    }
    return -1;
}

function isPassedIntermediateCommandEvent(event: TaskAuditEvent): boolean {
    const details = isPlainRecord(event.details) ? event.details : {};
    const commandSource = String(details.command_source || '').trim();
    if (!['node-test', 'targeted-test', 'typecheck', 'validation'].includes(commandSource)) {
        return false;
    }
    const outcome = String(event.outcome || '').trim().toUpperCase();
    const status = String(details.status || '').trim().toUpperCase();
    const exitCode = details.exit_code;
    if (typeof exitCode === 'number' && Number.isInteger(exitCode)) {
        return exitCode === 0;
    }
    return outcome === 'PASS' || outcome === 'PASSED' || status === 'PASS' || status === 'PASSED';
}

function resolveBundleRootForNextStep(repoRoot: string): string {
    const sourceCheckoutBundleRoot = path.resolve(repoRoot);
    return fs.existsSync(path.join(sourceCheckoutBundleRoot, 'bin', 'garda.js'))
        ? sourceCheckoutBundleRoot
        : path.join(sourceCheckoutBundleRoot, resolveBundleNameForTarget(repoRoot));
}

function artifactState(repoRoot: string, specs: ArtifactSpec[]): {
    present: NextStepArtifactState[];
    missing: NextStepArtifactState[];
} {
    const states = specs.map((spec) => ({
        key: spec.key,
        path: toRepoDisplayPath(repoRoot, spec.path),
        exists: fileExists(spec.path)
    }));
    return {
        present: states.filter((state) => state.exists),
        missing: states.filter((state) => !state.exists)
    };
}

function getGateStatus(summary: TaskAuditSummaryResult, gateName: string): GateOutcome['status'] | null {
    return summary.gates.find((gate) => gate.gate === gateName)?.status || null;
}

function isGatePassed(summary: TaskAuditSummaryResult, gateName: string): boolean {
    return getGateStatus(summary, gateName) === 'PASS';
}

function getRequiredReviewTypes(requiredReviews: Record<string, boolean>): string[] {
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType]);
}

function hasZeroDiffNoReviewableScopeSuppression(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): boolean {
    return !!preflight
        && requiredReviewTypes.length === 0
        && isFullSuiteNotRequiredForZeroDiffNoReviewableScope(preflight);
}

function preflightRequiresAuditedNoOp(preflight: Record<string, unknown> | null): boolean {
    if (!preflight || !isPlainRecord(preflight.zero_diff_guard)) {
        return false;
    }
    const zeroDiffGuard = preflight.zero_diff_guard;
    return zeroDiffGuard.zero_diff_detected === true
        && zeroDiffGuard.completion_requires_audited_no_op === true;
}

type ReviewExecutionPolicySource = 'preflight' | 'workflow_config' | 'workflow_config_fallback';

function hasPreflightReviewPolicyMode(preflight: Record<string, unknown> | null): boolean {
    return !!preflight
        && isPlainRecord(preflight.review_execution_policy)
        && Object.prototype.hasOwnProperty.call(preflight.review_execution_policy, 'mode');
}

function resolveReviewPolicy(
    preflight: Record<string, unknown> | null,
    workflowPolicy: ResolvedReviewExecutionPolicyConfig
): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: ReviewExecutionPolicySource;
} {
    if (hasPreflightReviewPolicyMode(preflight)) {
        return {
            mode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
            source: 'preflight'
        };
    }
    return {
        mode: workflowPolicy.mode,
        source: workflowPolicy.configured ? 'workflow_config' : 'workflow_config_fallback'
    };
}

function readTaskQueueEntries(repoRoot: string): Map<string, TaskQueueEntry> {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return new Map<string, TaskQueueEntry>();
    }
    return parseTaskQueueEntriesFromContent(fs.readFileSync(taskPath, 'utf8'));
}

function resolveTaskQueueCaseMismatch(taskEntries: Map<string, TaskQueueEntry>, taskId: string): string | null {
    const normalizedTaskId = taskId.toLowerCase();
    for (const entryTaskId of taskEntries.keys()) {
        if (entryTaskId !== taskId && entryTaskId.toLowerCase() === normalizedTaskId) {
            return entryTaskId;
        }
    }
    return null;
}

function parseOptionalNumberField(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
}

function readWorkflowConfigRecordForNextStep(repoRoot: string): Record<string, unknown> | null {
    const workflowConfigPath = resolveWorkflowConfigPath(repoRoot);
    if (!fileExists(workflowConfigPath)) {
        return null;
    }

    let workflowConfig: unknown;
    try {
        workflowConfig = JSON.parse(fs.readFileSync(workflowConfigPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }
    if (!isPlainRecord(workflowConfig)) {
        throw new Error(
            `Workflow config at '${toRepoDisplayPath(repoRoot, workflowConfigPath)}' must be a JSON object.`
        );
    }
    return workflowConfig;
}

function resolveReviewExecutionPolicyForNextStep(
    workflowConfig: Record<string, unknown> | null
): ResolvedReviewExecutionPolicyConfig {
    return resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        workflowConfig,
        LEGACY_REVIEW_EXECUTION_POLICY_MODE
    );
}

function readScopeBudgetGuardEvaluation(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    profileSummary: NextStepProfileSummary | null,
    requiredReviewTypes: string[]
): ScopeBudgetGuardEvaluation | null {
    if (!preflight) {
        return null;
    }
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const budgetForecast = isPlainRecord(preflight.budget_forecast) ? preflight.budget_forecast : {};
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawScopeBudgetGuard: unknown = defaultWorkflowConfig.scope_budget_guard;
    const workflowConfig = readWorkflowConfigRecordForNextStep(repoRoot);
    if (workflowConfig?.scope_budget_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: workflowConfig.scope_budget_guard
        });
        rawScopeBudgetGuard = isPlainRecord(validatedWorkflowConfig.scope_budget_guard)
            ? validatedWorkflowConfig.scope_budget_guard
            : defaultWorkflowConfig.scope_budget_guard;
    }

    const changedFilesCount =
        parseOptionalNumberField(metrics.changed_files_count)
        ?? (Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0);
    const changedLinesTotal =
        parseOptionalNumberField(metrics.changed_lines_total)
        ?? parseOptionalNumberField(budgetForecast.changed_lines_total)
        ?? 0;
    const totalEstimatedReviewTokens =
        parseOptionalNumberField(budgetForecast.total_estimated_review_tokens)
        ?? 0;
    return evaluateScopeBudgetGuard(
        normalizeScopeBudgetGuardConfig(rawScopeBudgetGuard),
        {
            profileName: profileSummary?.effective_profile || profileSummary?.task_selected_profile || null,
            changedFilesCount,
            changedLinesTotal,
            requiredReviewCount: requiredReviewTypes.length,
            totalEstimatedReviewTokens
        }
    );
}

function buildNextStepProfileSummary(
    repoRoot: string,
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): NextStepProfileSummary | null {
    const rawTaskProfile = typeof taskMode?.task_profile === 'string' && taskMode.task_profile.trim()
        ? taskMode.task_profile.trim()
        : typeof taskEntry?.profile === 'string' && taskEntry.profile.trim()
            ? taskEntry.profile.trim()
            : null;

    let resolvedSelection: ReturnType<typeof resolveTaskProfileSelection>['selection'] | null;
    try {
        resolvedSelection = resolveTaskProfileSelection(
            path.join(repoRoot, 'garda-agent-orchestrator'),
            rawTaskProfile,
            typeof preflight?.scope_category === 'string' ? preflight.scope_category : null
        ).selection;
    } catch {
        resolvedSelection = null;
    }

    const budgetForecast = preflight?.budget_forecast && typeof preflight.budget_forecast === 'object'
        ? preflight.budget_forecast as Record<string, unknown>
        : null;
    const depthEscalation = preflight?.depth_escalation && typeof preflight.depth_escalation === 'object'
        ? preflight.depth_escalation as Record<string, unknown>
        : null;

    const summary: NextStepProfileSummary = {
        task_selected_profile: rawTaskProfile || resolvedSelection?.task_profile || null,
        profile_selection_source:
            (typeof taskMode?.profile_selection_source === 'string' && taskMode.profile_selection_source.trim())
            || resolvedSelection?.profile_selection_source
            || null,
        effective_profile:
            (typeof taskMode?.active_profile === 'string' && taskMode.active_profile.trim())
            || resolvedSelection?.effective_profile
            || null,
        effective_profile_source:
            (typeof taskMode?.profile_source === 'string' && taskMode.profile_source.trim())
            || resolvedSelection?.effective_profile_source
            || null,
        runtime_active_profile:
            (typeof taskMode?.runtime_active_profile === 'string' && taskMode.runtime_active_profile.trim())
            || resolvedSelection?.runtime_active_profile
            || null,
        runtime_active_profile_source:
            (typeof taskMode?.runtime_profile_source === 'string' && taskMode.runtime_profile_source.trim())
            || resolvedSelection?.runtime_profile_source
            || null,
        requested_depth:
            parseOptionalNumberField(budgetForecast?.requested_depth)
            ?? parseOptionalNumberField(taskMode?.requested_depth),
        effective_depth:
            parseOptionalNumberField(budgetForecast?.effective_depth)
            ?? parseOptionalNumberField(preflight?.risk_aware_depth && typeof preflight.risk_aware_depth === 'object'
                ? (preflight.risk_aware_depth as Record<string, unknown>).effective_depth
                : null)
            ?? parseOptionalNumberField(taskMode?.effective_depth),
        depth_escalation_reason:
            typeof depthEscalation?.escalation_reason === 'string' && depthEscalation.escalation_reason.trim()
                ? depthEscalation.escalation_reason.trim()
                : null,
        total_forecast_tokens: parseOptionalNumberField(budgetForecast?.total_forecast_tokens),
        effective_forecast_tokens: parseOptionalNumberField(budgetForecast?.effective_forecast_tokens),
        token_economy_active_for_depth:
            typeof budgetForecast?.token_economy_active_for_depth === 'boolean'
                ? budgetForecast.token_economy_active_for_depth
                : null
    };

    if (
        summary.task_selected_profile == null
        && summary.effective_profile == null
        && summary.runtime_active_profile == null
        && summary.requested_depth == null
        && summary.effective_depth == null
        && summary.total_forecast_tokens == null
    ) {
        return null;
    }

    return summary;
}

function resolveProviderFromEnvironment(): string | null {
    return resolveProviderFromRegistryEnvironment(process.env);
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

function getPreflightTriggers(preflight: Record<string, unknown> | null): Record<string, unknown> {
    return isPlainRecord(preflight?.triggers) ? preflight.triggers : {};
}

function preflightTouchesProtectedControlPlane(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    if (triggers.protected_control_plane_changed === true) {
        return true;
    }
    return Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0;
}

function readCurrentProtectedScopeBeforePreflight(repoRoot: string): {
    changedFiles: string[];
    protectedFiles: string[];
    workflowConfigFiles: string[];
} | null {
    const currentSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, true);
    if (!currentSnapshot) {
        return null;
    }
    const changedFiles = [...new Set(
        currentSnapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
    )].sort();
    if (changedFiles.length === 0) {
        return null;
    }
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const protectedFiles = changedFiles.filter((entry) => testPathPrefix(entry, protectedRoots));
    if (protectedFiles.length === 0) {
        return null;
    }
    return {
        changedFiles,
        protectedFiles,
        workflowConfigFiles: protectedFiles.filter((entry) => isWorkflowConfigControlPlanePath(entry))
    };
}

function getOrdinaryDocReviewSkips(preflight: Record<string, unknown> | null): { path: string; pattern: string }[] {
    const triggers = getPreflightTriggers(preflight);
    const matches = Array.isArray(triggers.ordinary_doc_path_matches)
        ? triggers.ordinary_doc_path_matches
        : [];
    return matches
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            const raw = entry as Record<string, unknown>;
            const matchedPath = normalizePath(raw.path);
            const pattern = normalizePath(raw.pattern);
            return matchedPath && pattern ? { path: matchedPath, pattern } : null;
        })
        .filter((entry): entry is { path: string; pattern: string } => entry !== null)
        .sort((left, right) => left.path.localeCompare(right.path) || left.pattern.localeCompare(right.pattern));
}

function readStringArrayFromObjects(value: unknown, fieldName: string): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => {
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
                return null;
            }
            return String((entry as Record<string, unknown>)[fieldName] || '').trim() || null;
        })
        .filter((entry): entry is string => entry !== null)
        .sort();
}

function buildOptionalSkillTaskStartInstruction(input: {
    policyMode: string | null;
    selectedSkillIds: string[];
    pendingActivationSkillIds: string[];
    recommendedMissingPackIds: string[];
    asIsReason: string | null;
    skillCatalogPath: string | null;
    activationCommands: string[];
}): string {
    if (input.policyMode === 'off') {
        return 'Optional skill selection is disabled by policy; proceed without specialized optional skill activation.';
    }
    if (input.selectedSkillIds.length > 0) {
        const skillList = input.selectedSkillIds.join(', ');
        if (input.pendingActivationSkillIds.length > 0 && input.activationCommands.length > 0) {
            if (input.policyMode === 'required' || input.policyMode === 'strict') {
                return `Selected optional skill(s): ${skillList}. Run the activation command(s) before implementation so the timeline records the required chosen role/skill.`;
            }
            return `Selected advisory optional skill(s): ${skillList}. If you use the selected skill, run the activation command(s) before implementation so the timeline records that choice; otherwise continue with the normal navigator command.`;
        }
        if (input.pendingActivationSkillIds.length === 0) {
            return `Selected optional skill(s): ${skillList}. Current-cycle activation evidence is present; continue with the normal navigator command.`;
        }
        return `Selected optional skill(s): ${skillList}. Rerun the navigator until classify-change materializes current-cycle selection evidence, then activate the selected skill before implementation.`;
    }
    if (input.recommendedMissingPackIds.length > 0) {
        return `No installed optional skill is selected; missing pack recommendation(s): ${input.recommendedMissingPackIds.join(', ')}. Inspect the compact skill catalog before implementation and either install/select a pack through the supported flow or proceed with the recorded no-specialized-skill decision.`;
    }
    const reason = input.asIsReason || 'generic_context_sufficient';
    const catalogHint = input.skillCatalogPath ? ` Compact catalog: ${input.skillCatalogPath}.` : '';
    return `No specialized optional skill selected; current-cycle evidence records as_is (${reason}). Inspect the compact skill catalog if that looks wrong; otherwise this is the explicit no-specialized-skill-needed decision.${catalogHint}`;
}

function buildOptionalSkillSelectionSummary(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflight: Record<string, unknown> | null
): NextStepOptionalSkillSelectionSummary | null {
    const preflightOptional = preflight?.optional_skill_selection;
    if (!preflightOptional || typeof preflightOptional !== 'object' || Array.isArray(preflightOptional)) {
        return null;
    }
    const preflightOptionalRecord = preflightOptional as Record<string, unknown>;
    const artifactPath = normalizePath(String(preflightOptionalRecord.artifact_path || '').trim());
    const resolvedArtifactPath = artifactPath
        ? resolvePathInsideRepo(artifactPath, repoRoot, { allowMissing: true })
        : null;
    const artifact = readOptionalSkillSelectionArtifact(
        path.join(repoRoot, resolveBundleNameForTarget(repoRoot)),
        taskId
    );
    const artifactPayload = artifact?.payload || null;
    const selectedSkillIds = readStringArrayFromObjects(artifactPayload?.selected_installed_skills, 'id');
    const recommendedMissingPackIds = readStringArrayFromObjects(artifactPayload?.recommended_missing_packs, 'id');
    const policyMode = String(preflightOptionalRecord.policy_mode || artifactPayload?.policy_mode || '').trim() || null;
    const decision = String(preflightOptionalRecord.decision || artifactPayload?.decision || '').trim() || null;
    const asIsReason = String(artifactPayload?.as_is_reason || '').trim() || null;
    const visibleSummaryLine = String(preflightOptionalRecord.visible_summary_line || artifactPayload?.visible_summary_line || '').trim() || null;
    const skillCatalogPath = String(artifactPayload?.headlines_path || '').trim() || null;
    const timelineEvidence = artifactPayload
        ? readOptionalSkillSelectionTimelineEvidence(
            path.join(repoRoot, resolveBundleNameForTarget(repoRoot)),
            taskId
        )
        : null;
    const timelineInvalidJson = timelineEvidence?.invalidJson === true;
    const activationIndex = artifactPayload && timelineEvidence && !timelineEvidence.invalidJson
        ? buildCurrentCycleOptionalSkillActivationIndex(artifactPayload, timelineEvidence)
        : new Map<string, number>();
    const activatedSkillIds = selectedSkillIds.filter((skillId) => activationIndex.has(skillId));
    const pendingActivationSkillIds = decision === 'selected_installed_skills'
        ? selectedSkillIds.filter((skillId) => !activationIndex.has(skillId))
        : [];
    const activationCommands = pendingActivationSkillIds.map((skillId) => (
        `${cliPrefix} gate activate-optional-skill --task-id ${quoteCommandValue(taskId)} --skill-id ${quoteCommandValue(skillId)} --repo-root "."`
    ));
    return {
        artifact_path: artifactPath || null,
        artifact_present: resolvedArtifactPath ? fs.existsSync(resolvedArtifactPath) : false,
        timeline_invalid_json: timelineInvalidJson,
        policy_mode: policyMode,
        decision,
        selected_skill_ids: selectedSkillIds,
        activated_skill_ids: activatedSkillIds,
        pending_activation_skill_ids: pendingActivationSkillIds,
        recommended_missing_pack_ids: recommendedMissingPackIds,
        as_is_reason: asIsReason,
        visible_summary_line: visibleSummaryLine,
        activation_commands: decision === 'selected_installed_skills' ? activationCommands : [],
        skill_catalog_path: skillCatalogPath,
        task_start_instruction: buildOptionalSkillTaskStartInstruction({
            policyMode,
            selectedSkillIds,
            pendingActivationSkillIds,
            recommendedMissingPackIds,
            asIsReason,
            skillCatalogPath,
            activationCommands: decision === 'selected_installed_skills' ? activationCommands : []
        })
    };
}

function getPendingOptionalSkillActivationCommand(
    optionalSkillSelection: NextStepOptionalSkillSelectionSummary | null
): { skillId: string; command: string } | null {
    if (!optionalSkillSelection || optionalSkillSelection.decision !== 'selected_installed_skills') {
        return null;
    }
    if (optionalSkillSelection.timeline_invalid_json) {
        return null;
    }
    if (optionalSkillSelection.policy_mode !== 'required' && optionalSkillSelection.policy_mode !== 'strict') {
        return null;
    }
    const pendingSkillId = optionalSkillSelection.pending_activation_skill_ids[0];
    if (!pendingSkillId) {
        return null;
    }
    const command = optionalSkillSelection.activation_commands[0] || null;
    return command ? { skillId: pendingSkillId, command } : null;
}

function buildResult(params: {
    taskId: string;
    navigatorCommand: string;
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
    optionalSkillSelection?: NextStepOptionalSkillSelectionSummary | null;
    warnings?: string[];
    reviewCycleBlock?: NextStepReviewCycleBlock | null;
    finalReport?: NextStepFinalReportSummary | null;
    sourceRuntimeStaleness?: SourceCheckoutRuntimeStalenessResult | null;
}): NextStepResult {
    const intendedGateCommand = params.commands.find((command) => /\bgate\s+[a-z0-9-]+/iu.test(command.command));
    if (
        params.sourceRuntimeStaleness?.isStale
        && params.nextGate !== 'source-runtime-remediation'
        && intendedGateCommand
    ) {
        return buildSourceRuntimeRemediationResult({
            ...params,
            intendedGate: params.nextGate || intendedGateCommand.label,
            intendedCommand: intendedGateCommand.command,
            staleness: params.sourceRuntimeStaleness
        });
    }
    const invalidationImpact = buildInvalidationImpactSummary(params);
    const knownNonBlockingSignals = collectKnownNonBlockingSignals({
        projectMemory: params.projectMemory || null,
        nextGate: params.nextGate,
        reason: params.reason,
        commands: params.commands
    });
    return renderNextStepOutput({
        ...params,
        invalidationImpact,
        knownNonBlockingSignals,
        taskQueueStatusContract: buildTaskQueueStatusContract(params.taskId)
    });
}

function buildFinalCloseoutMissingArtifacts(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    paths: {
        finalCloseoutJsonPath: string;
        finalCloseoutMarkdownPath: string;
    }
): NextStepArtifactState[] {
    const finalUserReportPath = path.join(reviewsRoot, `${taskId}-final-user-report.md`);
    return [
        { key: 'final-closeout-json', path: paths.finalCloseoutJsonPath },
        { key: 'final-closeout-markdown', path: paths.finalCloseoutMarkdownPath },
        { key: 'final-user-report', path: finalUserReportPath }
    ].map((artifact) => ({
        key: artifact.key,
        path: toRepoDisplayPath(repoRoot, artifact.path),
        exists: fs.existsSync(artifact.path)
    }));
}

function filterNotRequiredCoreMissingArtifacts(
    missingArtifacts: NextStepArtifactState[],
    options: {
        fullSuiteRequired: boolean;
        completionGatePassed: boolean;
    }
): NextStepArtifactState[] {
    return missingArtifacts.filter((artifact) => {
        if (!options.fullSuiteRequired && artifact.key === 'full-suite-validation') {
            return false;
        }
        if (options.completionGatePassed && artifact.key === 'completion-gate') {
            return false;
        }
        return true;
    });
}

function buildInvalidationImpactSummary(params: {
    status: NextStepStatus;
    nextGate: string | null;
    title: string;
    reason: string;
    commands: NextStepCommand[];
    review: NextStepReviewSummary;
}): NextStepInvalidationImpactSummary | null {
    if (params.status === 'DONE' || params.status === 'READY' || !params.nextGate) {
        return null;
    }
    const text = `${params.title} ${params.reason}`;
    if (!hasInvalidationSignal(text, params.nextGate)) {
        return null;
    }
    const affectedReviewLanes = getAffectedReviewLanes(text, params.review);
    return {
        stale_artifact_classes: getStaleArtifactClasses(text, params.nextGate),
        affected_review_lanes: affectedReviewLanes,
        minimal_recovery_chain: buildMinimalRecoveryChain(params.nextGate, params.commands, text),
        reuse_candidates: buildReuseCandidates(text, affectedReviewLanes)
    };
}

function hasInvalidationSignal(text: string, nextGate: string): boolean {
    return /\b(?:stale|mismatch|mismatched|does not match|invalidates?|outdated|scope drift|current preflight|latest compile|newer compile|domain-limited remediation|lane-domain current|rebind|review reuse|materialize reuse)\b/iu.test(text)
        || ['classify-change', 'bind-rule-pack-to-preflight'].includes(nextGate);
}

function getStaleArtifactClasses(text: string, nextGate: string): string[] {
    const classes: string[] = [];
    const add = (value: string) => {
        if (!classes.includes(value)) {
            classes.push(value);
        }
    };
    if (/\bpreflight\b|\bscope drift\b|\bchanged fingerprints?\b/iu.test(text) || nextGate === 'classify-change') add('preflight/scope');
    if (/\brule[- ]?pack\b|\bPOST_PREFLIGHT\b/iu.test(text) || nextGate === 'bind-rule-pack-to-preflight') add('rule-pack binding');
    if (/\bcompile\b/iu.test(text) || nextGate === 'compile-gate') add('compile evidence');
    if (/\bfull-suite\b/iu.test(text) || nextGate === 'full-suite-validation') add('full-suite evidence');
    if (/\bscoped diff\b/iu.test(text) || nextGate === 'build-scoped-diff') add('scoped diff metadata');
    if (/\breview[- ]?context\b/iu.test(text) || nextGate === 'build-review-context') add('review context');
    if (/\brouting\b|\bREVIEWER_DELEGATION_ROUTED\b/iu.test(text) || nextGate === 'record-review-routing') add('reviewer routing');
    if (/\blaunch\b|\binvocation\b/iu.test(text) || ['prepare-reviewer-launch', 'complete-reviewer-launch', 'record-review-invocation'].includes(nextGate)) add('reviewer launch/invocation');
    if (/\breceipt\b|\breview artifact\b|\breview output\b|\breviewer_provenance\b/iu.test(text) || nextGate === 'record-review-result') add('review artifact/receipt');
    if (/\brequired-reviews-check\b|\breview gate\b/iu.test(text) || nextGate === 'required-reviews-check') add('review gate evidence');
    return classes.length > 0 ? classes : [nextGate];
}

function getAffectedReviewLanes(text: string, review: NextStepReviewSummary): string[] {
    const lanes = new Set<string>();
    for (const reviewType of REVIEW_PREPARATION_ORDER) {
        const quoted = new RegExp(`['"]${reviewType}['"]`, 'iu');
        const labelled = new RegExp(`\\b${reviewType}\\b(?=\\s+(?:review|lane|context|routing|receipt|PASS|evidence))`, 'iu');
        if (quoted.test(text) || labelled.test(text)) {
            lanes.add(reviewType);
        }
    }
    if (review.next_review_type) {
        lanes.add(review.next_review_type);
    }
    for (const lane of review.blocked_review_lanes) {
        lanes.add(lane.review_type);
        for (const blocker of lane.blocked_by) {
            if (REVIEW_PREPARATION_ORDER.includes(blocker)) {
                lanes.add(blocker);
            }
        }
    }
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => lanes.has(reviewType));
}

function buildMinimalRecoveryChain(nextGate: string, commands: NextStepCommand[], text: string): string[] {
    const chain = [nextGate];
    if (nextGate === 'classify-change') {
        chain.push('rerun navigator for POST_PREFLIGHT, compile, and review refresh decisions');
    } else if (nextGate === 'build-review-context' && /\breview reuse\b|\bmaterialize reuse\b|\brebind\b|\blane-domain current\b/iu.test(text)) {
        chain.push('materialize current-cycle review reuse');
        chain.push('rerun navigator before downstream review/check gates');
    } else if (nextGate.startsWith('record-review') || nextGate.includes('reviewer')) {
        chain.push('record current reviewer evidence');
        chain.push('rerun navigator before review gate');
    } else if (commands.length > 0) {
        chain.push('rerun navigator after the printed command');
    }
    return chain;
}

function buildReuseCandidates(text: string, affectedReviewLanes: string[]): string[] {
    if (/\breuse eligibility validation\b.*\bbefore treating\b|\bbefore treating .*PASS evidence as reusable\b/iu.test(text)) {
        return ['none indicated'];
    }
    if (!/\breview reuse\b|\bmaterialize reuse\b|\blane-domain current\b|\bdomain-limited remediation\b|\bexisting .*PASS evidence\b/iu.test(text)) {
        return ['none indicated'];
    }
    if (affectedReviewLanes.length === 0) {
        return ['unchanged upstream PASS evidence, if named by the current gate reason'];
    }
    return affectedReviewLanes.map((reviewType) => `${reviewType} (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)`);
}

export function buildReviewReuseCandidatesForDiagnostics(text: string, affectedReviewLanes: string[]): string[] {
    return buildReuseCandidates(text, affectedReviewLanes);
}

function getCurrentWorkspaceRefreshChangedFiles(
    repoRoot: string,
    preflight: Record<string, unknown> | null,
    fallbackChangedFiles: string[] | undefined
): string[] | undefined {
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    if (detectionSource !== 'explicit_changed_files') {
        return fallbackChangedFiles;
    }
    const includeUntracked = typeof preflight?.include_untracked === 'boolean'
        ? preflight.include_untracked
        : true;
    const currentSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
    if (!currentSnapshot) {
        return fallbackChangedFiles;
    }
    return [...new Set(
        currentSnapshot.changed_files.map((entry: string) => normalizePath(entry)).filter(Boolean)
    )].sort();
}

function getPreflightRefreshCommandChangedFiles(params: {
    repoRoot: string;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    fallbackChangedFiles: string[] | undefined;
}): string[] | undefined {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(params.taskMode);
    if (plannedChangedFiles.length > 0) {
        const taskScopedChangedFiles = params.taskMode?.workflow_config_work === true
            ? getPreflightRefreshChangedFiles(params.taskMode, params.preflight)
            : plannedChangedFiles;
        const currentChangedFiles = getCurrentWorkspaceRefreshChangedFiles(
            params.repoRoot,
            params.preflight,
            undefined
        );
        if (!currentChangedFiles) {
            return taskScopedChangedFiles;
        }
        if (params.taskMode?.workflow_config_work === true) {
            return currentChangedFiles.length > 0
                ? currentChangedFiles
                : taskScopedChangedFiles;
        }
        const plannedSet = new Set(plannedChangedFiles);
        const dirtyBaselineSet = new Set([
            ...getTaskModeDirtyWorkspaceBaselineChangedFiles(params.taskMode),
            ...getPreflightTriggerChangedFiles(params.preflight, 'dirty_workspace_baseline_changed_files')
        ]);
        const dirtyBaselineFileHashes = getTaskModeDirtyWorkspaceBaselineFileHashes(params.taskMode);
        const unchangedDirtyBaselineSet = new Set(
            [...dirtyBaselineSet].filter((changedFile) => (
                dirtyBaselineFileMatchesCurrent(params.repoRoot, changedFile, dirtyBaselineFileHashes)
            ))
        );
        const currentTaskScopeChangedFiles = currentChangedFiles.filter((changedFile) => (
            plannedSet.has(changedFile)
                || !unchangedDirtyBaselineSet.has(changedFile)
        ));
        const currentChangedSet = new Set(currentChangedFiles);
        const taskScopedRefreshChangedFiles = taskScopedChangedFiles.filter((changedFile) => (
            !dirtyBaselineSet.has(changedFile) || currentChangedSet.has(changedFile)
        ));
        return currentTaskScopeChangedFiles.length > 0
            ? [...new Set([...taskScopedRefreshChangedFiles, ...currentTaskScopeChangedFiles])].sort()
            : taskScopedChangedFiles;
    }
    return getCurrentWorkspaceRefreshChangedFiles(
        params.repoRoot,
        params.preflight,
        params.fallbackChangedFiles
    );
}

function dirtyBaselineFileMatchesCurrent(
    repoRoot: string,
    changedFile: string,
    dirtyBaselineFileHashes: Record<string, string>
): boolean {
    const expectedHash = dirtyBaselineFileHashes[normalizePath(changedFile)];
    if (!expectedHash) {
        return false;
    }
    const currentHash = fileSha256(path.join(repoRoot, changedFile));
    return !!currentHash && currentHash.trim().toLowerCase() === expectedHash;
}

function getPreflightTriggerChangedFiles(
    preflight: Record<string, unknown> | null,
    fieldName: string
): string[] {
    const triggers = preflight?.triggers;
    if (!triggers || typeof triggers !== 'object' || Array.isArray(triggers)) {
        return [];
    }
    const value = (triggers as Record<string, unknown>)[fieldName];
    return Array.isArray(value)
        ? value.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function getBuildReviewContextReuseCandidateHint(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): ReviewReuseCandidateHint {
    return state.reusedExistingReview && timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state)
        ? 'current-context-candidate'
        : 'validation-required';
}

function buildSourceRuntimeRemediationResult(params: {
    taskId: string;
    navigatorCommand: string;
    intendedGate: string;
    intendedCommand: string;
    staleness: SourceCheckoutRuntimeStalenessResult;
    missingArtifacts: NextStepArtifactState[];
    presentArtifacts: NextStepArtifactState[];
    fullSuite: NextStepFullSuiteSummary;
    projectMemory?: NextStepProjectMemorySummary | null;
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    markdownWorkingPlan?: TaskModeMarkdownWorkingPlanMetadata | null;
}): NextStepResult {
    const violationSummary = params.staleness.violations.length > 0
        ? params.staleness.violations.join('; ')
        : 'source checkout generated runtime may be stale';
    const remediation = params.staleness.remediation
        || `Run "${buildForcedSourceCheckoutRuntimeBuildCommand()}" before continuing gate execution from this source checkout. ` +
            'This disables build-script and publish-runtime reuse so stale generated runtime evidence is refreshed.';
    return buildResult({
        taskId: params.taskId,
        navigatorCommand: params.navigatorCommand,
        status: 'BLOCKED',
        nextGate: 'source-runtime-remediation',
        title: 'Rebuild source-checkout runtime before continuing.',
        reason:
            `Source checkout generated runtime is stale: ${violationSummary}. ` +
            `Remediation blocks intended gate '${params.intendedGate}'. ` +
            'Use the forced rebuild command below so build-script and publish-runtime reuse cannot leave stale runtime evidence in place. ' +
            `After the rebuild, rerun the navigator to continue with '${params.intendedGate}': ${params.intendedCommand}.`,
        commands: [
            buildCommand('Rebuild source-checkout runtime', remediation.replace(/^Run\s+"([^"]+)".*$/u, '$1'))
        ],
        missingArtifacts: params.missingArtifacts,
        presentArtifacts: params.presentArtifacts,
        fullSuite: params.fullSuite,
        projectMemory: params.projectMemory || null,
        review: params.review,
        auditStatus: params.auditStatus,
        profile: params.profile,
        markdownWorkingPlan: params.markdownWorkingPlan || null
    });
}

function buildTaskEntryRulePackCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/15-project-memory.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/80-task-workflow.md')}"`,
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/90-skill-catalog.md')}"`,
        '--repo-root "."'
    ].join(' ');
}

function resolveRulePackStage(rulePack: Record<string, unknown> | null): string | null {
    const latestStage = typeof rulePack?.latest_stage === 'string'
        ? rulePack.latest_stage.trim()
        : '';
    if (latestStage) {
        return latestStage;
    }
    return typeof rulePack?.stage === 'string' ? rulePack.stage.trim() || null : null;
}

export function resolveNextStepDecisionRoute(context: NextStepResolutionContext): NextStepResult {
    const {
        repoRoot,
        taskId,
        reviewsRoot,
        eventsRoot,
        cliPrefix,
        taskModePath,
        preflightCommandPath,
        readinessArtifacts,
        preflightPath,
        rulePackPath,
        preflight,
        rulePack,
        taskMode,
        preflightSha256
    } = context;
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const taskEntries = readTaskQueueEntries(repoRoot);
    const taskEntry = taskEntries.get(taskId) || null;
    const taskIdCaseMismatch = taskEntry ? null : resolveTaskQueueCaseMismatch(taskEntries, taskId);
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const profileSummary = buildNextStepProfileSummary(repoRoot, taskEntry, taskMode, preflight);
    const optionalSkillSelectionSummary = buildOptionalSkillSelectionSummary(repoRoot, cliPrefix, taskId, preflight);
    let workflowReviewPolicy: ResolvedReviewExecutionPolicyConfig = {
        mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
        configured: false
    };
    try {
        workflowReviewPolicy = resolveReviewExecutionPolicyForNextStep(
            readWorkflowConfigRecordForNextStep(repoRoot)
        );
    } catch (error: unknown) {
        const fallbackFullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
        const coreArtifacts = artifactState(repoRoot, buildNextStepCoreArtifactSpecs(readinessArtifacts));
        return buildResult({
            taskId,
            navigatorCommand,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ],
            missingArtifacts: coreArtifacts.missing,
            presentArtifacts: coreArtifacts.present,
            fullSuite: {
                enabled: fallbackFullSuiteConfig.enabled,
                command: fallbackFullSuiteConfig.command,
                placement: fallbackFullSuiteConfig.placement,
                config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
                config_source: 'effective_workflow_config',
                note: 'Full-suite validation is unavailable until workflow config validation passes.'
            },
            review: {
                required_reviews: [],
                review_execution_policy_mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
                review_execution_policy_source: 'workflow_config_fallback',
                launchable_review_types: [],
                blocked_review_lanes: [],
                failed_review_type: null,
                next_review_type: null,
                blocked_review_dependencies: [],
                ordinary_doc_review_skips: [],
                trust: null,
                trust_note: 'Review trust is unavailable until workflow config validation passes.'
            },
            auditStatus: 'INCOMPLETE',
            profile: profileSummary,
            markdownWorkingPlan,
            optionalSkillSelection: optionalSkillSelectionSummary,
            sourceRuntimeStaleness: detectSourceCheckoutRuntimeStaleness(repoRoot)
        });
    }
    const summary = buildTaskAuditSummary({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
    const fullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
    const fullSuiteTimeoutForecast = fullSuiteConfig.enabled
        ? buildFullSuiteTimeoutForecast(repoRoot, fullSuiteConfig)
        : null;
    const fullSuiteTimeoutForecastLine = fullSuiteTimeoutForecast
        ? formatFullSuiteTimeoutForecast(fullSuiteTimeoutForecast)
        : null;
    const fullSuiteNotRequiredForDocsOnly = isFullSuiteNotRequiredForDocsOnlyScope(preflight || {});
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const fullSuiteNotRequiredForZeroDiffNoReviewableScope = hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes);
    const fullSuiteNotRequiredForCurrentScope = fullSuiteNotRequiredForDocsOnly || fullSuiteNotRequiredForZeroDiffNoReviewableScope;
    const fullSuiteGatePassed = fullSuiteNotRequiredForDocsOnly
        ? hasAcceptedDocsOnlyFullSuiteSkipArtifact(
                reviewsRoot,
                taskId,
                fullSuiteConfig.command,
                preflightPath,
                preflightSha256,
                summary
            )
        : fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? true
            : isGatePassed(summary, 'full-suite-validation')
                && fullSuiteArtifactMatchesCurrentCycle(
                    readinessArtifacts.fullSuiteValidation,
                    taskId,
                    preflightPath,
                    preflightSha256,
                    summary
                );
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        placement: fullSuiteConfig.placement,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        recommended_timeout_seconds: fullSuiteTimeoutForecast?.recommended_timeout_seconds ?? null,
        timeout_forecast_note: fullSuiteTimeoutForecastLine,
        performance_guidance_note: formatFullSuitePerformanceGuidance(fullSuiteConfig.command),
        note: fullSuiteConfig.enabled && fullSuiteNotRequiredForDocsOnly
            ? 'Full-suite validation is enabled, but this docs-only scope only requires a NOT_REQUIRED artifact.'
            : fullSuiteConfig.enabled && fullSuiteNotRequiredForZeroDiffNoReviewableScope
            ? 'Full-suite validation is enabled, but this BASELINE_ONLY pre-implementation scope has no reviewable diff and requires audited no-op evidence instead.'
            : fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const projectMemoryEvidence = getProjectMemoryImpactLifecycleEvidence({
        repoRoot,
        taskId,
        preflightPath
    });
    const projectMemorySummary = buildProjectMemoryNextStepSummary(repoRoot, projectMemoryEvidence);
    const reviewPolicy = resolveReviewPolicy(preflight, workflowReviewPolicy);
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType, preflightPath, preflightSha256, preflight)
    ));
    const fullSuiteGateStatus = getGateStatus(summary, 'full-suite-validation');
    const fullSuiteTimedOutRetryAvailable = fullSuiteFailedTimeoutRetryAvailable(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteTimeoutForecast
    );
    const currentFailedFullSuiteValidation = fullSuiteGateStatus === 'FAIL'
        && fullSuiteArtifactMatchesCurrentCycle(
            readinessArtifacts.fullSuiteValidation,
            taskId,
            preflightPath,
            preflightSha256,
            summary
        );
    const fullSuiteManualRetryEvidence = readFullSuiteManualRetryEvidence({
        repoRoot,
        taskId,
        fullSuiteArtifact: readinessArtifacts.fullSuiteValidation,
        fullSuiteArtifactPath: readinessArtifacts.paths.fullSuiteValidationPath,
        preflightSha256,
        currentFailedFullSuite: currentFailedFullSuiteValidation
    });
    const fullSuiteTargetedDiagnosticEvidence = readFullSuiteTargetedDiagnosticEvidence({
        eventsRoot,
        taskId,
        currentFailedFullSuite: currentFailedFullSuiteValidation
    });
    const currentCompileGateTimestamp = String(
        summary.gates.find((gate: GateOutcome) => gate.gate === 'compile-gate')?.timestamp_utc || ''
    ).trim() || null;
    const interruptedFullSuiteRun = fullSuiteConfig.enabled && !fullSuiteGatePassed && !fullSuiteNotRequiredForCurrentScope
        ? readInterruptedFullSuiteValidationRunMarker(
            repoRoot,
            taskId,
            preflightPath,
            preflightSha256,
            currentCompileGateTimestamp
        )
        : null;
    const unresolvedFullSuiteRunMarkerPath = (() => {
        if (
            !fullSuiteConfig.enabled
            || fullSuiteGatePassed
            || fullSuiteNotRequiredForCurrentScope
            || interruptedFullSuiteRun
        ) {
            return null;
        }
        const markerPath = resolveFullSuiteValidationRunMarkerPath(repoRoot, taskId);
        return fs.existsSync(markerPath) ? normalizePath(markerPath) : null;
    })();
    const reviewLaunchPlan = applyFullSuiteReadinessToReviewLaunchPlan(
        buildNextStepReviewLaunchPlan({
            requiredReviewTypes,
            policyMode: reviewPolicy.mode,
            requiredReviews: summary.required_reviews,
            reviewStates,
            isSatisfied: (state) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state as ReviewArtifactState),
            isCurrentFailed: (state) => reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state as ReviewArtifactState)
        }),
        fullSuiteConfig.enabled,
        fullSuiteConfig.placement,
        fullSuiteNotRequiredForCurrentScope,
        fullSuiteGateStatus
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        launchable_review_types: reviewLaunchPlan.launchable_review_types,
        blocked_review_lanes: toNextStepBlockedReviewLanes(reviewLaunchPlan),
        failed_review_type: reviewLaunchPlan.failed_review_type,
        next_review_type: reviewLaunchPlan.next_review_type,
        blocked_review_dependencies: reviewLaunchPlan.blocked_review_dependencies,
        ordinary_doc_review_skips: getOrdinaryDocReviewSkips(preflight),
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(
        repoRoot,
        buildNextStepCoreArtifactSpecs(
            readinessArtifacts,
            projectMemoryEvidence.required ? projectMemoryEvidence.artifact_path : null
        )
    );
    const filteredMissingArtifacts = filterNotRequiredCoreMissingArtifacts(coreArtifacts.missing, {
        fullSuiteRequired: fullSuiteConfig.enabled && !fullSuiteNotRequiredForCurrentScope,
        completionGatePassed: isGatePassed(summary, 'completion-gate')
    });

    const sourceRuntimeStaleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: filteredMissingArtifacts,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        projectMemory: projectMemorySummary,
        review: reviewSummary,
        profile: profileSummary,
        markdownWorkingPlan,
        optionalSkillSelection: optionalSkillSelectionSummary,
        auditStatus: summary.status,
        warnings: [] as string[],
        sourceRuntimeStaleness
    };
    const currentProtectedScope = readCurrentProtectedScopeBeforePreflight(repoRoot);
    const currentProtectedScopeNeedsTaskModeRestart = currentProtectedScope
        && (
            taskMode?.orchestrator_work !== true
            || (currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true)
        );
    const buildCurrentProtectedScopeTaskModeRestartRoute = () => {
        if (!currentProtectedScope || !currentProtectedScopeNeedsTaskModeRestart) {
            return null;
        }
        const protectedScopeList = currentProtectedScope.protectedFiles.join(', ');
        const missingFlagLabel = currentProtectedScope.workflowConfigFiles.length > 0 && taskMode?.workflow_config_work !== true
            ? '--orchestrator-work --workflow-config-work'
            : '--orchestrator-work';
        if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'operator-maintenance',
                title: 'Garda self-guard blocks agent-owned protected control-plane work.',
                reason:
                    `The current workspace already contains protected Garda control-plane files before classify-change: ${protectedScopeList}. ` +
                    formatGardaSelfGuardProtectedControlPlaneGuidance(),
                commands: [
                    buildCommand('Operator policy change', buildGardaSelfGuardPolicyChangeCommand(cliPrefix))
                ]
            });
        }
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode for protected scope before classify.',
            reason:
                `The current workspace already contains protected orchestrator control-plane files before classify-change: ${protectedScopeList}. ` +
                `Task-mode evidence must declare ${missingFlagLabel} before protected scope is classified; fresh operator approval is required.`,
            commands: [
                buildCommand(
                    currentProtectedScope.workflowConfigFiles.length > 0
                        ? 'Restart task mode with workflow-config work'
                        : 'Restart task mode with orchestrator work',
                    buildOrchestratorWorkRestartCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        taskMode,
                        currentProtectedScope.changedFiles,
                        currentProtectedScope.workflowConfigFiles.length > 0
                    )
                )
            ]
        });
    };

    if (taskIdCaseMismatch) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'task-id-casing',
            title: 'Task ID casing does not match TASK.md.',
            reason:
                `Requested task id ${formatNextStepInlineValue(taskId)} matches TASK.md row ` +
                `${formatNextStepInlineValue(taskIdCaseMismatch)} only by case. ` +
                'Use the exact TASK.md task id before any lifecycle gate so artifacts cannot fork into a parallel casing namespace.',
            commands: [
                buildCommand(
                    'Rerun navigator with TASK.md casing',
                    `${cliPrefix} next-step "${taskIdCaseMismatch}" --repo-root "."`
                )
            ],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    const taskQueueTerminalRoute = resolveTaskQueueTerminalDecisionRoute({
        repoRoot,
        reviewsRoot,
        eventsRoot,
        taskId,
        cliPrefix,
        taskEntries,
        taskEntry,
        completionGatePassed: isGatePassed(summary, 'completion-gate'),
        latestCompletionCurrent: isLatestCompletionCurrent(eventsRoot, taskId),
        finalReportContractReady: summary.final_report_contract.status === 'READY',
        finalReportContractBlocker: summary.final_report_contract.blocker || null,
        summaryBlockers: summary.blockers.map((blocker) => `${blocker.gate}: ${blocker.reason}`),
        filteredMissingArtifacts,
        corePresentArtifacts: coreArtifacts.present
    });
    if (taskQueueTerminalRoute) {
        return buildResult({
            ...resultBase,
            status: taskQueueTerminalRoute.status,
            nextGate: taskQueueTerminalRoute.nextGate,
            title: taskQueueTerminalRoute.title,
            reason: taskQueueTerminalRoute.reason,
            commands: taskQueueTerminalRoute.commands,
            missingArtifacts: taskQueueTerminalRoute.missingArtifacts ?? resultBase.missingArtifacts,
            presentArtifacts: taskQueueTerminalRoute.presentArtifacts ?? coreArtifacts.present,
            finalReport: taskQueueTerminalRoute.finalReport ?? null
        });
    }

    if (isGatePassed(summary, 'completion-gate') && isLatestCompletionCurrent(eventsRoot, taskId)) {
        const hasFinalCloseoutArtifact = fs.existsSync(readinessArtifacts.paths.finalCloseoutJsonPath)
            || fs.existsSync(readinessArtifacts.paths.finalCloseoutMarkdownPath);
        const postDoneDrift = hasFinalCloseoutArtifact
            ? readPostDoneWorkspaceDriftDecision(
                repoRoot,
                preflight,
                readinessArtifacts.paths.docImpactPath,
                readinessArtifacts.paths.finalCloseoutJsonPath
            )
            : { blocked: false, reason: 'No materialized final closeout artifact exists yet.' };
        const finalReport = readReadyFinalReportSummary(repoRoot, reviewsRoot, taskId, summary);
        const completedCloseoutRoute = resolveCompletedCloseoutRouteFromState({
            postDoneDriftBlocked: postDoneDrift.blocked,
            postDoneDriftReason: postDoneDrift.reason,
            finalReportContractReady: summary.final_report_contract.status === 'READY',
            finalReportContractBlocker: summary.final_report_contract.blocker || '',
            finalReport,
            taskAuditCommand: `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
        });
        const finalCloseoutMissingArtifacts = buildFinalCloseoutMissingArtifacts(repoRoot, reviewsRoot, taskId, {
            finalCloseoutJsonPath: readinessArtifacts.paths.finalCloseoutJsonPath,
            finalCloseoutMarkdownPath: readinessArtifacts.paths.finalCloseoutMarkdownPath
        });
        return buildResult({
            ...resultBase,
            status: completedCloseoutRoute.status,
            nextGate: completedCloseoutRoute.nextGate,
            title: completedCloseoutRoute.title,
            reason: completedCloseoutRoute.reason,
            commands: completedCloseoutRoute.commands,
            missingArtifacts: completedCloseoutRoute.status === 'DONE' ? [] : finalCloseoutMissingArtifacts,
            finalReport: completedCloseoutRoute.finalReport as NextStepFinalReportSummary | null
        });
    }

    const docImpactPath = readinessArtifacts.paths.docImpactPath;
    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(taskMode)
        })
        : { ready: false, reason: 'No current preflight exists.' };
    const strictPreGuardWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(taskMode),
            allowDocsOnlyDelta: false
        })
        : { ready: false, reason: 'No current preflight exists.' };
    const preflightCycleReadiness = readPreflightCycleReadiness(
        eventsRoot,
        taskId,
        buildStaleCompletionFailureDocCloseoutAllowance(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            preflightWorkspaceReadiness,
            docImpactPath
        )
    );
    const failedCurrentReviewStateForPreflight = reviewLaunchPlan.next_review_type
        ? reviewStates.find((candidate) => (
            candidate.reviewType === reviewLaunchPlan.next_review_type && candidate.failed
        ))
        : undefined;
    const effectivePreflightWorkspaceReadiness = preflight && failedCurrentReviewStateForPreflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(taskMode)
        })
        : preflightWorkspaceReadiness;
    const effectiveStrictPreGuardWorkspaceReadiness = preflight && failedCurrentReviewStateForPreflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode),
            dirtyWorkspaceBaselineChangedFiles: getTaskModeDirtyWorkspaceBaselineChangedFiles(taskMode),
            dirtyWorkspaceBaselineFileHashes: getTaskModeDirtyWorkspaceBaselineFileHashes(taskMode),
            allowDocsOnlyDelta: false
        })
        : strictPreGuardWorkspaceReadiness;

    const startupCycleReadiness = readStartupCycleReadiness(repoRoot, eventsRoot, taskId, taskModePath, {
        enforceLateRulePackAfterReviewPhase:
            !preflight || !preflightCycleReadiness.ready || !effectivePreflightWorkspaceReadiness.ready
    });
    const startupRoute = resolveNextStepStartupRoute({
        enterTaskModePassed: isGatePassed(summary, 'enter-task-mode'),
        defaultExecutionProvider,
        enterTaskModeCommand: buildEnterTaskModeCommand(cliPrefix, taskId, taskEntry, defaultExecutionProvider),
        startupCycleReadiness,
        loadRulePackPassed: isGatePassed(summary, 'load-rule-pack'),
        rulePackStage: resolveRulePackStage(rulePack),
        preflightExists: Boolean(preflight),
        taskEntryRulePackCommand: buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId, taskModePath),
        handshakeDiagnosticsPassed: isGatePassed(summary, 'handshake-diagnostics'),
        handshakeDiagnosticsCommand: `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`,
        shellSmokePreflightPassed: isGatePassed(summary, 'shell-smoke-preflight'),
        shellSmokePreflightCommand: `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`
    });
    if (startupRoute) {
        return buildResult({
            ...resultBase,
            status: startupRoute.status,
            nextGate: startupRoute.nextGate,
            title: startupRoute.title,
            reason: startupRoute.reason,
            commands: startupRoute.commands
        });
    }

    const strictDecompositionRequirement = buildStrictDecompositionDecisionRequirement({
        taskId,
        taskEntry,
        taskMode,
        preflight,
        profileSummary,
        requiredReviewTypes
    });
    const buildStrictDecompositionContinuationBlock = (): NextStepResult | null => {
        const strictRoute = resolveStrictDecompositionContinuationRoute({
            repoRoot,
            eventsRoot,
            taskEntries,
            taskId,
            cliPrefix,
            requirement: strictDecompositionRequirement,
            requiredReviewTypes,
            baseMissingArtifacts: resultBase.missingArtifacts,
            basePresentArtifacts: coreArtifacts.present
        });
        if (!strictRoute) {
            return null;
        }
        return buildResult({
            ...resultBase,
            status: strictRoute.status,
            nextGate: strictRoute.nextGate,
            title: strictRoute.title,
            reason: strictRoute.reason,
            commands: strictRoute.commands,
            missingArtifacts: strictRoute.missingArtifacts ?? resultBase.missingArtifacts,
            presentArtifacts: strictRoute.presentArtifacts ?? coreArtifacts.present,
            finalReport: strictRoute.finalReport
        });
    };

    if (!preflight || !isGatePassed(summary, 'classify-change')) {
        const failedGateRecovery = readFailedGateRecovery(repoRoot, eventsRoot, taskId, cliPrefix, taskMode);
        if (failedGateRecovery) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: failedGateRecovery.nextGate,
                title: failedGateRecovery.title,
                reason: failedGateRecovery.reason,
                commands: [
                    buildCommand(failedGateRecovery.label, failedGateRecovery.command)
                ]
            });
        }

        const strictDecompositionBlock = buildStrictDecompositionContinuationBlock();
        if (strictDecompositionBlock) {
            return strictDecompositionBlock;
        }

        const currentProtectedScopeRoute = buildCurrentProtectedScopeTaskModeRestartRoute();
        if (currentProtectedScopeRoute) {
            return currentProtectedScopeRoute;
        }

        const classifyCommand = buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: true
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Classify the task scope.',
            reason: 'No current preflight artifact exists, so required reviews and compile scope are unknown.',
            commands: [
                buildCommand(
                    'Classify changed files',
                    classifyCommand
                )
            ]
        });
    }

    if (
        optionalSkillSelectionSummary?.decision === 'selected_installed_skills'
        && optionalSkillSelectionSummary.timeline_invalid_json
        && (optionalSkillSelectionSummary.policy_mode === 'required' || optionalSkillSelectionSummary.policy_mode === 'strict')
    ) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'task-events-summary',
            title: 'Repair malformed task timeline before optional-skill activation.',
            reason:
                'The current task timeline JSONL is malformed, so current-cycle optional-skill activation evidence cannot be read reliably. ' +
                'Do not run activate-optional-skill until task-event integrity is repaired; otherwise newly appended SKILL_SELECTED events may remain invisible to the navigator.',
            commands: [
                buildCommand(
                    'Inspect task timeline integrity',
                    `${cliPrefix} gate task-events-summary --task-id ${quoteCommandValue(taskId)} --as-json --repo-root "."`
                )
            ]
        });
    }

    const coherentCycleReadiness = readCoherentCycleReadiness(
        repoRoot,
        eventsRoot,
        reviewsRoot,
        taskId,
        preflightPath,
        taskModePath
    );
    const postPreflightRulePackReadiness = readPostPreflightRulePackReadiness(
        repoRoot,
        taskId,
        preflightPath,
        rulePackPath,
        taskModePath
    );
    const reviewGateAlreadyPassed = isGatePassed(summary, 'required-reviews-check');
    const currentProtectedScopeRoute = buildCurrentProtectedScopeTaskModeRestartRoute();
    if (currentProtectedScopeRoute) {
        return currentProtectedScopeRoute;
    }

    const preGuardRoute = resolveNextStepPreGuardRoute({
        preflightCycleReadiness,
        preflightCycleRefreshCommand: buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: getPreflightRefreshChangedFiles(taskMode, preflight)
        }),
        protectedControlPlane: {
            touched: preflightTouchesProtectedControlPlane(preflight),
            taskModeHasOrchestratorWork: Boolean(taskMode?.orchestrator_work),
            selfGuardDeny: isGardaSelfGuardDenyAgentEntry(repoRoot),
            selfGuardGuidance: formatGardaSelfGuardProtectedControlPlaneGuidance(),
            selfGuardPolicyChangeCommand: buildGardaSelfGuardPolicyChangeCommand(cliPrefix),
            orchestratorWorkRestartCommand: buildOrchestratorWorkRestartCommand(repoRoot, cliPrefix, taskId, taskMode)
        },
        workspaceReadiness: reviewGateAlreadyPassed
            ? effectivePreflightWorkspaceReadiness
            : effectiveStrictPreGuardWorkspaceReadiness,
        workspaceRefreshCommand: buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: getPreflightRefreshCommandChangedFiles({
                repoRoot,
                preflight,
                taskMode,
                fallbackChangedFiles: (reviewGateAlreadyPassed
                    ? effectivePreflightWorkspaceReadiness.currentChangedFiles
                    : effectiveStrictPreGuardWorkspaceReadiness.currentChangedFiles)
                    ?? getPreflightRefreshChangedFiles(taskMode, preflight)
            })
        }),
        coherentCycleReadiness,
        navigatorCommand,
        postPreflightRulePack: {
            stage: resolveRulePackStage(rulePack),
            ready: postPreflightRulePackReadiness.ready,
            reason: postPreflightRulePackReadiness.reason,
            canBind: postPreflightRulePackReadiness.rebind?.can_bind === true,
            rebindReason: postPreflightRulePackReadiness.rebind?.reason,
            loadCommand: buildPostPreflightRulePackCommandForFiles(
                repoRoot,
                cliPrefix,
                taskId,
                getPostPreflightRuleFileNames(preflight, taskMode),
                taskModePath
            ),
            bindCommand: buildPostPreflightRulePackBindCommand(
                repoRoot,
                cliPrefix,
                taskId,
                taskModePath
            )
        }
    });
    if (preGuardRoute) {
        return buildResult({
            ...resultBase,
            status: preGuardRoute.status,
            nextGate: preGuardRoute.nextGate,
            title: preGuardRoute.title,
            reason: preGuardRoute.reason,
            commands: preGuardRoute.commands
        });
    }

    let scopeBudgetGuardEvaluation: ScopeBudgetGuardEvaluation | null = null;
    try {
        scopeBudgetGuardEvaluation = readScopeBudgetGuardEvaluation(
            repoRoot,
            preflight,
            profileSummary,
            requiredReviewTypes
        );
    } catch (error: unknown) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        });
    }
    if (scopeBudgetGuardEvaluation?.should_block) {
        const guardReason = sanitizeScopeBudgetGuardSummary(scopeBudgetGuardEvaluation);
        const latchResult = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot,
            reviewsRoot,
            taskId,
            guardKind: 'scope_budget',
            guardReason,
            rawGuardSummary: scopeBudgetGuardEvaluation.summary_line,
            preflightPath,
            guardDetails: {
                action: scopeBudgetGuardEvaluation.action,
                profile_name: scopeBudgetGuardEvaluation.profile_name,
                violations: scopeBudgetGuardEvaluation.violations.map((violation) => ({
                    metric: violation.metric,
                    actual: violation.actual,
                    limit: violation.limit
                }))
            }
        });
        if (!isSuccessfulSplitRequiredStatusSync(latchResult.status_sync)) {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'split-required-latch',
                title: 'Split-required latch could not update TASK.md.',
                reason:
                    `${guardReason}. The split-required latch artifact was materialized at ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, latchResult.artifact_path))}, ` +
                    `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(latchResult.status_sync.outcome)}. ` +
                    `${latchResult.status_sync.error_message ? `${latchResult.status_sync.error_message} ` : ''}` +
                    'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                commands: [],
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: 'SPLIT_REQUIRED',
            nextGate: 'split-required-latch',
            title: 'Split-required latch is active.',
            reason:
                `${guardReason}. The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ` +
                `${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, latchResult.artifact_path))}. ` +
                'Create and link child tasks before continuing; do not shrink or reshape the diff merely to bypass the guard. ' +
                'Ordinary classify, compile, review, full-suite, completion, and final closeout gates are suppressed for the parent while the latch is active.',
            commands: [],
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    let reviewCycleGuardEvaluation: ReviewCycleGuardEvaluation | null = null;
    let latestFailedReviewCycleAttempt: NextStepReviewCycleLatestFailedReview | null = null;
    try {
        const reviewCycleGuardResult = readReviewCycleGuardEvaluation(repoRoot, eventsRoot, taskId);
        reviewCycleGuardEvaluation = reviewCycleGuardResult.evaluation;
        latestFailedReviewCycleAttempt = reviewCycleGuardResult.latestFailedReview;
    } catch (error: unknown) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'workflow-config-validation',
            title: 'Validate workflow configuration before continuing.',
            reason: error instanceof Error ? error.message : String(error),
            commands: [
                buildCommand(
                    'Validate workflow config',
                    `${cliPrefix} workflow validate --target-root "."`
                )
            ]
        });
    }
    if (reviewCycleGuardEvaluation?.should_block) {
        const pendingRequiredReviewTypes = requiredReviewTypes.filter((reviewType) => {
            const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
            return !state || !reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state);
        });
        const continuationEvidence = assessReviewCycleContinuationEvidence({
            repoRoot,
            reviewsRoot,
            eventsRoot,
            taskId,
            evaluation: reviewCycleGuardEvaluation,
            reviewPhase: {
                required_review_types: requiredReviewTypes,
                pending_required_review_types: pendingRequiredReviewTypes
            }
        });
        if (continuationEvidence.status === 'ACTIVE') {
            resultBase.warnings.push(
                `Review cycle one-shot continuation active: ${continuationEvidence.reason}. ` +
                `Artifact: ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, continuationEvidence.artifact_path))}. ` +
                'This approval is task-scoped runtime evidence only and does not mutate workflow-config.json; raise_limits remains a permanent repo-local workflow-config change through workflow set.'
            );
        } else {
            if (continuationEvidence.status !== 'MISSING') {
                resultBase.warnings.push(
                    `Review cycle one-shot continuation ${continuationEvidence.status.toLowerCase()}: ${continuationEvidence.reason}. ` +
                    `Artifact: ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, continuationEvidence.artifact_path))}.`
                );
            }
            const reviewCycleBlock = buildReviewCycleOperatorBlock(
                repoRoot,
                reviewsRoot,
                taskId,
                reviewCycleGuardEvaluation,
                latestFailedReviewCycleAttempt
            );
            const continuationAlreadyRecorded = continuationEvidence.status !== 'MISSING';
            if (continuationAlreadyRecorded) {
                reviewCycleBlock.choices = reviewCycleBlock.choices.filter((choice) => choice !== 'allow_one_more_cycle');
                reviewCycleBlock.operator_choice_guidance = reviewCycleBlock.operator_choice_guidance
                    .filter((guidance) => !guidance.startsWith('allow_one_more_cycle:'));
            }
            const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
            const continuationDecisionGuidance = continuationAlreadyRecorded
                ? 'A one-shot continuation was already recorded for this task attempt; do not offer or accept another one. Continue by splitting/decomposing the task or choosing an explicit terminal/operator decision.'
                : 'The configured workflow guard blocks additional compile, review, or full-suite continuation until operator decision. allow_one_more_cycle records task-scoped one-shot runtime evidence only; raise_limits is a permanent repo-local workflow-config change through workflow set.';
            let splitRequiredLatch: SplitRequiredLatchResult | null = null;
            if (autoSplitEnabled) {
                splitRequiredLatch = materializeSplitRequiredLatch({
                    repoRoot,
                    eventsRoot,
                    reviewsRoot,
                    taskId,
                    guardKind: 'review_cycle',
                    guardReason: reviewCycleBlock.reason,
                    rawGuardSummary: reviewCycleGuardEvaluation.summary_line,
                    preflightPath,
                    guardDetails: {
                        action: reviewCycleGuardEvaluation.action,
                        total_non_test_review_count: reviewCycleGuardEvaluation.total_non_test_review_count,
                        failed_non_test_review_count: reviewCycleGuardEvaluation.failed_non_test_review_count,
                        excluded_review_types: reviewCycleGuardEvaluation.excluded_review_types,
                        violations: reviewCycleGuardEvaluation.violations.map((violation) => ({
                            metric: violation.metric,
                            actual: violation.actual,
                            limit: violation.limit
                        })),
                        auto_split_prompt: reviewCycleBlock.auto_split_prompt
                    }
                });
                if (!isSuccessfulSplitRequiredStatusSync(splitRequiredLatch.status_sync)) {
                    return buildResult({
                        ...resultBase,
                        status: 'BLOCKED',
                        nextGate: 'split-required-latch',
                        title: 'Split-required latch could not update TASK.md.',
                        reason:
                            `${reviewCycleBlock.reason}. The split-required latch artifact was materialized at ` +
                            `${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, splitRequiredLatch.artifact_path))}, ` +
                            `but TASK.md status sync failed with outcome ${formatNextStepInlineValue(splitRequiredLatch.status_sync.outcome)}. ` +
                            `${splitRequiredLatch.status_sync.error_message ? `${splitRequiredLatch.status_sync.error_message} ` : ''}` +
                            'Do not continue parent compile, review, full-suite, completion, or final closeout gates until the latch is repaired.',
                        commands: [],
                        reviewCycleBlock,
                        finalReport: null
                    });
                }
            }
            return buildResult({
                ...resultBase,
                status: autoSplitEnabled ? 'SPLIT_REQUIRED' : 'BLOCKED',
                nextGate: autoSplitEnabled ? 'split-required-latch' : 'review-cycle-attempt-guard',
                title: autoSplitEnabled ? 'Split-required latch is active.' : 'Review cycle limit exceeded.',
                reason:
                    `${reviewCycleBlock.reason}. ` +
                    `Counts: total_non_test_reviews=${reviewCycleGuardEvaluation.total_non_test_review_count}, ` +
                    `failed_non_test_reviews=${reviewCycleGuardEvaluation.failed_non_test_review_count}, ` +
                    `excluded_review_types=${formatNextStepInlineList(reviewCycleGuardEvaluation.excluded_review_types)}. ` +
                    (autoSplitEnabled
                        ? `The gate moved this parent task to SPLIT_REQUIRED and materialized latch evidence at ${formatNextStepInlineValue(toRepoDisplayPath(repoRoot, splitRequiredLatch?.artifact_path || ''))}. Follow the auto-split prompt artifact and create linked child tasks before continuing child work.`
                        : continuationDecisionGuidance),
                commands: autoSplitEnabled
                    ? []
                    : [
                        ...(continuationAlreadyRecorded
                            ? []
                            : [buildCommand(
                                'Record one-shot review-cycle continuation',
                                buildReviewCycleContinuationCommand(cliPrefix, taskId, reviewCycleGuardEvaluation)
                            )]),
                        buildCommand(
                            'Record review-cycle split decision',
                            buildReviewCycleSplitDecisionCommand(repoRoot, cliPrefix, taskId, reviewCycleGuardEvaluation, preflightPath)
                        )
                    ],
                reviewCycleBlock,
                missingArtifacts: autoSplitEnabled ? [] : resultBase.missingArtifacts,
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
    }
    if (
        reviewCycleGuardEvaluation?.active
        && reviewCycleGuardEvaluation.action === 'WARN_ONLY'
        && reviewCycleGuardEvaluation.violations.length > 0
    ) {
        resultBase.warnings.push(
            `${reviewCycleGuardEvaluation.summary_line}. ` +
            `Counts: total_non_test_reviews=${reviewCycleGuardEvaluation.total_non_test_review_count}, ` +
            `failed_non_test_reviews=${reviewCycleGuardEvaluation.failed_non_test_review_count}, ` +
            `excluded_review_types=${formatNextStepInlineList(reviewCycleGuardEvaluation.excluded_review_types)}.`
        );
    }

    const strictDecompositionBlock = buildStrictDecompositionContinuationBlock();
    if (strictDecompositionBlock) {
        return strictDecompositionBlock;
    }

    const pendingOptionalSkillActivation = getPendingOptionalSkillActivationCommand(optionalSkillSelectionSummary);
    if (pendingOptionalSkillActivation) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'activate-optional-skill',
            title: 'Activate the selected optional skill.',
            reason:
                `Current preflight selected optional skill ${formatNextStepInlineValue(pendingOptionalSkillActivation.skillId)}, ` +
                'but the current task cycle has no matching activation evidence yet. ' +
                'Record activation before compile, review, implementation, or closeout so selected-skill diagnostics and final audit describe the same current-cycle state.',
            commands: [
                buildCommand(
                    `Activate optional skill ${pendingOptionalSkillActivation.skillId}`,
                    pendingOptionalSkillActivation.command
                )
            ]
        });
    }

    const compileReadiness = preflight
        ? readCompileReadiness(repoRoot, reviewsRoot, eventsRoot, taskId, preflightPath)
        : { ready: false, reason: 'No current preflight exists.' };
    const compileGateRoute = resolveNextStepCompileGateRoute({
        compileGatePassed: isGatePassed(summary, 'compile-gate'),
        ready: compileReadiness.ready,
        reason: compileReadiness.reason,
        recoveryGate: compileReadiness.recoveryGate,
        refreshPreflightCommand: buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: getPreflightRefreshCommandChangedFiles({
                repoRoot,
                preflight,
                taskMode,
                fallbackChangedFiles: preflightWorkspaceReadiness.currentChangedFiles
                    ?? getPreflightRefreshChangedFiles(taskMode, preflight)
            })
        }),
        compileCommand: buildCompileGateCommand(
            repoRoot,
            cliPrefix,
            taskId,
            preflightCommandPath,
            taskModePath
        )
    });
    if (compileGateRoute) {
        return buildResult({
            ...resultBase,
            status: compileGateRoute.status,
            nextGate: compileGateRoute.nextGate,
            title: compileGateRoute.title,
            reason: compileGateRoute.reason,
            commands: compileGateRoute.commands
        });
    }

    const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
    const fullSuiteRunMarkerRecoveryCommand =
        `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
    const fullSuiteRunMarkerCleanupCommand =
        `${cliPrefix} gate full-suite-run-marker-recovery --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --clear-dead-marker --operator-confirmed yes --repo-root "."`;
    const fullSuiteValidationRoute = resolveFullSuiteDecisionRoute({
        enabled: fullSuiteConfig.enabled,
        placement: fullSuiteConfig.placement,
        notRequiredForCurrentScope: fullSuiteNotRequiredForCurrentScope,
        gateStatus: fullSuiteGateStatus,
        gatePassed: fullSuiteGatePassed,
        timedOutRetryAvailable: fullSuiteTimedOutRetryAvailable,
        transientRetryEvidenceAvailable: fullSuiteManualRetryEvidence.available,
        transientRetryEvidenceReason: fullSuiteManualRetryEvidence.reason,
        targetedDiagnosticRetryAvailable: fullSuiteTargetedDiagnosticEvidence.available,
        targetedDiagnosticRetryReason: fullSuiteTargetedDiagnosticEvidence.reason,
        configPath: fullSuiteSummary.config_path,
        commandText: fullSuiteConfig.command,
        timeoutForecastLine: fullSuiteTimeoutForecastLine,
        command: fullSuiteCommand,
        runMarkerRecoveryCommand: fullSuiteRunMarkerRecoveryCommand,
        runMarkerCleanupCommand: fullSuiteRunMarkerCleanupCommand,
        navigatorCommand,
        nextReviewType: reviewLaunchPlan.next_review_type,
        interruptedRun: interruptedFullSuiteRun,
        unresolvedRunMarkerPath: unresolvedFullSuiteRunMarkerPath
    });
    if (fullSuiteValidationRoute) {
        return buildResult({
            ...resultBase,
            status: fullSuiteValidationRoute.status,
            nextGate: fullSuiteValidationRoute.nextGate,
            title: fullSuiteValidationRoute.title,
            reason: fullSuiteValidationRoute.reason,
            commands: fullSuiteValidationRoute.commands
        });
    }

    if (reviewLaunchPlan.next_review_type) {
        const reviewType = reviewLaunchPlan.next_review_type;
        const state = reviewStates.find((candidate) => candidate.reviewType === reviewType);
        const currentReviewReuseRecorded = state
            ? state.reusedExistingReview && timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state)
            : false;
        const currentReviewEvidenceSatisfied = state
            ? reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewRecordedEvidenceCurrent = state
            ? reviewStateHasCurrentRecordedEvidence(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextInvocationAttested = state
            ? timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
            : false;
        const currentReviewContextPrepared = state
            ? timelineHasReviewContextPreparedAfterCompile(eventsRoot, taskId, reviewType, state.contextPath)
            : false;
        const dependencies = reviewLaunchPlan.blocked_review_dependencies;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            state,
            (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
        );
        const blockedDependencyRoute = resolveReviewLaunchableLanePreparationRoute({
            reviewPolicyMode: reviewPolicy.mode,
            reviewType,
            dependencies,
            dependencyDetails: dependencies.length > 0
                ? describeBlockedReviewDependencies(dependencies, reviewStates)
                : '',
            reviewerReadinessChain,
            reviewContextChain: '',
            scopedDiffReadiness: { ready: true, reason: '' },
            stateExists: true,
            contextExists: true,
            contextCurrent: true,
            contextDetailsSuffix: '',
            commands: {
                finishUpstreamReview: buildCommand(
                    'Finish upstream review first',
                    navigatorCommand
                ),
                buildScopedDiff: buildCommand('Build scoped diff', navigatorCommand),
                buildReviewContext: buildCommand('Build review context', navigatorCommand)
            }
        });
        if (blockedDependencyRoute) {
            return buildResult({
                ...resultBase,
                status: blockedDependencyRoute.status,
                nextGate: blockedDependencyRoute.nextGate,
                title: blockedDependencyRoute.title,
                reason: blockedDependencyRoute.reason,
                commands: blockedDependencyRoute.commands
            });
        }
        const strictSequentialUpstreamReuse = findStrictSequentialUpstreamNeedingCurrentCycleReuse({
            repoRoot,
            eventsRoot,
            taskId,
            targetReviewType: reviewType,
            requiredReviews: summary.required_reviews,
            policyMode: reviewPolicy.mode,
            reviewStates
        });
        if (strictSequentialUpstreamReuse) {
            const upstreamReviewType = strictSequentialUpstreamReuse.upstreamReviewType;
            const upstreamState = strictSequentialUpstreamReuse.upstreamState;
            const upstreamScopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${upstreamReviewType}-scoped.json`);
            const upstreamScopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${upstreamReviewType}-scoped.diff`);
            const upstreamScopedDiffReadiness = scopedDiffExpectedForReview({
                preflight,
                reviewType: upstreamReviewType
            })
                ? getScopedDiffMetadataReadiness({
                    metadataPath: upstreamScopedDiffMetadataPath,
                    preflight,
                    preflightPath,
                    preflightSha256,
                    reviewType: upstreamReviewType
                })
                : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
            const upstreamReviewerReadinessChain = buildReviewerReadinessChainSummary(
                repoRoot,
                eventsRoot,
                taskId,
                upstreamReviewType,
                upstreamState,
                (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
            );
            const upstreamReviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType: upstreamReviewType,
                edgeId: 'compile-to-review-context',
                reason:
                    `latest compile evidence is current before materializing '${upstreamReviewType}' review reuse ` +
                    `for downstream '${reviewType}' preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: upstreamState.contextPath
                    ? toRepoDisplayPath(repoRoot, upstreamState.contextPath)
                    : undefined,
                depth: reviewDepth
            });
            const upstreamReuseRoute = resolveStrictSequentialUpstreamReuseRoute({
                reviewPolicyMode: reviewPolicy.mode,
                downstreamReviewType: reviewType,
                upstreamReviewType,
                reuseCandidateHint: getBuildReviewContextReuseCandidateHint(eventsRoot, taskId, upstreamState),
                upstreamScopedDiffReadiness,
                upstreamReviewerReadinessChain,
                upstreamReviewContextChain,
                commands: {
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType: upstreamReviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, upstreamScopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, upstreamScopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build upstream review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, upstreamReviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                }
            });
            return buildResult({
                ...resultBase,
                status: upstreamReuseRoute.status,
                nextGate: upstreamReuseRoute.nextGate,
                title: upstreamReuseRoute.title,
                reason: upstreamReuseRoute.reason,
                commands: upstreamReuseRoute.commands
            });
        }
        if (state?.failed) {
            const taskIntent = getStringField(taskMode, 'task_summary', taskEntry?.title || taskId);
            const downstreamReviewTypes = getDownstreamReviewTypesFor(
                reviewType,
                requiredReviewTypes,
                summary.required_reviews,
                reviewPolicy.mode
            );
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before rebuilding '${reviewType}' review context`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const failedReviewRoute = resolveFailedReviewRemediationRoute({
                taskId,
                reviewType,
                verdictToken: state.verdictToken || state.failToken || 'FAILED',
                failureKind: state.failureKind,
                failureReason: state.failureReason,
                currentReviewRecordedEvidenceCurrent,
                currentReviewContextPrepared,
                scopedDiffReadiness,
                reviewerReadinessChain,
                reviewContextChain,
                downstreamReviewTypes,
                commands: {
                    restartReviewCycle: buildCommand(
                        state.failureKind === 'missing-validation-evidence'
                            ? 'Restart review cycle after manual-validation evidence refresh'
                            : 'Restart review cycle for reviewer launch retry',
                        buildRestartReviewCycleCommand(repoRoot, cliPrefix, taskId, taskIntent, taskModePath)
                    ),
                    rerunNavigator: buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    ),
                    compileGate: buildCommand(
                        'Run compile gate to refresh validation evidence',
                        buildCompileGateCommand(
                            repoRoot,
                            cliPrefix,
                            taskId,
                            preflightCommandPath,
                            taskModePath
                        )
                    ),
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                }
            });
            if (failedReviewRoute) {
                return buildResult({
                    ...resultBase,
                    status: failedReviewRoute.status,
                    nextGate: failedReviewRoute.nextGate,
                    title: failedReviewRoute.title,
                    reason: failedReviewRoute.reason,
                    commands: failedReviewRoute.commands
                });
            }
        }
        if (!state || !state.contextExists || !state.contextCurrent) {
            const reviewContextChain = buildReviewGateChainStatusSummary({
                repoRoot,
                eventsRoot,
                taskId,
                reviewType,
                edgeId: 'compile-to-review-context',
                reason: `latest compile evidence is current before '${reviewType}' review-context preparation`,
                preflightPath: preflightCommandPath,
                reviewContextPath: state?.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
                depth: reviewDepth
            });
            const contextDetails = state?.violations
                .filter((violation) => violation.includes('review context'))
                .join(' ');
            const preparationRoute = resolveReviewLaunchableLanePreparationRoute({
                reviewPolicyMode: reviewPolicy.mode,
                reviewType,
                dependencies: [],
                dependencyDetails: '',
                reviewerReadinessChain,
                reviewContextChain,
                scopedDiffReadiness,
                stateExists: Boolean(state),
                contextExists: Boolean(state?.contextExists),
                contextCurrent: Boolean(state?.contextCurrent),
                contextDetailsSuffix: contextDetails ? ` ${contextDetails}` : '',
                commands: {
                    finishUpstreamReview: buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    ),
                    buildScopedDiff: buildCommand(
                        'Build scoped diff',
                        buildScopedDiffCommand({
                            cliPrefix,
                            reviewType,
                            preflightCommandPath,
                            outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                            metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                        })
                    ),
                    buildReviewContext: buildCommand(
                        'Build review context',
                        buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                    )
                }
            });
            if (!preparationRoute) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'build-review-context',
                    title: `Prepare '${reviewType}' review context.`,
                    reason: `Required review '${reviewType}' review-context state is inconsistent for the current preflight. ${reviewerReadinessChain} ${reviewContextChain}`,
                    commands: [
                        buildCommand(
                            'Build review context',
                            buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: preparationRoute.status,
                nextGate: preparationRoute.nextGate,
                title: preparationRoute.title,
                reason: preparationRoute.reason,
                commands: preparationRoute.commands
            });
        }
        const contextReviewerIdentity = state.contextReviewerIdentity || '';
        const providerLaunchTargetSummary = buildProviderNativeReviewerLaunchTargetSummary(taskMode);
        const routingCurrent = (
            contextReviewerIdentity.startsWith('agent:')
            && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, contextReviewerIdentity)
        );
        const launchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
            repoRoot,
            eventsRoot,
            taskId,
            state
        );
        const resolvedLaunchReviewerIdentity = String(launchArtifactEvidence.reviewerIdentity || '').trim();
        const delegatedReviewerIdentity = launchArtifactEvidence.state !== 'prepared'
            && isResolvedReviewerIdentity(resolvedLaunchReviewerIdentity)
            ? resolvedLaunchReviewerIdentity
            : DELEGATED_REVIEWER_IDENTITY_FROM_PROVIDER_PLACEHOLDER;
        const reviewerIdentity = isResolvedReviewerIdentity(contextReviewerIdentity)
            ? contextReviewerIdentity
            : delegatedReviewerIdentity;
        const routingReviewerIdentity = null;
        const launchArtifactPath = buildDefaultReviewScratchCommandPath(
            repoRoot,
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
        const oneShotLaunchHint = launchArtifactEvidence.state === 'prepared'
            && launchArtifactEvidence.launchInputArtifactPath
            && launchArtifactEvidence.launchInputArtifactSha256
            ? (
                `ReviewerOneShotLaunchHint: launch a fresh delegated reviewer once with the exact opaque handoff ` +
                `ReviewerLaunchInputArtifactPath: ${normalizePath(launchArtifactEvidence.launchInputArtifactPath)} ` +
                `(launch_input_sha256=${launchArtifactEvidence.launchInputArtifactSha256}) ` +
                `or CopyPasteReviewerLaunchPrompt from prepare-reviewer-launch, then run record-reviewer-delegation-started immediately after provider launch.`
            )
            : null;
        const reviewerIdentityIsPlanned = isPlannedReviewerIdentity(contextReviewerIdentity);
        const reviewRoutingChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-context-to-routing',
            reason: `current '${reviewType}' review context is ready for routing before reviewer launch preparation`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const launchPreparationChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-routing-to-launch-prepared',
            reason: `current '${reviewType}' routing telemetry is ready before reviewer launch preparation`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const launchCompletionChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-launch-prepared-to-launch-completed',
            reason: `prepared '${reviewType}' launch metadata is ready to be completed with provider-owned invocation evidence`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const reviewInvocationChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-launch-completed-to-invocation',
            reason: `completed '${reviewType}' launch evidence is ready for invocation attestation before review output materialization`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const reviewResultChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'review-invocation-to-result',
            reason: `current '${reviewType}' invocation attestation is ready before review result materialization`,
            preflightPath: preflightCommandPath,
            reviewContextPath: state.contextPath ? toRepoDisplayPath(repoRoot, state.contextPath) : undefined,
            depth: reviewDepth
        });
        const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
            buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
        );
        const stateViolations = state.violations.length > 0
            ? state.violations.join('; ')
            : 'review artifact or receipt is missing';
        const delegatedReadinessRoute = resolveDelegatedReviewDecisionRoute({
            reviewType,
            currentReviewReuseRecorded,
            currentReviewEvidenceSatisfied,
            currentReviewContextInvocationAttested,
            routingCurrent,
            artifactExists: state.artifactExists,
            receiptExists: state.receiptExists,
            reviewFailed: state.failed,
            stateReady: state.ready,
            stateViolationsText: stateViolations,
            reviewerIdentity: state.reviewerIdentity || '',
            contextReviewerIdentity,
            reviewerIdentityIsPlanned,
            launchArtifactState: launchArtifactEvidence.state,
            providerLaunchTargetSummary,
            reviewerReadinessChain,
            reviewRoutingChain,
            launchPreparationChain,
            launchCompletionChain,
            reviewInvocationChain,
            reviewResultChain,
            acceptedVerdictTokens,
            hiddenTimingTrustRemediation: getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state),
            reusedExistingReview: state.reusedExistingReview,
            oneShotLaunchHint,
            instructions: {
                opaqueHandoff: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
                freshContextLaunch: REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
                sessionReuseBoundary: REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION,
                realSubagentOrStop: REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION,
                cleanupAfterReceipt: REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
            },
            commands: {
                recordRouting: buildCommand(
                    'Record fresh delegated review routing',
                    buildReviewRoutingCommand(repoRoot, cliPrefix, taskId, reviewType, routingReviewerIdentity, taskModePath)
                ),
                prepareLaunch: buildCommand(
                    'Prepare delegated reviewer launch metadata',
                    buildPrepareReviewerLaunchCommand(repoRoot, cliPrefix, taskId, reviewType, routingReviewerIdentity, launchArtifactPath, taskModePath)
                ),
                recordDelegationStarted: buildCommand(
                    'Record delegated reviewer start',
                    buildRecordReviewerDelegationStartedCommand({
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity: delegatedReviewerIdentity,
                        launchArtifactPath,
                        launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
                        launchInputArtifactSha256: launchArtifactEvidence.launchInputArtifactSha256 || launchArtifactEvidence.sha256
                    })
                ),
                completeLaunch: buildCommand(
                    'Complete delegated reviewer launch metadata',
                    buildCompleteReviewerLaunchCommand({
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity: delegatedReviewerIdentity,
                        launchArtifactPath,
                        launchInputArtifactPath: launchArtifactEvidence.launchInputArtifactPath,
                        launchInputArtifactSha256: launchArtifactEvidence.launchInputArtifactSha256 || launchArtifactEvidence.sha256,
                        recordInvocation: true
                    })
                ),
                recordInvocation: buildCommand(
                    'Record delegated reviewer launch attestation',
                    buildRecordReviewerInvocationCommand(repoRoot, cliPrefix, taskId, reviewType, reviewerIdentity, launchArtifactPath, taskModePath)
                ),
                recordResult: buildCommand(
                    launchArtifactEvidence.reviewOutputPath
                        ? 'Record delegated review output file, then close reviewer'
                        : 'Pipe delegated review output into stdin, then close reviewer',
                    buildRecordReviewResultCommand(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity,
                        preflightCommandPath,
                        taskModePath,
                        launchArtifactEvidence.reviewOutputPath
                    )
                )
            }
        });
        if (delegatedReadinessRoute) {
            return buildResult({
                ...resultBase,
                status: delegatedReadinessRoute.status,
                nextGate: delegatedReadinessRoute.nextGate,
                title: delegatedReadinessRoute.title,
                reason: delegatedReadinessRoute.reason,
                commands: delegatedReadinessRoute.commands
            });
        }
    }

    const downstreamDependencyRebind = reviewGateAlreadyPassed
        ? null
        : findDownstreamReviewNeedingDependencyRebind({
            eventsRoot,
            taskId,
            requiredReviewTypes,
            requiredReviews: summary.required_reviews,
            policyMode: reviewPolicy.mode,
            reviewStates
        });
    if (downstreamDependencyRebind) {
        const reviewType = downstreamDependencyRebind.downstreamState.reviewType;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            downstreamDependencyRebind.downstreamState,
            (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
        );
        const reviewContextChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'compile-to-review-context',
            reason: `latest upstream '${downstreamDependencyRebind.upstreamReviewType}' review evidence is recorded before re-binding '${reviewType}' review context`,
            preflightPath: preflightCommandPath,
            reviewContextPath: downstreamDependencyRebind.downstreamState.contextPath
                ? toRepoDisplayPath(repoRoot, downstreamDependencyRebind.downstreamState.contextPath)
                : undefined,
            depth: reviewDepth
        });
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const downstreamRebindRoute = resolveDownstreamDependencyRebindRoute({
            reviewPolicyMode: reviewPolicy.mode,
            downstreamReviewType: reviewType,
            upstreamReviewType: downstreamDependencyRebind.upstreamReviewType,
            scopedDiffReadiness,
            reviewerReadinessChain,
            reviewContextChain,
            commands: {
                buildScopedDiff: buildCommand(
                    'Build scoped diff',
                    buildScopedDiffCommand({
                        cliPrefix,
                        reviewType,
                        preflightCommandPath,
                        outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                        metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                    })
                ),
                buildReviewContext: buildCommand(
                    'Build review context',
                    buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                )
            }
        });
        return buildResult({
            ...resultBase,
            status: downstreamRebindRoute.status,
            nextGate: downstreamRebindRoute.nextGate,
            title: downstreamRebindRoute.title,
            reason: downstreamRebindRoute.reason,
            commands: downstreamRebindRoute.commands
        });
    }

    const reviewGateStaleUpstreamRecovery = reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleUpstreamRecovery({
            repoRoot,
            eventsRoot,
            taskId,
            requiredReviewTypes,
            requiredReviews: summary.required_reviews,
            policyMode: reviewPolicy.mode,
            reviewStates
        });
    if (reviewGateStaleUpstreamRecovery) {
        const reviewType = reviewGateStaleUpstreamRecovery.upstreamReviewType;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            reviewGateStaleUpstreamRecovery.upstreamState,
            (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
        );
        const reviewContextChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'compile-to-review-context',
            reason:
                `latest review gate failure seq ${reviewGateStaleUpstreamRecovery.latestReviewGateFailureSequence} ` +
                `rejected stale upstream '${reviewType}' context/routing before downstream ` +
                `'${reviewGateStaleUpstreamRecovery.downstreamReviewType}' closeout validation`,
            preflightPath: preflightCommandPath,
            reviewContextPath: reviewGateStaleUpstreamRecovery.upstreamState.contextPath
                ? toRepoDisplayPath(repoRoot, reviewGateStaleUpstreamRecovery.upstreamState.contextPath)
                : undefined,
            depth: reviewDepth
        });
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const staleUpstreamRecoveryRoute = resolveReviewGateStaleUpstreamRecoveryRoute({
            upstreamReviewType: reviewType,
            reuseCandidateHint: getBuildReviewContextReuseCandidateHint(eventsRoot, taskId, reviewGateStaleUpstreamRecovery.upstreamState),
            scopedDiffReadiness,
            reviewerReadinessChain,
            reviewContextChain,
            commands: {
                buildScopedDiff: buildCommand(
                    'Build scoped diff',
                    buildScopedDiffCommand({
                        cliPrefix,
                        reviewType,
                        preflightCommandPath,
                        outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                        metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                    })
                ),
                buildReviewContext: buildCommand(
                    'Build upstream review context',
                    buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                )
            }
        });
        return buildResult({
            ...resultBase,
            status: staleUpstreamRecoveryRoute.status,
            nextGate: staleUpstreamRecoveryRoute.nextGate,
            title: staleUpstreamRecoveryRoute.title,
            reason: staleUpstreamRecoveryRoute.reason,
            commands: staleUpstreamRecoveryRoute.commands
        });
    }

    const reviewGateStaleContextPrecheckRecovery = reviewGateAlreadyPassed
        ? null
        : findReviewGateStaleContextPrecheckRecovery({
            repoRoot,
            eventsRoot,
            taskId,
            requiredReviewTypes,
            reviewStates
        });
    if (reviewGateStaleContextPrecheckRecovery) {
        const reviewType = reviewGateStaleContextPrecheckRecovery.reviewType;
        const reviewDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
        const reviewerReadinessChain = buildReviewerReadinessChainSummary(
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            reviewGateStaleContextPrecheckRecovery.state,
            (candidateState) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, candidateState)
        );
        const reviewContextChain = buildReviewGateChainStatusSummary({
            repoRoot,
            eventsRoot,
            taskId,
            reviewType,
            edgeId: 'compile-to-review-context',
            reason: `current '${reviewType}' review context must be rebound before required-reviews-check`,
            preflightPath: preflightCommandPath,
            reviewContextPath: reviewGateStaleContextPrecheckRecovery.state.contextPath
                ? toRepoDisplayPath(repoRoot, reviewGateStaleContextPrecheckRecovery.state.contextPath)
                : undefined,
            depth: reviewDepth
        });
        const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.json`);
        const scopedDiffOutputPath = path.join(reviewsRoot, `${taskId}-${reviewType}-scoped.diff`);
        const scopedDiffReadiness = scopedDiffExpectedForReview({
            preflight,
            reviewType
        })
            ? getScopedDiffMetadataReadiness({
                metadataPath: scopedDiffMetadataPath,
                preflight,
                preflightPath,
                preflightSha256,
                reviewType
            })
            : { ready: true, reason: 'Scoped diff metadata is not required for this review context.' };
        const staleContextPrecheckRecoveryRoute = resolveReviewGateStaleContextPrecheckRecoveryRoute({
            reviewType,
            scopedDiffReadiness,
            reviewerReadinessChain,
            reviewContextChain,
            commands: {
                buildScopedDiff: buildCommand(
                    'Build scoped diff',
                    buildScopedDiffCommand({
                        cliPrefix,
                        reviewType,
                        preflightCommandPath,
                        outputPath: toRepoDisplayPath(repoRoot, scopedDiffOutputPath),
                        metadataPath: toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)
                    })
                ),
                buildReviewContext: buildCommand(
                    'Build review context',
                    buildReviewContextCommand(repoRoot, cliPrefix, taskId, reviewType, reviewDepth, preflightCommandPath, taskModePath)
                )
            }
        });
        return buildResult({
            ...resultBase,
            status: staleContextPrecheckRecoveryRoute.status,
            nextGate: staleContextPrecheckRecoveryRoute.nextGate,
            title: staleContextPrecheckRecoveryRoute.title,
            reason: staleContextPrecheckRecoveryRoute.reason,
            commands: staleContextPrecheckRecoveryRoute.commands
        });
    }

    if (preflightRequiresAuditedNoOp(preflight)) {
        const noOpEvidence = getNoOpEvidence(repoRoot, taskId, '', preflightCommandPath);
        if (noOpEvidence.evidence_status !== 'PASS') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-no-op',
                title: 'Record audited zero-diff no-op evidence.',
                reason:
                    'The current preflight is BASELINE_ONLY with no reviewable diff and requires audited no-op evidence before review or completion gates can pass. ' +
                    `Record no-op evidence or implement changes and refresh preflight; current no-op evidence status: ${noOpEvidence.evidence_status}.`,
                commands: [
                    buildCommand(
                        'Record audited no-op evidence',
                        `${cliPrefix} gate record-no-op --task-id "${taskId}" --classification "AUDIT_ONLY" --reason "<why no code changed>" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
    }

    const postReviewCloseoutRoute = resolvePostReviewCloseoutRouteFromState({
        requiredReviewsGatePassed: isGatePassed(summary, 'required-reviews-check'),
        zeroDiffNoReviewCloseout: hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes),
        requiredReviewsCommand: buildRequiredReviewsCheckCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath),
        docImpactGatePassed: isGatePassed(summary, 'doc-impact-gate'),
        docImpactCompatibilityHint: buildDocImpactCompatibilityHint(),
        docImpactCommand: buildDocImpactCommand(
            cliPrefix,
            taskId,
            preflightCommandPath,
            preflight,
            repoRoot,
            effectivePreflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []
        ),
        fullSuiteEnabled: fullSuiteConfig.enabled,
        fullSuiteGatePassed,
        fullSuiteNotRequiredForDocsOnly,
        fullSuitePlacement: fullSuiteConfig.placement,
        fullSuiteConfigPath: fullSuiteSummary.config_path,
        fullSuiteCommandText: fullSuiteConfig.command,
        fullSuiteTimeoutForecastLine,
        fullSuiteCommand,
        projectMemoryRequired: projectMemoryEvidence.required,
        projectMemoryEvidenceCurrent: projectMemoryEvidence.evidence_status === 'CURRENT',
        projectMemoryVisibleSummaryLine: projectMemoryEvidence.visible_summary_line,
        projectMemoryAffectedMemoryFiles: projectMemoryEvidence.affected_memory_files,
        projectMemoryViolations: projectMemoryEvidence.violations,
        projectMemoryCommand: buildProjectMemoryImpactCommand(cliPrefix, taskId, preflightCommandPath, projectMemorySummary),
        completionGatePassed: isGatePassed(summary, 'completion-gate'),
        completionCommand: buildCompletionGateCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
    });

    return buildResult({
        ...resultBase,
        status: postReviewCloseoutRoute.status,
        nextGate: postReviewCloseoutRoute.nextGate,
        title: postReviewCloseoutRoute.title,
        reason: postReviewCloseoutRoute.reason,
        commands: postReviewCloseoutRoute.commands
    });
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    return resolveNextStepDecisionRoute(createNextStepResolutionContext(options));
}


function parseTaskIdFromPreflightPath(preflightPath: string): string | null {
    const basename = path.basename(preflightPath).trim();
    const suffix = '-preflight.json';
    if (!basename.endsWith(suffix)) {
        return null;
    }
    return basename.slice(0, -suffix.length) || null;
}

function pickConsistentTaskId(candidates: Array<{ source: string; value: string | null }>): string {
    const normalized = candidates
        .map((candidate) => ({
            source: candidate.source,
            value: String(candidate.value || '').trim()
        }))
        .filter((candidate) => candidate.value);
    const uniqueValues = [...new Set(normalized.map((candidate) => candidate.value))];
    if (uniqueValues.length > 1) {
        throw new Error(`Conflicting task identifiers for next-step: ${normalized.map((candidate) => `${candidate.source}=${candidate.value}`).join(', ')}.`);
    }
    return uniqueValues[0] || '';
}

export function resolveNextStepFromCliOptions(options: {
    taskId?: unknown;
    repoRoot?: unknown;
    eventsRoot?: unknown;
    reviewsRoot?: unknown;
    preflightPath?: unknown;
    positionals?: unknown;
}): NextStepResult {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const positionals = Array.isArray(options.positionals)
        ? options.positionals.map((value) => String(value || '').trim()).filter(Boolean)
        : [];
    const preflightPathText = String(options.preflightPath || '').trim();
    const resolvedPreflightPath = preflightPathText
        ? resolvePathInsideRepo(preflightPathText, repoRoot, { allowMissing: true })
        : null;
    const taskId = pickConsistentTaskId([
        { source: '--task-id', value: String(options.taskId || '').trim() || null },
        { source: 'positional', value: positionals[0] || null },
        { source: '--preflight-path', value: resolvedPreflightPath ? parseTaskIdFromPreflightPath(resolvedPreflightPath) : null }
    ]);
    const reviewsRoot = options.reviewsRoot
        ? resolvePathInsideRepo(String(options.reviewsRoot), repoRoot, { allowMissing: true })
        : resolvedPreflightPath
            ? path.dirname(resolvedPreflightPath)
        : null;
    const eventsRoot = options.eventsRoot
        ? resolvePathInsideRepo(String(options.eventsRoot), repoRoot, { allowMissing: true })
        : null;
    return resolveNextStep({
        taskId,
        repoRoot,
        eventsRoot,
        reviewsRoot
    });
}
