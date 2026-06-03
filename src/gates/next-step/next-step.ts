import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    getReviewExecutionDependencies,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode,
    type ResolvedReviewExecutionPolicyConfig
} from '../../core/review-execution-policy';
import {
    assertValidTaskId
} from '../../gate-runtime/task-events';
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
    type GateOutcome,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    buildFullSuiteTimeoutForecast,
    formatFullSuiteTimeoutForecast,
    isFullSuiteNotRequiredForDocsOnlyScope,
    isFullSuiteNotRequiredForZeroDiffNoReviewableScope,
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from '../full-suite/full-suite-validation';
import type {
    ReviewTrustSummary
} from '../review/review-trust-summary';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
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
    getProjectMemoryImpactLifecycleEvidence,
    type ProjectMemoryImpactEvidenceStatus,
    type ProjectMemoryImpactStatus
} from '../project-memory-impact/project-memory-impact';
import {
    getNoOpEvidence
} from '../task-mode/no-op';
import {
    getStrictDecompositionDecisionEvidence,
    type StrictDecompositionDecisionEvidenceResult
} from '../task-mode/strict-decomposition-decision';
import {
    selectRulePackFiles
} from '../review-context/review-context-token-economy';
import {
    readOptionalMarkdownWorkingPlan,
    type TaskModeMarkdownWorkingPlanMetadata
} from '../task-mode/task-mode';
import {
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust
} from '../review/review-timing-trust';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from '../preflight/classify-change';
import {
    getPostPreflightRulePackRebindDecision,
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations,
    type PostPreflightRulePackRebindDecision
} from '../rule-pack/rule-pack';
import {
    collectOrderedTimelineEvents
} from '../completion/completion-evidence';
import {
    findLatestTimelineEvent,
    getTimelineEventDetailString
} from './next-step-timeline-readers';
import {
    readStartupCycleReadiness
} from './next-step-startup-readiness';
import {
    resolveNextStepStartupRoute
} from './next-step-startup-routing';
import {
    buildCompileEvidenceDocsOnlyExtensionReadiness,
    describePathList,
    readCompileReadiness,
    readCurrentGitWorkspaceSnapshot,
    readPreflightWorkspaceReadiness,
    stringSha256,
    type PreflightWorkspaceReadiness
} from './next-step-compile-full-suite-readiness';
import {
    buildCoherentCycleRestartCommand
} from '../completion/completion-reporting';
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
    detectSourceCheckoutRuntimeStaleness,
    type SourceCheckoutRuntimeStalenessResult
} from '../../validators';
import {
    buildDefaultReviewScratchCommandPath
} from '../review/review-scratch-paths';
import {
    isTaskQueueDecomposedStatus,
    isTaskQueueDoneStatus,
    isTaskQueueSplitRequiredStatus
} from '../../core/active-task-state';
import {
    restoreSplitRequiredParentFromPermanentLatch,
    transitionDecomposedParentsToDone,
    transitionSplitRequiredParentToDecomposed,
    transitionStrictDecompositionParentToDecomposed
} from './next-step-task-queue-transitions';
import {
    buildGateChainLaunchDecision,
    formatGateChainLaunchDecision
} from '../../core/dependent-validation-chains';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../../core/task-queue-status-contract';
import {
    extractExplicitLinkedChildTaskIds,
    formatStrictDecompositionSplitRoutingViolations,
    hasLinkedChildTasks,
    isDecomposedParentTask,
    parseTaskQueueEntriesFromContent,
    resolveDecomposedParentCompletionState,
    resolveNextUnfinishedChildRoute,
    resolveStrictDecompositionSplitRoutingState,
    type TaskQueueEntry
} from './next-step-task-queue';
import {
    buildNextStepCoreArtifactSpecs,
    fullSuiteArtifactMatchesCurrentCycle,
    hasAcceptedDocsOnlyFullSuiteSkipArtifact,
    readNextStepReadinessArtifacts
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
    shouldRunFullSuiteAfterCompileBeforeReviews,
    shouldRunFullSuiteBeforeTestReview,
    toNextStepBlockedReviewLanes
} from './next-step-review-launch-planner';
import {
    resolveDelegatedReviewReadinessRoute
} from './next-step-review-readiness-routing';
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
    resolveReviewGateStaleUpstreamRecoveryRoute,
    resolveStrictSequentialUpstreamReuseRoute
} from './next-step-review-reuse-routing';
import {
    resolveCompletedCloseoutRoute,
    resolvePostReviewCloseoutRoute
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
    resolveDecomposedParentTerminalRoute,
    resolveDoneTaskQueueTerminalRoute,
    resolvePermanentSplitRequiredLatchRoute,
    resolveSplitRequiredTaskQueueRoute,
    resolveStrictDecompositionSplitTerminalRoute
} from './next-step-terminal-status-routing';
import {
    hasCompletedDecomposedParentAfterSplitRequiredClear,
    hasSplitRequiredClearedEvidence,
    isSuccessfulSplitRequiredStatusSync,
    materializeSplitRequiredLatch,
    readSplitRequiredLatchEvidence,
    sanitizeScopeBudgetGuardSummary,
    type SplitRequiredLatchResult
} from './next-step-split-required-latch';
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
    buildReviewPhaseCommand,
    buildReviewRoutingCommand,
    buildScopedDiffCommand,
    buildTaskModePathCommandParts
} from './next-step-review-command-builders';

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
}

export interface NextStepProjectMemorySummary {
    enabled: boolean;
    required: boolean;
    mode: string;
    evidence_status: ProjectMemoryImpactEvidenceStatus;
    status: ProjectMemoryImpactStatus | null;
    update_needed: boolean | null;
    affected_memory_files: string[];
    updated_memory_files: string[];
    compact_status: string | null;
    compact_refreshed: boolean | null;
    artifact_path: string;
    update_artifact_path: string;
    visible_summary_line: string;
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
    warnings: string[];
    invalidation_impact: NextStepInvalidationImpactSummary | null;
    review_cycle_block: NextStepReviewCycleBlock | null;
    final_report: NextStepFinalReportSummary | null;
}


interface NextStepOptions {
    taskId: string;
    repoRoot: string;
    eventsRoot?: string | null;
    reviewsRoot?: string | null;
}

interface ArtifactSpec {
    key: string;
    path: string;
}

interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightCycleReadinessOptions {
    allowStaleCompletionFailureForDocCloseout?: boolean;
    staleCompletionFailureDocCloseoutReason?: string;
}

interface FailedGateRecovery {
    nextGate: string;
    title: string;
    reason: string;
    label: string;
    command: string;
}

interface RulePackReadiness {
    ready: boolean;
    reason: string;
    rebind: PostPreflightRulePackRebindDecision | null;
}

interface CoherentCycleReadiness {
    ready: boolean;
    reason: string;
    command: string | null;
}

const COHERENT_CYCLE_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_FAILED',
    'COMPLETION_GATE_PASSED'
]);

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

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
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

function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

function readTaskTimelineEventLikes(eventsRoot: string, taskId: string): ReviewReuseTelemetryEventLike[] {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return [];
    }
    const events: ReviewReuseTelemetryEventLike[] = [];
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as ReviewReuseTelemetryEventLike);
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return events;
}

function timelineHasDelegatedReviewInvocationAttestation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (state.reusedExistingReview) {
        return false;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return false;
    }
    const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
        repoRoot,
        eventsRoot,
        taskId,
        state
    );
    if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null || state.reviewerProvenance.task_sequence <= latestCompileSequence) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const reviewTreeStateSha256 = String(details.review_tree_state_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            const launchArtifactSha256 = String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== String(state.reviewerProvenance.review_context_sha256 || '').trim().toLowerCase()
                || reviewTreeStateSha256 !== expectedReviewTreeStateSha256
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
                || launchArtifactSha256 !== reviewerLaunchArtifactEvidence.sha256
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasHistoricalDelegatedReviewInvocationAttestation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (state.reusedExistingReview) {
        return false;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const expectedReviewContextSha256 = state.receiptReviewContextSha256;
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        !expectedReviewContextSha256
        || !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_context_sha256 !== expectedReviewContextSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const reviewTreeStateSha256 = String(details.review_tree_state_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== expectedReviewContextSha256
                || reviewTreeStateSha256 !== expectedReviewTreeStateSha256
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasReviewReuseRecordedAfterCompile(eventsRoot: string, taskId: string, state: ReviewArtifactState): boolean {
    if (
        !state.reusedExistingReview
        || !state.receiptExists
        || !state.contextExists
        || (!state.contextCurrent && !state.domainScopeCurrent)
        || !state.artifactExists
    ) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const reviewArtifactSha256 = fileSha256(state.artifactPath);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (!reviewContextSha256 || !reviewArtifactSha256 || latestCompileSequence == null) {
        return false;
    }
    const repoRoot = path.resolve(eventsRoot, '..', '..', '..');
    const validation = validateStrictReusedReviewEvidence({
        repoRoot,
        taskId,
        reviewType: state.reviewType,
        events: readTaskTimelineEventLikes(eventsRoot, taskId),
        receiptPath: state.receiptPath,
        reviewContextSha256,
        reviewContextReuseSha256: state.receiptReviewContextReuseSha256,
        reviewTreeStateSha256: state.receiptReviewTreeStateSha256,
        reviewScopeSha256: state.receiptReviewScopeSha256,
        codeScopeSha256: state.receiptCodeScopeSha256,
        reviewArtifactSha256,
        reusedFromReceiptPath: state.reusedFromReceiptPath,
        reusedFromReceiptSha256: state.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: state.reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256: state.reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256: state.reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256: state.reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256: state.reusedFromCodeScopeSha256,
        reviewerExecutionMode: state.reviewerProvenance?.reviewer_execution_mode || null,
        reviewerIdentity: state.reviewerIdentity,
        reviewerProvenance: state.reviewerProvenance as unknown as Record<string, unknown> | null,
        latestCompileTaskSequence: latestCompileSequence
    });
    return validation.valid;
}

function buildReviewGateChainStatusSummary(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    edgeId: string;
    status?: 'pass' | 'block';
    reason: string;
    preflightPath: string;
    reviewContextPath?: string;
    depth?: number | string;
}): string {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const decision = buildGateChainLaunchDecision({
        edgeId: options.edgeId,
        status: options.status || 'pass',
        reason: options.reason,
        context: {
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPath: options.preflightPath,
            reviewContextPath: options.reviewContextPath,
            depth: options.depth,
            repoRoot: '.'
        },
        evidencePaths: [
            toRepoDisplayPath(options.repoRoot, timelinePath)
        ]
    });
    return (
        `${formatGateChainLaunchDecision(decision)} ` +
        'LaneScope=review_type; independent review lanes remain eligible when their own prerequisites are current.'
    );
}

function timelineHasReviewContextPreparedAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    contextPath: string
): boolean {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const expectedContextPath = normalizePath(contextPath).toLowerCase();
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEW_PHASE_STARTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const eventReviewType = String(details.review_type || details.reviewType || '').trim();
            const outputPath = normalizePath(details.output_path || details.outputPath || '').toLowerCase();
            if (eventReviewType === reviewType && outputPath === expectedContextPath) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function reviewStateHasSatisfiedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.ready) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.domainScopeCurrent && !state.reusedExistingReview) {
        return timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot, taskId, state);
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getHiddenReviewTimingTrustRemediation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): string | null {
    const timelineEvents = readTaskTimelineEventLikes(eventsRoot, taskId);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    const timingTrust = evaluateHiddenReviewTimingTrust({
        reviewType: state.reviewType,
        reusedExistingReview: state.reusedExistingReview,
        reviewerProvenance: state.reviewerProvenance,
        reviewResultRecordedAtUtc: state.reviewResultRecordedAtUtc,
        recordedAtUtc: state.recordedAtUtc,
        reviewOutputSourceMtimeUtc: state.reviewOutputSourceMtimeUtc,
        timelineEvents,
        latestCompileSequence
    });
    return timingTrust.trusted ? null : timingTrust.message;
}

function isReviewFailTokenViolation(state: ReviewArtifactState, violation: string): boolean {
    return Boolean(
        state.failed
        && state.failToken
        && violation.includes(`review artifact contains fail token '${state.failToken}'`)
    );
}

function reviewStateHasCurrentRecordedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.contextExists || !state.artifactExists || !state.receiptExists) {
        return false;
    }
    const nonVerdictViolations = state.violations.filter(
        (violation) => !isReviewFailTokenViolation(state, violation)
    );
    if (nonVerdictViolations.length > 0) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.domainScopeCurrent && !state.reusedExistingReview && !state.failed) {
        return timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot, taskId, state);
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getTimelineEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
        ? event.integrity as Record<string, unknown>
        : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function getLatestReviewEventSequence(
    events: readonly ReviewReuseTelemetryEventLike[],
    eventType: string,
    reviewType: string
): number | null {
    const normalizedEventType = eventType.trim().toUpperCase();
    const normalizedReviewType = reviewType.trim().toLowerCase();
    let latestSequence: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== normalizedEventType) {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        const currentReviewType = String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase();
        if (currentReviewType !== normalizedReviewType) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}

function findStrictSequentialUpstreamNeedingCurrentCycleReuse(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    targetReviewType: string;
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
    latestCompileSequence?: number | null;
}): { upstreamState: ReviewArtifactState; upstreamReviewType: string; latestCompileSequence: number } | null {
    if (params.policyMode !== 'strict_sequential') {
        return null;
    }
    const latestCompileSequence = params.latestCompileSequence ?? getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null) {
        return null;
    }
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    const upstreamReviewTypes = getReviewExecutionDependencies(
        params.targetReviewType,
        params.requiredReviews,
        params.policyMode
    );
    for (const upstreamReviewType of upstreamReviewTypes) {
        const upstreamState = stateByReviewType.get(upstreamReviewType);
        if (
            !upstreamState?.ready
            || !upstreamState.domainScopeCurrent
            || upstreamState.failed
        ) {
            continue;
        }
        if (
            upstreamState.reusedExistingReview
            && timelineHasReviewReuseRecordedAfterCompile(params.eventsRoot, params.taskId, upstreamState)
        ) {
            continue;
        }
        const upstreamRecordedSequence = getLatestReviewEventSequence(
            timelineEvents,
            'REVIEW_RECORDED',
            upstreamReviewType
        );
        if (
            !upstreamState.reusedExistingReview
            && upstreamRecordedSequence != null
            && upstreamRecordedSequence > latestCompileSequence
        ) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && upstreamState.contextCurrent) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && !reviewStateHasSatisfiedEvidence(
            params.repoRoot,
            params.eventsRoot,
            params.taskId,
            upstreamState
        )) {
            continue;
        }
        return {
            upstreamState,
            upstreamReviewType,
            latestCompileSequence
        };
    }
    return null;
}

function findReviewGateStaleUpstreamRecovery(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamReviewType: string; upstreamState: ReviewArtifactState; upstreamReviewType: string; latestReviewGateFailureSequence: number } | null {
    const latestReviewGateFailureSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_FAILED']
    );
    if (latestReviewGateFailureSequence == null) {
        return null;
    }
    const latestReviewGatePassSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
    );
    if (latestReviewGatePassSequence != null && latestReviewGatePassSequence > latestReviewGateFailureSequence) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null || latestReviewGateFailureSequence <= latestCompileSequence) {
        return null;
    }
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const downstreamReviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(downstreamReviewType);
        if (!downstreamState || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, downstreamState)) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            downstreamReviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamState = stateByReviewType.get(upstreamReviewType);
            if (
                !upstreamState
                || !upstreamState.ready
                || !upstreamState.domainScopeCurrent
                || upstreamState.reusedExistingReview
                || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, upstreamState)
            ) {
                continue;
            }
            return {
                downstreamReviewType,
                upstreamState,
                upstreamReviewType,
                latestReviewGateFailureSequence
            };
        }
    }
    return null;
}

function findDownstreamReviewNeedingDependencyRebind(params: {
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamState: ReviewArtifactState; upstreamReviewType: string } | null {
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    if (timelineEvents.length === 0) {
        return null;
    }
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const reviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(reviewType);
        if (!downstreamState?.ready || !downstreamState.contextExists) {
            continue;
        }
        const downstreamRebindSequence = getLatestDownstreamReviewRebindSequence(timelineEvents, downstreamState);
        if (downstreamRebindSequence == null) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            reviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamRecordedSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_RECORDED', upstreamReviewType);
            if (upstreamRecordedSequence != null && upstreamRecordedSequence > downstreamRebindSequence) {
                return { downstreamState, upstreamReviewType };
            }
        }
    }
    return null;
}

function getLatestDownstreamReviewRebindSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const reviewPhaseSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_PHASE_STARTED', state.reviewType);
    const reuseAcceptedSequence = getLatestReviewContextReuseAcceptedSequence(timelineEvents, state);
    if (reviewPhaseSequence == null) {
        return reuseAcceptedSequence;
    }
    if (reuseAcceptedSequence == null) {
        return reviewPhaseSequence;
    }
    return Math.max(reviewPhaseSequence, reuseAcceptedSequence);
}

function getLatestReviewContextReuseAcceptedSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const expectedContextPath = normalizePath(state.contextPath).toLowerCase();
    let latestSequence: number | null = null;
    for (const event of timelineEvents) {
        if (event.event_type !== 'REVIEW_CONTEXT_REUSE_ACCEPTED') {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewType = String(details.review_type || details.reviewType || '').trim();
        if (eventReviewType !== state.reviewType || details.current_pass_review_evidence !== true) {
            continue;
        }
        const outputPath = normalizePath(
            details.output_path || details.outputPath || details.review_context_path || details.reviewContextPath || ''
        ).toLowerCase();
        if (!outputPath || outputPath !== expectedContextPath) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence == null) {
            continue;
        }
        latestSequence = latestSequence == null
            ? sequence
            : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}

function hasPassedDocImpactArtifact(docImpactPath: string | null | undefined): boolean {
    if (!docImpactPath) {
        return false;
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return false;
    }
    return String(docImpact.status || '').trim().toUpperCase() === 'PASSED'
        && String(docImpact.outcome || '').trim().toUpperCase() === 'PASS';
}

function docImpactTimelineDetailsMatchArtifact(
    details: Record<string, unknown> | null,
    docImpact: Record<string, unknown>,
    taskId: string,
    preflightPath: string,
    preflightSha256: string
): boolean {
    if (!details) {
        return false;
    }
    const expectedDocsUpdated = Array.isArray(docImpact.docs_updated)
        ? docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    const actualDocsUpdated = Array.isArray(details.docs_updated)
        ? details.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean).sort()
        : [];
    return String(details.task_id || '').trim() === taskId
        && normalizePath(String(details.preflight_path || '').trim()) === normalizePath(preflightPath)
        && String(details.preflight_hash_sha256 || '').trim().toLowerCase() === preflightSha256
        && String(details.decision || '').trim().toUpperCase() === String(docImpact.decision || '').trim().toUpperCase()
        && String(details.status || '').trim().toUpperCase() === String(docImpact.status || '').trim().toUpperCase()
        && String(details.outcome || '').trim().toUpperCase() === String(docImpact.outcome || '').trim().toUpperCase()
        && details.behavior_changed === docImpact.behavior_changed
        && details.changelog_updated === docImpact.changelog_updated
        && details.internal_changelog_updated === docImpact.internal_changelog_updated
        && details.project_memory_updated === docImpact.project_memory_updated
        && stringSha256(actualDocsUpdated.join('\n')) === stringSha256(expectedDocsUpdated.join('\n'));
}

function getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    docImpactPath: string | null | undefined
): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact) {
        return [];
    }
    if (String(docImpact.task_id || '').trim() !== taskId) {
        return [];
    }
    const evidencePreflightPath = normalizePath(String(docImpact.preflight_path || '').trim());
    const expectedPreflightPath = normalizePath(preflightPath);
    if (!evidencePreflightPath || evidencePreflightPath !== expectedPreflightPath) {
        return [];
    }
    const evidencePreflightHash = String(docImpact.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!preflightSha256 || !evidencePreflightHash || evidencePreflightHash !== preflightSha256) {
        return [];
    }
    const decision = String(docImpact.decision || '').trim().toUpperCase();
    const status = String(docImpact.status || '').trim().toUpperCase();
    const outcome = String(docImpact.outcome || '').trim().toUpperCase();
    if (
        decision !== 'DOCS_UPDATED'
        || status !== 'PASSED'
        || outcome !== 'PASS'
        || docImpact.behavior_changed !== false
    ) {
        return [];
    }
    const docsUpdated = Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    if (docsUpdated.length === 0) {
        return [];
    }
    const classificationConfig = getClassificationConfig(repoRoot);
    if (docsUpdated.some((entry) => !isOrdinaryDocumentationDeltaPath(entry, classificationConfig))) {
        return [];
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return [];
    }
    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    const latestDocImpactAssessed = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'DOC_IMPACT_ASSESSED'
    );
    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (
        !latestPreflight
        || !latestDocImpactAssessed
        || !latestCompletionFailure
        || !docImpactTimelineDetailsMatchArtifact(
            latestDocImpactAssessed.details,
            docImpact,
            taskId,
            preflightPath,
            preflightSha256
        )
        || latestDocImpactAssessed.sequence < latestPreflight.sequence
        || latestDocImpactAssessed.sequence < latestCompletionFailure.sequence
    ) {
        return [];
    }
    return docsUpdated;
}

function buildStaleCompletionFailureDocCloseoutAllowance(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightWorkspaceReadiness: PreflightWorkspaceReadiness,
    docImpactPath: string
): PreflightCycleReadinessOptions {
    if (!preflightWorkspaceReadiness.ready) {
        return {};
    }
    if (hasPassedDocImpactArtifact(docImpactPath)) {
        const docImpactUpdatedFiles = getPassedOrdinaryDocsOnlyDocImpactUpdatedFiles(
            repoRoot,
            eventsRoot,
            taskId,
            preflightPath,
            preflightSha256,
            docImpactPath
        );
        if (docImpactUpdatedFiles.length > 0) {
            return {
                allowStaleCompletionFailureForDocCloseout: true,
                staleCompletionFailureDocCloseoutReason:
                    `latest doc-impact evidence records ordinary documentation updates ${describePathList(docImpactUpdatedFiles)} with behavior_changed=false`
            };
        }
        return {};
    }
    const acceptedDeltaFiles = [
        ...(preflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []),
        ...(preflightWorkspaceReadiness.acceptedCloseoutOnlyDeltaFiles || [])
    ];
    if (acceptedDeltaFiles.length > 0) {
        return {
            allowStaleCompletionFailureForDocCloseout: true,
            staleCompletionFailureDocCloseoutReason:
                `current workspace drift is limited to ordinary documentation/closeout updates ${describePathList(acceptedDeltaFiles)}`
        };
    }
    return {};
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string,
    options: PreflightCycleReadinessOptions = {}
): PreflightCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestPreflight = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'PREFLIGHT_CLASSIFIED'
    );
    if (!latestPreflight) {
        return {
            ready: true,
            reason: 'No PREFLIGHT_CLASSIFIED event exists yet.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (latestTaskMode && latestPreflight.sequence < latestTaskMode.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest TASK_MODE_ENTERED event (preflight seq ${latestPreflight.sequence}, task-mode seq ${latestTaskMode.sequence}). Refresh classify-change for the current task-mode cycle.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED'
    );
    if (latestShellSmoke && latestPreflight.sequence < latestShellSmoke.sequence) {
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest SHELL_SMOKE_PREFLIGHT_RECORDED event (preflight seq ${latestPreflight.sequence}, shell-smoke seq ${latestShellSmoke.sequence}). Refresh classify-change before compile/review/completion.`
        };
    }

    const latestCompletionFailure = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'COMPLETION_GATE_FAILED'
    );
    if (latestCompletionFailure && latestPreflight.sequence < latestCompletionFailure.sequence) {
        if (options.allowStaleCompletionFailureForDocCloseout) {
            return {
                ready: true,
                reason:
                    `Preflight evidence predates latest COMPLETION_GATE_FAILED (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}), ` +
                    `but the closeout lane remains current because ${options.staleCompletionFailureDocCloseoutReason || 'only ordinary documentation closeout evidence changed'}.`
            };
        }
        return {
            ready: false,
            reason: `Preflight evidence is older than the latest COMPLETION_GATE_FAILED event (preflight seq ${latestPreflight.sequence}, completion failure seq ${latestCompletionFailure.sequence}). Refresh classify-change for the resumed cycle.`
        };
    }

    return {
        ready: true,
        reason: 'Preflight evidence is current for the latest startup cycle.'
    };
}

function readPostPreflightRulePackReadiness(
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

function readFailedGateRecovery(
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
    if (!hasProtectedOrchestratorWorkRecoverySignal(errorText)) {
        return null;
    }
    if (isGardaSelfGuardDenyAgentEntry(repoRoot)) {
        return {
            nextGate: 'operator-maintenance',
            title: 'Garda self-guard blocks agent-owned protected control-plane recovery.',
            reason:
                `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected control-plane recovery signal. ` +
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
        title: 'Recover failed classify-change as orchestrator work.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected control-plane recovery signal. ` +
            'Run the deterministic recovery command rebuilt from current task-mode and workspace state before reclassifying, after fresh operator approval for protected task-mode entry.',
        label: 'Restart task mode with orchestrator work',
        command: buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode, currentChangedFiles)
    };
}

function getDefaultCommandsPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/40-commands.md'));
}

function getDefaultOutputFiltersPath(repoRoot: string): string {
    return path.resolve(repoRoot, buildBundleRelativePath(repoRoot, 'live/config/output-filters.json'));
}

function readCoherentCycleReadiness(
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
    const cycleAnchor = latestBoundary
        ? ` after latest ${latestBoundary.event_type} (seq ${latestBoundary.sequence})`
        : '';

    return {
        ready: false,
        reason: `Latest PREFLIGHT_CLASSIFIED (seq ${latestPreflight.sequence}) is not in a coherent preflight cycle${cycleAnchor}: ${violations.join('; ')}. Run restart-coherent-cycle before compile/review/completion so completion-gate does not fail on stage sequence.`,
        command: buildCoherentCycleRestartCommand(
            repoRoot,
            taskId,
            normalizePath(preflightPath),
            taskModePath,
            commandsPath,
            outputFiltersPath
        )
    };
}

function resolveActiveTaskModeArtifactPath(
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

function resolveDefaultDepthFromTaskQueue(taskEntry: TaskQueueEntry | null): string {
    const profile = String(taskEntry?.profile || '').trim().toLowerCase();
    if (profile === 'fast' || profile === 'docs-only') {
        return '1';
    }
    return '2';
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

function quoteProviderForCommand(provider: string | null): string {
    if (provider) {
        return quoteCommandValue(provider);
    }
    return process.platform === 'win32'
        ? '"$env:GARDA_EXECUTION_PROVIDER"'
        : '"$GARDA_EXECUTION_PROVIDER"';
}

function buildEnterTaskModeCommand(
    cliPrefix: string,
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    provider: string | null
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        '--entry-mode "EXPLICIT_TASK_EXECUTION"',
        `--requested-depth ${quoteCommandValue(resolveDefaultDepthFromTaskQueue(taskEntry))}`,
        `--task-summary ${quoteCommandValue(taskEntry?.title || taskId)}`
    ];
    parts.push(`--provider ${quoteProviderForCommand(provider)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function requiresSensitiveScopeDocAcknowledgement(preflight: Record<string, unknown> | null): boolean {
    const triggers = getPreflightTriggers(preflight);
    return ['api', 'security', 'infra', 'dependency', 'db'].some((trigger) => triggers[trigger] === true);
}

function getPreflightChangedFiles(preflight: Record<string, unknown> | null): string[] {
    return Array.isArray(preflight?.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function isChangelogPath(filePath: string): boolean {
    return /(^|\/)CHANGELOG/i.test(normalizePath(filePath));
}

function getDocImpactChangedFiles(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): string[] {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).filter((filePath) => (
        isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
        && !isRuntimeCodeLikePath(filePath, classificationConfig.code_like_regexes, classificationConfig.runtime_roots)
    ));
}

function hasNonDocumentationPreflightScope(
    preflight: Record<string, unknown> | null,
    repoRoot: string
): boolean {
    const classificationConfig = getClassificationConfig(repoRoot);
    return getPreflightChangedFiles(preflight).some((filePath) => (
        !isDocumentationLikePath(filePath, classificationConfig.ordinary_doc_paths)
    ));
}

function shouldDefaultDocImpactBehaviorChanged(
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    docsUpdated: string[]
): boolean {
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    if (!changelogUpdated) {
        return false;
    }
    return hasNonDocumentationPreflightScope(preflight, repoRoot);
}

function buildDocImpactCommand(
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    preflight: Record<string, unknown> | null,
    repoRoot: string,
    additionalDocsUpdated: string[] = []
): string {
    const docsUpdated = [...new Set([
        ...getDocImpactChangedFiles(preflight, repoRoot),
        ...additionalDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean)
    ])].sort();
    const changelogUpdated = docsUpdated.some((filePath) => isChangelogPath(filePath));
    const behaviorChanged = shouldDefaultDocImpactBehaviorChanged(preflight, repoRoot, docsUpdated);
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push(`--behavior-changed ${behaviorChanged ? 'true' : 'false'}`);
        for (const docPath of docsUpdated) {
            parts.push(`--docs-updated ${quoteCommandValue(docPath)}`);
        }
        parts.push(`--changelog-updated ${changelogUpdated ? 'true' : 'false'}`);
    } else {
        parts.push('--decision "NO_DOC_UPDATES"');
        parts.push('--behavior-changed false');
        parts.push('--changelog-updated false');
    }
    if (requiresSensitiveScopeDocAcknowledgement(preflight)) {
        parts.push('--sensitive-scope-reviewed true');
    }
    parts.push(docsUpdated.length > 0
        ? behaviorChanged
            ? '--rationale "Changelog and implementation files changed in the current preflight; recording documentation impact as behavior-changing by default. Adjust only if the changelog entry is not user-visible behavior."'
            : '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function buildDocImpactCompatibilityHint(): string {
    return [
        'Compatible doc-impact choices:',
        'no user-facing docs -> --decision "NO_DOC_UPDATES" --behavior-changed false --changelog-updated false;',
        'docs only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated false plus --docs-updated for each user-facing doc;',
        'changelog/docs maintenance only -> --decision "DOCS_UPDATED" --behavior-changed false --changelog-updated true plus --docs-updated "CHANGELOG.md";',
        'changelog plus implementation scope -> next-step defaults to --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true;',
        'behavior changed -> --decision "DOCS_UPDATED" --behavior-changed true --changelog-updated true plus docs/changelog evidence.'
    ].join(' ');
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

function isLatestCompletionCurrent(eventsRoot: string, taskId: string): boolean {
    const latestCompletionSequence = getLatestTimelineSequence(eventsRoot, taskId, 'COMPLETION_GATE_PASSED');
    if (latestCompletionSequence == null) {
        return false;
    }
    const latestTaskModeSequence = getLatestTimelineSequence(eventsRoot, taskId, 'TASK_MODE_ENTERED');
    return latestTaskModeSequence == null || latestCompletionSequence >= latestTaskModeSequence;
}

function getStringField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const rawValue = source?.[field];
    const value = typeof rawValue === 'string' ? rawValue.trim() : '';
    return value || fallback;
}

function getNumberField(source: Record<string, unknown> | null, field: string, fallback: string): string {
    const value = source?.[field];
    return Number.isInteger(value) ? String(value) : fallback;
}

function buildOrchestratorWorkRestartCommand(
    cliPrefix: string,
    taskId: string,
    taskMode: Record<string, unknown> | null,
    additionalPlannedChangedFiles: string[] = []
): string {
    const parts = [
        `${cliPrefix} gate enter-task-mode`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--entry-mode ${quoteCommandValue(getStringField(taskMode, 'entry_mode', 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quoteCommandValue(getNumberField(taskMode, 'requested_depth', '<1|2|3>'))}`,
        `--task-summary ${quoteCommandValue(getStringField(taskMode, 'task_summary', '<TASK.md summary>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
    const startBanner = getStringField(taskMode, 'start_banner', '');
    if (startBanner) {
        parts.push(`--start-banner ${quoteCommandValue(startBanner)}`);
    }
    const routedTo = getStringField(taskMode, 'routed_to', '');
    if (routedTo) {
        parts.push(`--routed-to ${quoteCommandValue(routedTo)}`);
    }
    parts.push('--orchestrator-work');
    const plannedChangedFiles = Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const mergedPlannedChangedFiles = [...new Set([
        ...plannedChangedFiles,
        ...additionalPlannedChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean)
    ])].sort();
    for (const plannedChangedFile of mergedPlannedChangedFiles) {
        parts.push(`--planned-changed-file ${quoteCommandValue(plannedChangedFile)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function isGardaSelfGuardDenyAgentEntry(repoRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        isOrchestratorSourceCheckout(repoRoot),
        resolveBundleRootForNextStep(repoRoot)
    );
}

function getTaskModePlannedChangedFiles(taskMode: Record<string, unknown> | null): string[] {
    return Array.isArray(taskMode?.planned_changed_files)
        ? taskMode.planned_changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
}

function getPreflightRefreshChangedFiles(
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null
): string[] {
    const plannedChangedFiles = getTaskModePlannedChangedFiles(taskMode);
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    const explicitPreflightChangedFiles = detectionSource === 'explicit_changed_files'
        ? getPreflightChangedFiles(preflight)
        : [];
    if (plannedChangedFiles.length > 0 || explicitPreflightChangedFiles.length > 0) {
        return [...new Set([
            ...plannedChangedFiles,
            ...explicitPreflightChangedFiles
        ])].sort();
    }
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

function buildClassifyChangeCommand(params: {
    repoRoot: string;
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
    taskModePath: string | null;
    preflightCommandPath: string;
    includePlannedScope: boolean;
    changedFiles?: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate classify-change`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--task-intent ${quoteCommandValue(getStringField(params.taskMode, 'task_summary', '<task summary>'))}`
    ];
    const changedFiles = params.changedFiles || (params.includePlannedScope
        ? getTaskModePlannedChangedFiles(params.taskMode)
        : []);
    for (const changedFile of changedFiles) {
        parts.push(`--changed-file ${quoteCommandValue(changedFile)}`);
    }
    parts.push(...buildTaskModePathCommandParts(params.repoRoot, params.taskId, params.taskModePath));
    parts.push(`--output-path ${quoteCommandValue(params.preflightCommandPath)}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
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

const STRICT_DECOMPOSITION_STRONG_RISK_TERMS = Object.freeze([
    'strict-decomposition',
    'decomposition',
    'decompose',
    'split-required',
    'split required',
    'scope-budget',
    'review-cycle',
    'umbrella',
    'parent-derived',
    'next-step',
    'large strict',
    'broad strict'
]);
const STRICT_DECOMPOSITION_LOW_RISK_TERMS = Object.freeze([
    'tiny',
    'small',
    'local',
    'one-line',
    'single file',
    'typo',
    'wording',
    'copy'
]);
const STRICT_DECOMPOSITION_CHANGED_FILE_THRESHOLD = 3;
const STRICT_DECOMPOSITION_CHANGED_LINE_THRESHOLD = 120;
const STRICT_DECOMPOSITION_REVIEW_COUNT_THRESHOLD = 2;

interface StrictDecompositionDecisionRequirement {
    required: boolean;
    taskSummary: string;
    riskSignals: string[];
}

function normalizeStrictDecompositionSearchText(...values: Array<string | null | undefined>): string {
    return values
        .map((value) => String(value || '').trim().toLowerCase())
        .filter(Boolean)
        .join(' ');
}

function containsStrictDecompositionTerm(text: string, term: string): boolean {
    return text.includes(term);
}

function getStrictDecompositionDecisionTaskSummary(
    taskId: string,
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): string {
    return getStringField(taskMode, 'task_summary', taskEntry?.title || taskId);
}

function isStrictProfileSelected(
    taskEntry: TaskQueueEntry | null,
    profileSummary: NextStepProfileSummary | null
): boolean {
    const profile = String(
        profileSummary?.effective_profile
        || profileSummary?.task_selected_profile
        || taskEntry?.profile
        || ''
    ).trim().toLowerCase();
    return profile === 'strict';
}

function getPreflightMetricNumber(
    preflight: Record<string, unknown> | null,
    field: string
): number | null {
    const metrics = isPlainRecord(preflight?.metrics) ? preflight.metrics : {};
    return parseOptionalNumberField(metrics[field]);
}

function getPreflightChangedFilesCount(preflight: Record<string, unknown> | null): number {
    return getPreflightMetricNumber(preflight, 'changed_files_count')
        ?? getPreflightChangedFiles(preflight).length;
}

function collectStrictDecompositionTaskRiskSignals(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const text = taskEntry
        ? normalizeStrictDecompositionSearchText(taskEntry.area, taskEntry.title, taskEntry.notes)
        : normalizeStrictDecompositionSearchText(getStringField(taskMode, 'task_summary', ''));
    return STRICT_DECOMPOSITION_STRONG_RISK_TERMS
        .filter((term) => containsStrictDecompositionTerm(text, term))
        .map((term) => `task_text:${term}`);
}

function collectStrictDecompositionPreflightRiskSignals(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): string[] {
    if (!preflight) {
        return [];
    }

    const signals: string[] = [];
    const changedFilesCount = getPreflightChangedFilesCount(preflight);
    const changedLinesTotal = getPreflightMetricNumber(preflight, 'changed_lines_total') ?? 0;
    if (changedFilesCount >= STRICT_DECOMPOSITION_CHANGED_FILE_THRESHOLD) {
        signals.push(`changed_files_count=${changedFilesCount}`);
    }
    if (changedLinesTotal >= STRICT_DECOMPOSITION_CHANGED_LINE_THRESHOLD) {
        signals.push(`changed_lines_total=${changedLinesTotal}`);
    }
    if (requiredReviewTypes.length >= STRICT_DECOMPOSITION_REVIEW_COUNT_THRESHOLD) {
        signals.push(`required_reviews=${requiredReviewTypes.join(',')}`);
    }

    const scopeCategory = String(preflight.scope_category || '').trim().toLowerCase();
    if (scopeCategory === 'mixed') {
        signals.push('scope_category=mixed');
    }

    const triggers = getPreflightTriggers(preflight);
    for (const triggerName of ['api', 'security', 'infra', 'dependency', 'db', 'performance']) {
        if (triggers[triggerName] === true) {
            signals.push(`trigger:${triggerName}`);
        }
    }
    if (
        triggers.protected_control_plane_changed === true
        || (Array.isArray(triggers.changed_protected_files) && triggers.changed_protected_files.length > 0)
    ) {
        signals.push('trigger:protected-control-plane');
    }
    return signals;
}

function hasTinyStrictDecompositionExemption(
    taskEntry: TaskQueueEntry | null,
    taskMode: Record<string, unknown> | null,
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[],
    taskRiskSignals: string[]
): boolean {
    if (taskRiskSignals.length > 0) {
        return false;
    }
    const text = taskEntry
        ? normalizeStrictDecompositionSearchText(taskEntry.area, taskEntry.title, taskEntry.notes)
        : normalizeStrictDecompositionSearchText(getStringField(taskMode, 'task_summary', ''));
    const hasLowRiskTerm = STRICT_DECOMPOSITION_LOW_RISK_TERMS.some((term) => containsStrictDecompositionTerm(text, term));
    if (!hasLowRiskTerm) {
        return false;
    }
    if (!preflight) {
        return true;
    }
    return getPreflightChangedFilesCount(preflight) <= 1
        && (getPreflightMetricNumber(preflight, 'changed_lines_total') ?? 0) <= 20
        && requiredReviewTypes.length <= 1;
}

function buildStrictDecompositionDecisionRequirement(params: {
    taskId: string;
    taskEntry: TaskQueueEntry | null;
    taskMode: Record<string, unknown> | null;
    preflight: Record<string, unknown> | null;
    profileSummary: NextStepProfileSummary | null;
    requiredReviewTypes: string[];
}): StrictDecompositionDecisionRequirement {
    const taskSummary = getStrictDecompositionDecisionTaskSummary(params.taskId, params.taskEntry, params.taskMode);
    if (!isStrictProfileSelected(params.taskEntry, params.profileSummary)) {
        return {
            required: false,
            taskSummary,
            riskSignals: []
        };
    }

    const taskRiskSignals = collectStrictDecompositionTaskRiskSignals(params.taskEntry, params.taskMode);
    const preflightRiskSignals = collectStrictDecompositionPreflightRiskSignals(params.preflight, params.requiredReviewTypes);
    if (
        hasTinyStrictDecompositionExemption(
            params.taskEntry,
            params.taskMode,
            params.preflight,
            params.requiredReviewTypes,
            taskRiskSignals
        )
    ) {
        return {
            required: false,
            taskSummary,
            riskSignals: []
        };
    }

    const riskSignals = [...new Set([...taskRiskSignals, ...preflightRiskSignals])].sort();
    return {
        required: riskSignals.length > 0,
        taskSummary,
        riskSignals
    };
}

function buildStrictDecompositionDecisionCommand(params: {
    cliPrefix: string;
    taskId: string;
    taskSummary: string;
    riskSignals: string[];
    requiredReviewTypes: string[];
}): string {
    const parts = [
        `${params.cliPrefix} gate record-strict-decomposition-decision`,
        `--task-id ${quoteCommandValue(params.taskId)}`,
        `--decision ${quoteCommandValue('<atomic|single-cycle|split-required>')}`,
        `--task-summary ${quoteCommandValue(params.taskSummary)}`,
        `--reason ${quoteCommandValue('<why this strict task is atomic, single-cycle, or must split>')}`,
        `--scope-risk ${quoteCommandValue(`Strict decomposition prompt required by next-step risk signals: ${params.riskSignals.join(', ')}.`)}`
    ];
    const expectedReviewTypes = params.requiredReviewTypes.length > 0 ? params.requiredReviewTypes : ['none'];
    for (const reviewType of expectedReviewTypes) {
        parts.push(`--expected-review-type ${quoteCommandValue(reviewType)}`);
    }
    parts.push(`--atomicity-constraint ${quoteCommandValue('<constraint or none>')}`);
    parts.push('--repo-root "."');
    return parts.join(' ');
}

function buildStrictDecompositionEvidenceArtifactState(
    repoRoot: string,
    evidence: StrictDecompositionDecisionEvidenceResult
): NextStepArtifactState {
    return {
        key: 'strict-decomposition-decision',
        path: evidence.evidence_path ? toRepoDisplayPath(repoRoot, evidence.evidence_path) : '<unknown>',
        exists: evidence.evidence_status !== 'EVIDENCE_FILE_MISSING'
    };
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
    const missingArtifacts = params.status === 'DONE' ? [] : params.missingArtifacts;
    const invalidationImpact = buildInvalidationImpactSummary(params);
    return {
        schema_version: 1,
        task_id: params.taskId,
        generated_utc: new Date().toISOString(),
        navigator_command: params.navigatorCommand,
        status: params.status,
        next_gate: params.nextGate,
        title: params.title,
        reason: params.reason,
        commands: params.commands,
        missing_artifacts: missingArtifacts,
        present_artifacts: params.presentArtifacts,
        full_suite_validation: params.fullSuite,
        project_memory: params.projectMemory || null,
        review: params.review,
        task_queue_status_contract: buildTaskQueueStatusContract(params.taskId),
        audit_status: params.auditStatus,
        profile: params.profile,
        markdown_working_plan: params.markdownWorkingPlan || null,
        warnings: params.warnings || [],
        invalidation_impact: invalidationImpact,
        review_cycle_block: params.reviewCycleBlock || null,
        final_report: params.finalReport || null
    };
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
    if (!/\breview reuse\b|\bmaterialize reuse\b|\blane-domain current\b|\bdomain-limited remediation\b|\bexisting .*PASS evidence\b/iu.test(text)) {
        return ['none indicated'];
    }
    if (affectedReviewLanes.length === 0) {
        return ['unchanged upstream PASS evidence, if named by the current gate reason'];
    }
    return affectedReviewLanes.map((reviewType) => `${reviewType} (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)`);
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
    const remediation = params.staleness.remediation || 'Run "npm run build" before continuing gate execution from this source checkout.';
    return buildResult({
        taskId: params.taskId,
        navigatorCommand: params.navigatorCommand,
        status: 'BLOCKED',
        nextGate: 'source-runtime-remediation',
        title: 'Rebuild source-checkout runtime before continuing.',
        reason:
            `Source checkout generated runtime is stale: ${violationSummary}. ` +
            `Remediation blocks intended gate '${params.intendedGate}'. ` +
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

function getEffectiveDepthForPostPreflightRules(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): number {
    const riskAwareDepth = isPlainRecord(preflight?.risk_aware_depth) ? preflight.risk_aware_depth : null;
    const preflightDepth = typeof riskAwareDepth?.effective_depth === 'number'
        ? riskAwareDepth.effective_depth
        : Number(riskAwareDepth?.effective_depth);
    if (Number.isInteger(preflightDepth) && preflightDepth >= 1) {
        return preflightDepth;
    }
    const taskModeDepth = typeof taskMode?.effective_depth === 'number'
        ? taskMode.effective_depth
        : Number(taskMode?.effective_depth);
    if (Number.isInteger(taskModeDepth) && taskModeDepth >= 1) {
        return taskModeDepth;
    }
    return 2;
}

function getPostPreflightRuleFileNames(
    preflight: Record<string, unknown> | null,
    taskMode: Record<string, unknown> | null
): string[] {
    const fileNames = new Set<string>([
        '00-core.md',
        '15-project-memory.md',
        '40-commands.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]);
    const requiredReviews = isPlainRecord(preflight?.required_reviews) ? preflight.required_reviews : {};
    const effectiveDepth = getEffectiveDepthForPostPreflightRules(preflight, taskMode);
    for (const [reviewType, required] of Object.entries(requiredReviews)) {
        if (required !== true) {
            continue;
        }
        for (const fileName of selectRulePackFiles(reviewType, effectiveDepth)) {
            fileNames.add(fileName);
        }
    }
    return [...fileNames].sort();
}

function buildPostPreflightRulePackCommandForFiles(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    ruleFileNames: string[],
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
        '--repo-root "."'
    ].join(' ');
}

function buildPostPreflightRulePackBindCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate bind-rule-pack-to-preflight`,
        `--task-id "${taskId}"`,
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildCompileGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate compile-gate`,
        `--task-id "${taskId}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildReviewContextCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    reviewType: string,
    reviewDepth: number,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return [
        `${cliPrefix} gate build-review-context`,
        `--review-type "${reviewType}"`,
        `--depth "${reviewDepth}"`,
        `--preflight-path "${preflightCommandPath}"`,
        ...buildTaskModePathCommandParts(repoRoot, taskId, taskModePath),
        '--repo-root "."'
    ].join(' ');
}

function buildRequiredReviewsCheckCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'required-reviews-check', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
}

function buildCompletionGateCommand(
    repoRoot: string,
    cliPrefix: string,
    taskId: string,
    preflightCommandPath: string,
    taskModePath: string | null
): string {
    return buildReviewPhaseCommand(repoRoot, cliPrefix, taskId, 'completion-gate', [
        `--preflight-path "${preflightCommandPath}"`
    ], taskModePath);
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

function buildProjectMemoryNextStepSummary(evidence: ReturnType<typeof getProjectMemoryImpactLifecycleEvidence>): NextStepProjectMemorySummary {
    return {
        enabled: evidence.enabled,
        required: evidence.required,
        mode: evidence.mode,
        evidence_status: evidence.evidence_status,
        status: evidence.status,
        update_needed: evidence.update_needed,
        affected_memory_files: [...evidence.affected_memory_files],
        updated_memory_files: [...evidence.updated_memory_files],
        compact_status: evidence.compact_status,
        compact_refreshed: evidence.compact_refreshed,
        artifact_path: evidence.artifact_path,
        update_artifact_path: evidence.update_artifact_path,
        visible_summary_line: evidence.visible_summary_line
    };
}

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const taskModePath = resolveActiveTaskModeArtifactPath(repoRoot, eventsRoot, reviewsRoot, taskId);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const readinessArtifacts = readNextStepReadinessArtifacts({
        reviewsRoot,
        taskId,
        taskModePath,
        preflightCommandPath
    });
    const { preflightPath, rulePackPath } = readinessArtifacts.paths;
    const { preflight, rulePack, taskMode, preflightSha256 } = readinessArtifacts;
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const markdownWorkingPlan = readOptionalMarkdownWorkingPlan(repoRoot, taskId);
    const taskEntries = readTaskQueueEntries(repoRoot);
    const taskEntry = taskEntries.get(taskId) || null;
    const taskIdCaseMismatch = taskEntry ? null : resolveTaskQueueCaseMismatch(taskEntries, taskId);
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const profileSummary = buildNextStepProfileSummary(repoRoot, taskEntry, taskMode, preflight);
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
    const projectMemorySummary = buildProjectMemoryNextStepSummary(projectMemoryEvidence);
    const reviewPolicy = resolveReviewPolicy(preflight, workflowReviewPolicy);
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType, preflightPath, preflightSha256, preflight)
    ));
    const fullSuiteGateStatus = getGateStatus(summary, 'full-suite-validation');
    const fullSuiteTimedOutRetryAvailable = fullSuiteFailedTimeoutRetryAvailable(
        readinessArtifacts.fullSuiteValidation,
        fullSuiteTimeoutForecast
    );
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

    const sourceRuntimeStaleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: coreArtifacts.missing,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        projectMemory: projectMemorySummary,
        review: reviewSummary,
        profile: profileSummary,
        markdownWorkingPlan,
        auditStatus: summary.status,
        warnings: [] as string[],
        sourceRuntimeStaleness
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

    const taskQueueStatus = taskEntry?.status || null;
    const splitRequiredStatusInTaskQueue = isTaskQueueSplitRequiredStatus(taskQueueStatus);
    const permanentSplitRequiredLatchEvidence = splitRequiredStatusInTaskQueue
        ? null
        : readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId });
    const decomposedStatusHasClearedLatchEvidence =
        isTaskQueueDecomposedStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasSplitRequiredClearedEvidence({
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    const doneStatusHasCompletedClearedLatchEvidence =
        isTaskQueueDoneStatus(taskQueueStatus)
        && permanentSplitRequiredLatchEvidence?.valid === true
        && hasCompletedDecomposedParentAfterSplitRequiredClear({
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });
    if (
        !splitRequiredStatusInTaskQueue
        && !decomposedStatusHasClearedLatchEvidence
        && !doneStatusHasCompletedClearedLatchEvidence
        && permanentSplitRequiredLatchEvidence?.valid
    ) {
        const restoreResult = restoreSplitRequiredParentFromPermanentLatch({
            repoRoot,
            eventsRoot,
            taskId,
            latchEvidence: permanentSplitRequiredLatchEvidence
        });

        const childRoute = resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(taskEntries, taskId);
        let syncResult: ReturnType<typeof transitionSplitRequiredParentToDecomposed> | null = null;
        if (hasChildren && (restoreResult.outcome === 'updated' || restoreResult.outcome === 'already_synced')) {
            syncResult = transitionSplitRequiredParentToDecomposed({ repoRoot, eventsRoot, taskId });
        }

        const latchRoute = resolvePermanentSplitRequiredLatchRoute({
            taskId,
            restoreResult: {
                outcome: restoreResult.outcome,
                errorMessage: restoreResult.error_message
            },
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: childRoute
                ? buildCommand(
                    'Continue child task',
                    `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                )
                : null
        });
        return buildResult({
            ...resultBase,
            status: latchRoute.status,
            nextGate: latchRoute.nextGate,
            title: latchRoute.title,
            reason: latchRoute.reason,
            commands: latchRoute.commands,
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (splitRequiredStatusInTaskQueue) {
        const latchEvidence = readSplitRequiredLatchEvidence({ reviewsRoot, eventsRoot, taskId });
        const childRoute = resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const hasChildren = hasLinkedChildTasks(taskEntries, taskId);
        const syncResult = latchEvidence.valid && hasChildren
            ? transitionSplitRequiredParentToDecomposed({ repoRoot, eventsRoot, taskId })
            : null;
        const splitRoute = resolveSplitRequiredTaskQueueRoute({
            taskId,
            latchValid: latchEvidence.valid,
            latchInvalidReason: latchEvidence.reason,
            hasChildren,
            transitionResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                }
                : null,
            childRoute,
            continueChildCommand: childRoute
                ? buildCommand(
                    'Continue child task',
                    `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                )
                : null
        });
        if (!latchEvidence.valid) {
            return buildResult({
                ...resultBase,
                status: splitRoute.status,
                nextGate: splitRoute.nextGate,
                title: splitRoute.title,
                reason: splitRoute.reason,
                commands: splitRoute.commands,
                missingArtifacts: [],
                presentArtifacts: coreArtifacts.present,
                finalReport: null
            });
        }
        return buildResult({
            ...resultBase,
            status: splitRoute.status,
            nextGate: splitRoute.nextGate,
            title: splitRoute.title,
            reason: splitRoute.reason,
            commands: splitRoute.commands,
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
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
        const completedCloseoutRoute = resolveCompletedCloseoutRoute({
            postDoneDrift,
            finalReportContractReady: summary.final_report_contract.status === 'READY',
            finalReportContractBlocker: summary.final_report_contract.blocker || '',
            finalReport,
            taskAuditCommand: buildCommand(
                'Build final audit summary',
                `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
            )
        });
        return buildResult({
            ...resultBase,
            status: completedCloseoutRoute.status,
            nextGate: completedCloseoutRoute.nextGate,
            title: completedCloseoutRoute.title,
            reason: completedCloseoutRoute.reason,
            commands: completedCloseoutRoute.commands,
            finalReport: completedCloseoutRoute.finalReport as NextStepFinalReportSummary | null
        });
    }

    if (isTaskQueueDoneStatus(taskEntry?.status || null)) {
        const doneConflictBlockers = summary.blockers.map((blocker) => `${blocker.gate}: ${blocker.reason}`);
        if (!isGatePassed(summary, 'completion-gate')) {
            doneConflictBlockers.unshift('completion-gate: missing or not passed');
        } else if (!isLatestCompletionCurrent(eventsRoot, taskId)) {
            doneConflictBlockers.unshift('completion-gate: pass exists but is stale for the current task cycle');
        }
        if (summary.final_report_contract.status !== 'READY') {
            doneConflictBlockers.push(
                `final-closeout: ${summary.final_report_contract.blocker || 'canonical final closeout is not ready'}`
            );
        }
        const doneRoute = resolveDoneTaskQueueTerminalRoute({
            taskId,
            conflictBlockers: doneConflictBlockers,
            allowCompletedClearedLatchEvidence: doneStatusHasCompletedClearedLatchEvidence,
            reopenPreviewCommand: buildCommand(
                'Preview explicit operator reopen',
                `${cliPrefix} gate task-reset --task-id "${taskId}" --reopen --dry-run --repo-root "."`
            )
        });
        return buildResult({
            ...resultBase,
            status: doneRoute.status,
            nextGate: doneRoute.nextGate,
            title: doneRoute.title,
            reason: doneRoute.reason,
            commands: doneRoute.commands,
            missingArtifacts: doneRoute.status === 'DONE' ? [] : coreArtifacts.missing,
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    if (!isGatePassed(summary, 'completion-gate') && isDecomposedParentTask(taskEntry)) {
        const completionState = isTaskQueueDecomposedStatus(taskEntry?.status || null)
            ? resolveDecomposedParentCompletionState(
                taskEntries,
                taskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            )
            : null;
        const childRoute = completionState?.unfinishedRoute || resolveNextUnfinishedChildRoute(
            taskEntries,
            taskId,
            new Set<string>(),
            extractExplicitLinkedChildTaskIds
        );
        const decomposedReason = isTaskQueueDecomposedStatus(taskEntry?.status || null)
            ? 'Task queue marks this parent as DECOMPOSED.'
            : 'Task queue marks this parent as a legacy BLOCKED split umbrella.';
        const tasksToComplete = completionState?.hasLinkedChildren && completionState.complete
            ? [...new Set([...completionState.completedDecomposedTaskIds, taskId])]
            : [];
        const syncResult = tasksToComplete.length > 0
            ? transitionDecomposedParentsToDone({
                repoRoot,
                eventsRoot,
                rootTaskId: taskId,
                taskIds: tasksToComplete
            })
            : null;
        const decomposedRoute = resolveDecomposedParentTerminalRoute({
            taskId,
            decomposedReason,
            childRoute,
            continueChildCommand: childRoute
                ? buildCommand(
                    'Continue child task',
                    `${cliPrefix} next-step "${childRoute.taskId}" --repo-root "."`
                )
                : null,
            hasLinkedChildren: completionState?.hasLinkedChildren || false,
            missingChildTaskIds: completionState?.missingChildTaskIds || [],
            complete: completionState?.complete || false,
            statusSyncResult: syncResult
                ? {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message,
                    taskIds: syncResult.task_ids
                }
                : null
        });
        return buildResult({
            ...resultBase,
            status: decomposedRoute.status,
            nextGate: decomposedRoute.nextGate,
            title: decomposedRoute.title,
            reason: decomposedRoute.reason,
            commands: decomposedRoute.commands,
            missingArtifacts: [],
            presentArtifacts: coreArtifacts.present,
            finalReport: null
        });
    }

    const docImpactPath = readinessArtifacts.paths.docImpactPath;
    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: null,
            failedReviewVerdict: null,
            docImpactPath,
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode)
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
            plannedChangedFiles: getTaskModePlannedChangedFiles(taskMode)
        })
        : preflightWorkspaceReadiness;

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
        if (!strictDecompositionRequirement.required) {
            return null;
        }
        const strictDecompositionEvidence = getStrictDecompositionDecisionEvidence(
            repoRoot,
            taskId,
            '',
            strictDecompositionRequirement.taskSummary
        );
        const strictDecompositionArtifactState = buildStrictDecompositionEvidenceArtifactState(
            repoRoot,
            strictDecompositionEvidence
        );
        if (strictDecompositionEvidence.evidence_status !== 'PASS') {
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-strict-decomposition-decision',
                title: 'Record strict decomposition decision before implementation.',
                reason:
                    'This strict task is risky or umbrella-shaped, so next-step requires a current strict decomposition decision before ordinary classify, compile, review, full-suite, completion, or implementation continuation. ' +
                    `Evidence status: ${formatNextStepInlineValue(strictDecompositionEvidence.evidence_status)}. ` +
                    `Risk signals: ${formatNextStepInlineList(strictDecompositionRequirement.riskSignals)}. ` +
                    'Choose atomic, single-cycle, or split-required explicitly; atomic and single-cycle are not review waivers, and later scope-budget or review-cycle split latches still override the decision.',
                commands: [
                    buildCommand(
                        'Record strict decomposition decision',
                        buildStrictDecompositionDecisionCommand({
                            cliPrefix,
                            taskId,
                            taskSummary: strictDecompositionRequirement.taskSummary,
                            riskSignals: strictDecompositionRequirement.riskSignals,
                            requiredReviewTypes
                        })
                    )
                ],
                missingArtifacts: strictDecompositionArtifactState.exists
                    ? resultBase.missingArtifacts
                    : [...resultBase.missingArtifacts, strictDecompositionArtifactState],
                presentArtifacts: strictDecompositionArtifactState.exists
                    ? [...coreArtifacts.present, strictDecompositionArtifactState]
                    : coreArtifacts.present
            });
        }
        if (strictDecompositionEvidence.decision === 'split-required') {
            const splitRoutingState = resolveStrictDecompositionSplitRoutingState(
                taskEntries,
                taskId,
                strictDecompositionEvidence.proposed_child_task_ids
            );
            if (!splitRoutingState.ready) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'strict-decomposition-split-routing',
                    title: 'Strict decomposition split decision is active.',
                    reason:
                        'A current strict decomposition decision says split-required, so ordinary classify, compile, review, full-suite, completion, and implementation continuation are suppressed. ' +
                        `Risk signals: ${formatNextStepInlineList(strictDecompositionRequirement.riskSignals)}. ` +
                        `Proposed child tasks: ${formatNextStepInlineList(strictDecompositionEvidence.proposed_child_task_ids)}. ` +
                        `Linked child tasks: ${formatNextStepInlineList(splitRoutingState.linkedChildTaskIds)}. ` +
                        `Child routing is not ready: ${formatStrictDecompositionSplitRoutingViolations(splitRoutingState)}. ` +
                        'Create and link parent-derived strict child task rows that match the decision artifact before continuing; later scope-budget or review-cycle split latches remain authoritative.',
                    commands: [],
                    missingArtifacts: [],
                    presentArtifacts: [...coreArtifacts.present, strictDecompositionArtifactState],
                    finalReport: null
                });
            }

            const syncResult = transitionStrictDecompositionParentToDecomposed({ repoRoot, eventsRoot, taskId });
            const strictSplitRoute = resolveStrictDecompositionSplitTerminalRoute({
                taskId,
                transitionResult: {
                    outcome: syncResult.outcome,
                    errorMessage: syncResult.error_message
                },
                childRoute: splitRoutingState.childRoute,
                continueChildCommand: splitRoutingState.childRoute
                    ? buildCommand(
                        'Continue child task',
                        `${cliPrefix} next-step "${splitRoutingState.childRoute.taskId}" --repo-root "."`
                    )
                    : null
            });
            return buildResult({
                ...resultBase,
                status: strictSplitRoute.status,
                nextGate: strictSplitRoute.nextGate,
                title: strictSplitRoute.title,
                reason: strictSplitRoute.reason,
                commands: strictSplitRoute.commands,
                missingArtifacts: [],
                presentArtifacts: [...coreArtifacts.present, strictDecompositionArtifactState],
                finalReport: null
            });
        }
        return null;
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
            orchestratorWorkRestartCommand: buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode)
        },
        workspaceReadiness: effectivePreflightWorkspaceReadiness,
        workspaceRefreshCommand: buildClassifyChangeCommand({
            repoRoot,
            cliPrefix,
            taskId,
            taskMode,
            taskModePath,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: effectivePreflightWorkspaceReadiness.currentChangedFiles
                ?? getPreflightRefreshChangedFiles(taskMode, preflight)
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
        const continuationEvidence = assessReviewCycleContinuationEvidence({
            repoRoot,
            reviewsRoot,
            eventsRoot,
            taskId,
            evaluation: reviewCycleGuardEvaluation
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
            const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
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
                        : 'The configured workflow guard blocks additional compile, review, or full-suite continuation until operator decision. allow_one_more_cycle records task-scoped one-shot runtime evidence only; raise_limits is a permanent repo-local workflow-config change through workflow set.'),
                commands: autoSplitEnabled
                    ? []
                    : [
                        buildCommand(
                            'Record one-shot review-cycle continuation',
                            buildReviewCycleContinuationCommand(cliPrefix, taskId, reviewCycleGuardEvaluation)
                        ),
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
            changedFiles: preflightWorkspaceReadiness.currentChangedFiles
                ?? getPreflightRefreshChangedFiles(taskMode, preflight)
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

    if (shouldRunFullSuiteAfterCompileBeforeReviews(
        fullSuiteConfig.enabled,
        fullSuiteConfig.placement,
        fullSuiteNotRequiredForCurrentScope
    )) {
        if (fullSuiteGateStatus === 'FAIL') {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            if (fullSuiteTimedOutRetryAvailable) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'full-suite-validation',
                    title: 'Retry full-suite validation with updated timeout forecast.',
                    reason:
                        `Full-suite validation timed out for the current compiled scope, and duration history now recommends a longer timeout. ` +
                        `Rerun the configured full-suite command before launching independent reviewers. ` +
                        `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                    commands: [
                        buildCommand(
                            'Retry full-suite validation',
                            fullSuiteCommand
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: 'Fix full-suite failures before reviewer launch.',
                reason:
                    `Full-suite validation is configured for placement '${fullSuiteConfig.placement}' and already failed for the current compiled scope. ` +
                    `Do not launch independent reviewers until the configured full-suite command passes; ` +
                    `fix the failures, rerun compile-gate if implementation changed, then rerun full-suite-validation.`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (!fullSuiteGatePassed) {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Run full-suite validation after compile before reviews.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path} with placement '${fullSuiteConfig.placement}'. ` +
                    `Run it after compile-gate and before launching independent reviewers so suite failures fail fast on the same compiled scope. ` +
                    `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                    `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Run full-suite validation',
                        fullSuiteCommand
                    )
                ]
            });
        }
    }

    if (
        shouldRunFullSuiteBeforeTestReview(
            fullSuiteConfig.enabled,
            fullSuiteConfig.placement,
            fullSuiteNotRequiredForCurrentScope
        )
        && reviewLaunchPlan.next_review_type === 'test'
    ) {
        if (fullSuiteGateStatus === 'FAIL') {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            if (fullSuiteTimedOutRetryAvailable) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'full-suite-validation',
                    title: 'Retry full-suite validation with updated timeout forecast.',
                    reason:
                        `Full-suite validation timed out for the current compiled scope, and duration history now recommends a longer timeout. ` +
                        `Rerun it before launching the mandatory test reviewer. ` +
                        `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                    commands: [
                        buildCommand(
                            'Retry full-suite validation',
                            fullSuiteCommand
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
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
                        navigatorCommand
                    )
                ]
            });
        }
        if (!fullSuiteGatePassed) {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Run full-suite validation before test review.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path} with placement '${fullSuiteConfig.placement}'. ` +
                    `Run it before launching the mandatory test reviewer so suite failures fail fast on the same compiled scope. ` +
                    `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. ` +
                    `Command: ${fullSuiteConfig.command}. ${fullSuiteTimeoutForecastLine || ''}`.trim(),
                commands: [
                    buildCommand(
                        'Run full-suite validation',
                        fullSuiteCommand
                    )
                ]
            });
        }
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
                        'Restart review cycle for reviewer launch retry',
                        buildRestartReviewCycleCommand(repoRoot, cliPrefix, taskId, taskIntent, taskModePath)
                    ),
                    rerunNavigator: buildCommand(
                        'Rerun navigator after fixing implementation',
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
        const reviewerIdentity = contextReviewerIdentity || '<agent:reviewer-session-id-from-review-context>';
        const routingReviewerIdentity = contextReviewerIdentity || '<agent:reviewer-session-id-from-delegated-agent>';
        const launchArtifactPath = buildDefaultReviewScratchCommandPath(
            repoRoot,
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
        const launchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
            repoRoot,
            eventsRoot,
            taskId,
            state
        );
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
        const delegatedReadinessRoute = resolveDelegatedReviewReadinessRoute({
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
                    buildPrepareReviewerLaunchCommand(repoRoot, cliPrefix, taskId, reviewType, reviewerIdentity, launchArtifactPath, taskModePath)
                ),
                recordDelegationStarted: buildCommand(
                    'Record delegated reviewer start',
                    buildRecordReviewerDelegationStartedCommand({
                        cliPrefix,
                        taskId,
                        reviewType,
                        reviewerIdentity,
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
                        reviewerIdentity,
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
                    'Record delegated review output, then close reviewer',
                    buildRecordReviewResultCommand(repoRoot, cliPrefix, taskId, reviewType, reviewerIdentity, preflightCommandPath, taskModePath)
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

    const reviewGateAlreadyPassed = isGatePassed(summary, 'required-reviews-check');
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

    const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
    const postReviewCloseoutRoute = resolvePostReviewCloseoutRoute({
        requiredReviews: {
            requiredReviewsGatePassed: isGatePassed(summary, 'required-reviews-check'),
            zeroDiffNoReviewCloseout: hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes),
            command: buildCommand(
                'Run required reviews check',
                buildRequiredReviewsCheckCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
            )
        },
        docImpact: {
            docImpactGatePassed: isGatePassed(summary, 'doc-impact-gate'),
            compatibilityHint: buildDocImpactCompatibilityHint(),
            command: buildCommand(
                'Run doc impact gate',
                buildDocImpactCommand(
                    cliPrefix,
                    taskId,
                    preflightCommandPath,
                    preflight,
                    repoRoot,
                    effectivePreflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []
                )
            )
        },
        fullSuite: {
            enabled: fullSuiteConfig.enabled,
            gatePassed: fullSuiteGatePassed,
            notRequiredForDocsOnly: fullSuiteNotRequiredForDocsOnly,
            placement: fullSuiteConfig.placement,
            configPath: fullSuiteSummary.config_path,
            commandText: fullSuiteConfig.command,
            timeoutForecastLine: fullSuiteTimeoutForecastLine,
            command: buildCommand(
                fullSuiteNotRequiredForDocsOnly ? 'Record full-suite not required' : 'Run full-suite validation',
                fullSuiteCommand
            )
        },
        projectMemory: {
            required: projectMemoryEvidence.required,
            evidenceCurrent: projectMemoryEvidence.evidence_status === 'CURRENT',
            visibleSummaryLine: projectMemoryEvidence.visible_summary_line,
            affectedMemoryFiles: projectMemoryEvidence.affected_memory_files,
            violations: projectMemoryEvidence.violations,
            command: buildCommand(
                'Run project memory impact gate',
                buildProjectMemoryImpactCommand(cliPrefix, taskId, preflightCommandPath, projectMemorySummary)
            )
        },
        completion: {
            completionGatePassed: isGatePassed(summary, 'completion-gate'),
            command: buildCommand(
                'Run completion gate',
                buildCompletionGateCommand(repoRoot, cliPrefix, taskId, preflightCommandPath, taskModePath)
            )
        }
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
