import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    getReviewExecutionDependencies,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../core/review-execution-policy';
import { assertValidTaskId } from '../gate-runtime/task-events';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION,
    REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION,
    REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION
} from '../gate-runtime/reviewer-session-contract';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    formatReviewVerdictTokenList,
    normalizeReviewReceiptReviewerProvenance
} from '../gate-runtime/review-context';
import {
    buildTaskAuditSummary,
    type TaskAuditSummaryResult
} from './task-audit-summary';
import {
    type GateOutcome,
    resolveEventsRoot,
    resolveReviewsRoot,
    safeReadJson
} from './task-audit-summary-collectors';
import {
    loadFullSuiteValidationConfig,
    resolveWorkflowConfigPath
} from './full-suite-validation';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from './review-trust-summary';
import {
    getCycleBindingSnapshotFromPayload
} from './task-events-summary';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from './helpers';
import {
    resolveBundleNameForTarget
} from '../core/constants';
import {
    buildDefaultWorkflowConfig
} from '../core/workflow-config';
import {
    REVIEW_CONTRACTS
} from './required-reviews-check';
import {
    getWorkspaceSnapshotCached,
    type WorkspaceSnapshot
} from './workspace-snapshot-cache';
import {
    selectRulePackFiles
} from './build-review-context';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from './review-context-contract';
import {
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from './review-reuse-telemetry';
import {
    getClassificationConfig,
    isDocumentationLikePath,
    isRuntimeCodeLikePath,
    isSafeOrdinaryDocumentationPath,
    type ResolvedClassificationConfig
} from './classify-change';
import {
    getPostPreflightSequenceEvidence,
    getRulePackEvidence,
    getRulePackEvidenceViolations
} from './rule-pack';
import {
    collectOrderedTimelineEvents,
    type TimelineEventEntry
} from './completion-evidence';
import {
    buildCoherentCycleRestartCommand
} from './completion-reporting';
import {
    normalizeProviderId
} from '../core/provider-registry';
import {
    evaluateScopeBudgetGuard,
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardEvaluation
} from '../core/scope-budget-guard';
import {
    evaluateReviewCycleGuard,
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardEvaluation
} from '../core/review-cycle-guard';
import {
    resolveTaskProfileSelection
} from '../policy/task-profile-selection';
import {
    validateWorkflowConfig
} from '../schemas/config-artifacts';
import {
    detectSourceCheckoutRuntimeStaleness,
    type SourceCheckoutRuntimeStalenessResult
} from '../validators/workspace-layout';
import {
    buildDefaultReviewScratchCommandPath,
    resolveDefaultReviewScratchPath,
    resolveReviewScratchRoot
} from './review-scratch-paths';

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

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));
const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';

export type NextStepStatus = 'BLOCKED' | 'READY' | 'DONE';

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
    config_path: string;
    config_source: 'effective_workflow_config';
    note: string;
}

export interface NextStepReviewSummary {
    required_reviews: string[];
    review_execution_policy_mode: EffectiveReviewExecutionPolicyMode;
    review_execution_policy_source: 'preflight' | 'workflow_config_fallback';
    next_review_type: string | null;
    blocked_review_dependencies: string[];
    ordinary_doc_review_skips: { path: string; pattern: string }[];
    trust: ReviewTrustSummary | null;
    trust_note: string | null;
}

export interface NextStepFinalReportSummary {
    closeout_json_path: string;
    closeout_markdown_path: string;
    required_order: string[];
    commit_command_suggestion: string;
    commit_question: string;
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

export interface NextStepReviewCycleLatestFailedReview {
    review_type: string;
    event_type: string;
    outcome: string | null;
    verdict_token: string | null;
    reviewer_identity: string | null;
    review_artifact_path: string | null;
    summary: string | null;
    sequence: number;
    timestamp_utc: string | null;
}

export interface NextStepReviewCycleBlock {
    kind: 'review_cycle_guard';
    operator_decision_required: boolean;
    wait_for_operator: boolean;
    auto_split_enabled: boolean;
    reason: string;
    total_non_test_review_count: number;
    failed_non_test_review_count: number;
    counts_by_review_type: Record<string, { total: number; failed: number; passed: number; pending: number }>;
    excluded_review_types: string[];
    latest_failed_review: NextStepReviewCycleLatestFailedReview | null;
    choices: string[];
    auto_split_prompt: NextStepReviewCycleAutoSplitPrompt | null;
}

export interface NextStepReviewCycleAutoSplitPrompt {
    kind: 'review_cycle_auto_split_prompt';
    artifact_path: string;
    artifact_sha256: string;
    next_action: string;
    instructions: string[];
    constraints: string[];
}

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
    review: NextStepReviewSummary;
    audit_status: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
    warnings: string[];
    review_cycle_block: NextStepReviewCycleBlock | null;
    final_report: NextStepFinalReportSummary | null;
}

interface TaskQueueEntry {
    taskId: string;
    title: string | null;
    profile: string | null;
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

interface ReviewArtifactState {
    reviewType: string;
    contextPath: string;
    artifactPath: string;
    receiptPath: string;
    contextExists: boolean;
    contextCurrent: boolean;
    artifactExists: boolean;
    receiptExists: boolean;
    passToken: string;
    failToken: string;
    verdictToken: string | null;
    failed: boolean;
    ready: boolean;
    violations: string[];
    reviewerIdentity: string | null;
    contextReviewerIdentity: string | null;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256: string | null;
    reusedFromCodeScopeSha256: string | null;
    receiptReviewContextSha256: string | null;
    receiptReviewContextReuseSha256: string | null;
    receiptReviewScopeSha256: string | null;
    receiptCodeScopeSha256: string | null;
    contextReviewTreeStateSha256: string | null;
    receiptReviewTreeStateSha256: string | null;
    reviewerProvenance: {
        attestation_type: string;
        controller_event_type: string;
        task_sequence: number | null;
        prev_event_sha256: string | null;
        event_sha256: string | null;
        task_id?: string;
        review_type?: string;
        reviewer_execution_mode?: string;
        reviewer_identity?: string;
        review_context_sha256?: string;
        review_tree_state_sha256?: string | null;
        routing_event_sha256?: string;
    } | null;
}

interface CompileReadiness {
    ready: boolean;
    reason: string;
}

interface PreflightWorkspaceReadiness {
    ready: boolean;
    reason: string;
    currentChangedFiles?: string[];
    acceptedDocsOnlyDeltaFiles?: string[];
}

interface PreflightWorkspaceReadinessOptions {
    failedReviewType?: string | null;
    failedReviewVerdict?: string | null;
    docImpactPath?: string | null;
}

interface PreflightCycleReadiness {
    ready: boolean;
    reason: string;
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
}

interface StartupCycleReadiness {
    ready: boolean;
    nextGate: 'load-rule-pack' | 'handshake-diagnostics' | 'shell-smoke-preflight' | null;
    title: string;
    reason: string;
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

function toRepoDisplayPath(repoRoot: string, filePath: string): string {
    const relative = path.relative(path.resolve(repoRoot), path.resolve(filePath));
    return normalizePath(relative && !relative.startsWith('..') && !path.isAbsolute(relative)
        ? relative
        : filePath);
}

function buildCliPrefix(repoRoot: string): string {
    return fs.existsSync(path.join(path.resolve(repoRoot), 'bin', 'garda.js'))
        ? 'node bin/garda.js'
        : `node ${resolveBundleNameForTarget(repoRoot)}/bin/garda.js`;
}

function buildBundleRelativePath(repoRoot: string, relativePath: string): string {
    return normalizePath(path.join(resolveBundleNameForTarget(repoRoot), relativePath));
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
    return REVIEW_PREPARATION_ORDER.filter((reviewType) => requiredReviews[reviewType] === true);
}

function hasZeroDiffNoReviewableScopeSuppression(
    preflight: Record<string, unknown> | null,
    requiredReviewTypes: string[]
): boolean {
    if (!preflight || requiredReviewTypes.length > 0) {
        return false;
    }
    const zeroDiffGuard = isPlainRecord(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : null;
    const profileGuardrails = isPlainRecord(preflight.profile_guardrails)
        ? preflight.profile_guardrails
        : null;
    return zeroDiffGuard?.zero_diff_detected === true
        && zeroDiffGuard.status === 'BASELINE_ONLY'
        && profileGuardrails?.zero_diff_no_reviewable_scope === true;
}

function resolveReviewPolicy(preflight: Record<string, unknown> | null): {
    mode: EffectiveReviewExecutionPolicyMode;
    source: 'preflight' | 'workflow_config_fallback';
} {
    if (preflight && isPlainRecord(preflight.review_execution_policy)) {
        return {
            mode: resolveReviewExecutionPolicyModeFromPreflight(preflight),
            source: 'preflight'
        };
    }
    return {
        mode: resolveReviewExecutionPolicyModeFromPreflight(null),
        source: 'workflow_config_fallback'
    };
}

function readReviewArtifactState(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    preflightPath: string,
    preflightSha256: string | null,
    preflightPayload: Record<string, unknown> | null
): ReviewArtifactState {
    const contextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const violations: string[] = [];
    const contextExists = fileExists(contextPath);
    let contextCurrent = false;
    const artifactExists = fileExists(artifactPath);
    const receiptExists = fileExists(receiptPath);
    let context: Record<string, unknown> | null = null;
    let receipt: Record<string, unknown> | null = null;
    let reviewerIdentity: string | null = null;
    let contextReviewerIdentity: string | null = null;
    let contextReviewTreeStateSha256: string | null = null;
    let receiptReviewTreeStateSha256: string | null = null;
    let reusedExistingReview = false;
    let reusedFromReceiptPath: string | null = null;
    let reusedFromReceiptSha256: string | null = null;
    let reusedFromReviewContextSha256: string | null = null;
    let reusedFromReviewContextReuseSha256: string | null = null;
    let reusedFromReviewTreeStateSha256: string | null = null;
    let reusedFromReviewScopeSha256: string | null = null;
    let reusedFromCodeScopeSha256: string | null = null;
    let receiptReviewContextSha256: string | null = null;
    let receiptReviewContextReuseSha256: string | null = null;
    let receiptReviewScopeSha256: string | null = null;
    let receiptCodeScopeSha256: string | null = null;
    let reviewerProvenance: ReviewArtifactState['reviewerProvenance'] = null;
    let verdictToken: string | null = null;
    let failed = false;

    if (!contextExists) {
        violations.push('review context artifact is missing');
    } else {
        context = safeReadJson(contextPath);
        if (!context) {
            violations.push('review context artifact is invalid JSON');
        } else {
            const reviewerRouting = isPlainRecord(context.reviewer_routing)
                ? context.reviewer_routing
                : null;
            const contextTreeState = isPlainRecord(context.tree_state)
                ? context.tree_state
                : null;
            contextReviewTreeStateSha256 = typeof contextTreeState?.tree_state_sha256 === 'string'
                ? contextTreeState.tree_state_sha256.trim().toLowerCase() || null
                : null;
            if (!contextReviewTreeStateSha256) {
                violations.push('review context is missing tree_state.tree_state_sha256');
            }
            const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
                ? reviewerRouting.reviewer_session_id.trim()
                : '';
            contextReviewerIdentity = contextReviewerSessionId || null;
            const contextPreflightPath = typeof context.preflight_path === 'string'
                ? normalizePath(context.preflight_path)
                : '';
            const contextPreflightHash = typeof context.preflight_sha256 === 'string'
                ? context.preflight_sha256.trim().toLowerCase()
                : '';
            const expectedPreflightPath = normalizePath(preflightPath);
            const expectedPreflightHash = String(preflightSha256 || '').trim().toLowerCase();
            if (
                contextPreflightPath
                && contextPreflightHash
                && contextPreflightPath.toLowerCase() === expectedPreflightPath.toLowerCase()
                && contextPreflightHash === expectedPreflightHash
            ) {
                const contractViolations = getReviewContextContractViolations({
                    contextPath,
                    reviewContext: context,
                    expectedTaskId: taskId,
                    expectedReviewType: reviewType,
                    expectedPreflightPath: preflightPath,
                    expectedPreflightSha256: preflightSha256,
                    requireReviewType: true,
                    requireTaskId: true,
                    requirePreflightPath: true,
                    requirePreflightSha256: true,
                    ...buildReviewContextPreflightDiffExpectations(preflightPayload, reviewType)
                });
                if (contractViolations.length === 0) {
                    contextCurrent = true;
                } else {
                    violations.push(...contractViolations);
                }
            } else {
                violations.push(
                    'review context preflight binding is stale or missing ' +
                    `(context preflight_path='${contextPreflightPath || 'missing'}', preflight_sha256=${contextPreflightHash || 'missing'}; ` +
                    `expected preflight_path='${expectedPreflightPath || 'missing'}', preflight_sha256=${expectedPreflightHash || 'missing'})`
                );
            }
        }
    }

    if (!artifactExists) {
        violations.push('review artifact is missing');
    } else {
        const content = fs.readFileSync(artifactPath, 'utf8');
        const parsedVerdictToken = extractReviewVerdictToken(content, passToken || null, failToken || null, reviewType);
        const acceptedTokens = buildReviewVerdictTokenSet(reviewType, passToken || null, failToken || null);
        if (failToken && parsedVerdictToken === failToken) {
            verdictToken = failToken;
            failed = true;
            violations.push(
                `review artifact contains fail token '${failToken}'; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
            );
        } else if (passToken && parsedVerdictToken === passToken) {
            verdictToken = passToken;
        } else {
            violations.push(
                `review artifact does not contain an accepted pass token ` +
                `(${formatReviewVerdictTokenList(acceptedTokens.passTokens)})`
            );
        }
    }

    if (!receiptExists) {
        violations.push('review receipt is missing');
    } else {
        receipt = safeReadJson(receiptPath);
        if (!receipt) {
            violations.push('review receipt is invalid JSON');
        }
    }

    if (context && receipt && artifactExists) {
        const artifactHash = fileSha256(artifactPath);
        const contextHash = fileSha256(contextPath);
        const receiptArtifactHash = typeof receipt.review_artifact_sha256 === 'string'
            ? receipt.review_artifact_sha256.trim().toLowerCase()
            : '';
        const receiptContextHash = typeof receipt.review_context_sha256 === 'string'
            ? receipt.review_context_sha256.trim().toLowerCase()
            : '';
        const reviewerRouting = isPlainRecord(context.reviewer_routing)
            ? context.reviewer_routing
            : null;
        const contextExecutionMode = typeof reviewerRouting?.actual_execution_mode === 'string'
            ? reviewerRouting.actual_execution_mode.trim()
            : '';
        const contextReviewerSessionId = typeof reviewerRouting?.reviewer_session_id === 'string'
            ? reviewerRouting.reviewer_session_id.trim()
            : '';
        const receiptExecutionMode = typeof receipt.reviewer_execution_mode === 'string'
            ? receipt.reviewer_execution_mode.trim()
            : '';
        const receiptReviewerIdentity = typeof receipt.reviewer_identity === 'string'
            ? receipt.reviewer_identity.trim()
            : '';
        reviewerIdentity = receiptReviewerIdentity || null;
        reusedExistingReview = receipt.reused_existing_review === true;
        reusedFromReceiptPath = typeof receipt.reused_from_receipt_path === 'string'
            ? receipt.reused_from_receipt_path.trim() || null
            : null;
        reusedFromReceiptSha256 = typeof receipt.reused_from_receipt_sha256 === 'string'
            ? receipt.reused_from_receipt_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewContextSha256 = typeof receipt.reused_from_review_context_sha256 === 'string'
            ? receipt.reused_from_review_context_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewContextReuseSha256 = typeof receipt.reused_from_review_context_reuse_sha256 === 'string'
            ? receipt.reused_from_review_context_reuse_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewTreeStateSha256 = typeof receipt.reused_from_review_tree_state_sha256 === 'string'
            ? receipt.reused_from_review_tree_state_sha256.trim().toLowerCase() || null
            : null;
        reusedFromReviewScopeSha256 = typeof receipt.reused_from_review_scope_sha256 === 'string'
            ? receipt.reused_from_review_scope_sha256.trim().toLowerCase() || null
            : null;
        reusedFromCodeScopeSha256 = typeof receipt.reused_from_code_scope_sha256 === 'string'
            ? receipt.reused_from_code_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewContextSha256 = receiptContextHash || null;
        receiptReviewContextReuseSha256 = typeof receipt.review_context_reuse_sha256 === 'string'
            ? receipt.review_context_reuse_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewScopeSha256 = typeof receipt.review_scope_sha256 === 'string'
            ? receipt.review_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptCodeScopeSha256 = typeof receipt.code_scope_sha256 === 'string'
            ? receipt.code_scope_sha256.trim().toLowerCase() || null
            : null;
        receiptReviewTreeStateSha256 = typeof receipt.review_tree_state_sha256 === 'string'
            ? receipt.review_tree_state_sha256.trim().toLowerCase() || null
            : null;
        const normalizedProvenance = receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        reviewerProvenance = normalizedProvenance
            ? {
                attestation_type: normalizedProvenance.attestation_type,
                controller_event_type: normalizedProvenance.controller_event_type,
                task_sequence: normalizedProvenance.task_sequence,
                prev_event_sha256: normalizedProvenance.prev_event_sha256 == null
                    ? null
                    : String(normalizedProvenance.prev_event_sha256 || '').trim().toLowerCase() || null,
                event_sha256: String(normalizedProvenance.event_sha256 || '').trim().toLowerCase() || null,
                task_id: 'task_id' in normalizedProvenance ? normalizedProvenance.task_id : undefined,
                review_type: 'review_type' in normalizedProvenance ? normalizedProvenance.review_type : undefined,
                reviewer_execution_mode: 'reviewer_execution_mode' in normalizedProvenance ? normalizedProvenance.reviewer_execution_mode : undefined,
                reviewer_identity: 'reviewer_identity' in normalizedProvenance ? normalizedProvenance.reviewer_identity : undefined,
                review_context_sha256: 'review_context_sha256' in normalizedProvenance ? normalizedProvenance.review_context_sha256 : undefined,
                review_tree_state_sha256: 'review_tree_state_sha256' in normalizedProvenance ? normalizedProvenance.review_tree_state_sha256 : undefined,
                routing_event_sha256: 'routing_event_sha256' in normalizedProvenance ? normalizedProvenance.routing_event_sha256 : undefined
            }
            : null;
        if (receipt.task_id !== taskId) {
            violations.push(`review receipt belongs to task '${String(receipt.task_id || '')}'`);
        }
        if (receipt.review_type !== reviewType) {
            violations.push(`review receipt has review_type '${String(receipt.review_type || '')}'`);
        }
        if (!artifactHash || receiptArtifactHash !== artifactHash) {
            violations.push('review artifact hash does not match the receipt');
        }
        if (!contextHash || receiptContextHash !== contextHash) {
            violations.push('review context hash does not match the receipt');
        }
        if (contextReviewTreeStateSha256 && !receiptReviewTreeStateSha256) {
            violations.push('review receipt is missing review_tree_state_sha256');
        } else if (
            contextReviewTreeStateSha256
            && receiptReviewTreeStateSha256
            && receiptReviewTreeStateSha256 !== contextReviewTreeStateSha256
        ) {
            violations.push('review receipt review_tree_state_sha256 does not match the review context tree_state');
        }
        if (receiptExecutionMode !== 'delegated_subagent') {
            violations.push("review receipt does not use reviewer_execution_mode 'delegated_subagent'");
        }
        if (String(receipt.trust_level || '').trim() !== 'INDEPENDENT_AUDITED') {
            violations.push("review receipt trust_level must be 'INDEPENDENT_AUDITED'");
        }
        if (!receiptReviewerIdentity.startsWith('agent:')) {
            violations.push("review receipt reviewer_identity must use 'agent:' scope");
        }
        if (!reusedExistingReview && contextExecutionMode !== 'delegated_subagent') {
            violations.push("review context is missing delegated_subagent routing metadata");
        }
        if (!reusedExistingReview && contextReviewerSessionId !== receiptReviewerIdentity) {
            violations.push('review context reviewer identity does not match the receipt');
        }
        if (receipt.reviewer_provenance == null) {
            violations.push('review receipt is missing reviewer_provenance');
        } else if (!normalizedProvenance) {
            violations.push('review receipt reviewer_provenance is invalid');
        } else if (
            !reviewerProvenance?.task_sequence
            || !reviewerProvenance.event_sha256
            || !/^[0-9a-f]{64}$/.test(reviewerProvenance.event_sha256)
        ) {
            violations.push('review receipt reviewer_provenance is incomplete');
        } else if (reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED') {
            violations.push('review receipt reviewer_provenance must reference REVIEWER_INVOCATION_ATTESTED telemetry');
        } else if (
            !reusedExistingReview
            && receiptReviewTreeStateSha256
            && !reviewerProvenance.review_tree_state_sha256
        ) {
            violations.push('review receipt reviewer_provenance is missing review_tree_state_sha256');
        } else if (
            !reusedExistingReview
            && receiptReviewTreeStateSha256
            && reviewerProvenance.review_tree_state_sha256 !== receiptReviewTreeStateSha256
        ) {
            violations.push('review receipt reviewer_provenance review_tree_state_sha256 does not match the receipt');
        } else if (
            reusedExistingReview
            && !reusedFromReviewTreeStateSha256
        ) {
            violations.push('reused review receipt is missing reused_from_review_tree_state_sha256');
        } else if (
            reusedExistingReview
            && reusedFromReviewTreeStateSha256
            && reviewerProvenance.review_tree_state_sha256 !== reusedFromReviewTreeStateSha256
        ) {
            violations.push('reused review receipt reviewer_provenance review_tree_state_sha256 does not match reused_from_review_tree_state_sha256');
        }
    }

    return {
        reviewType,
        contextPath,
        artifactPath,
        receiptPath,
        contextExists,
        contextCurrent,
        artifactExists,
        receiptExists,
        passToken,
        failToken,
        verdictToken,
        failed,
        ready: violations.length === 0,
        violations,
        reviewerIdentity,
        contextReviewerIdentity,
        reusedExistingReview,
        reusedFromReceiptPath,
        reusedFromReceiptSha256,
        reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256,
        receiptReviewContextSha256,
        receiptReviewContextReuseSha256,
        receiptReviewScopeSha256,
        receiptCodeScopeSha256,
        contextReviewTreeStateSha256,
        receiptReviewTreeStateSha256,
        reviewerProvenance
    };
}

function scopedDiffExpectedForReview(options: {
    preflight: Record<string, unknown> | null;
    reviewType: string;
}): boolean {
    return buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType).expectedScopedDiff;
}

function getScopedDiffMetadataReadiness(options: {
    metadataPath: string;
    preflight: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    reviewType: string;
}): { ready: boolean; reason: string } {
    const metadataPath = options.metadataPath;
    if (!fileExists(metadataPath)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is missing: ${normalizePath(metadataPath)}.`
        };
    }
    const metadata = safeReadJson(metadataPath);
    if (!isPlainRecord(metadata)) {
        return {
            ready: false,
            reason: `Scoped diff metadata is invalid JSON: ${normalizePath(metadataPath)}.`
        };
    }
    if (typeof metadata.parse_error === 'string' && metadata.parse_error.trim()) {
        return {
            ready: false,
            reason: `Scoped diff metadata contains parse_error: ${metadata.parse_error.trim()}.`
        };
    }
    const outputDiffLineCount = typeof metadata.output_diff_line_count === 'number'
        ? metadata.output_diff_line_count
        : Number(metadata.output_diff_line_count);
    if (!Number.isFinite(outputDiffLineCount) || outputDiffLineCount <= 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata has no output diff lines: ${normalizePath(metadataPath)}.`
        };
    }

    const contractViolations = getReviewContextContractViolations({
        contextPath: metadataPath,
        reviewContext: {
            scoped_diff: {
                expected: true,
                metadata_path: normalizePath(metadataPath),
                metadata
            }
        },
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: false,
        requireTaskId: false,
        requirePreflightPath: false,
        requirePreflightSha256: false,
        requireDiffMaterialForRequiredReview: false,
        ...buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType),
        expectedScopedDiff: true
    });
    if (contractViolations.length > 0) {
        return {
            ready: false,
            reason: `Scoped diff metadata is stale or mismatched: ${contractViolations.join(' ')}`
        };
    }
    return { ready: true, reason: 'Scoped diff metadata is ready.' };
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

function timelineHasReviewReuseRecordedAfterCompile(eventsRoot: string, taskId: string, state: ReviewArtifactState): boolean {
    if (!state.reusedExistingReview || !state.receiptExists || !state.contextExists || !state.contextCurrent || !state.artifactExists) {
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
    if (!validation.valid) {
        return false;
    }
    return true;
}

function timelineHasDelegatedReviewInvocationForCurrentContext(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const reviewerIdentity = state.contextReviewerIdentity;
    if (!reviewerIdentity?.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const reviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (!reviewContextSha256 || !reviewTreeStateSha256) {
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
    if (latestCompileSequence == null) {
        return false;
    }
    const events = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as Record<string, unknown>];
            } catch {
                return [];
            }
        });
    let routingEventSha256: string | null = null;
    let routingSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
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
        if (
            String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || String(details.reviewer_session_id || '').trim() !== reviewerIdentity
        ) {
            continue;
        }
        routingEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        routingSequence = taskSequence;
        break;
    }
    if (!routingEventSha256 || !routingSequence) {
        return false;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= routingSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (
            String(details.task_id || '').trim() !== taskId
            || String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || eventReviewerIdentity !== reviewerIdentity
            || String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewContextSha256
            || String(details.review_tree_state_sha256 || '').trim().toLowerCase() !== reviewTreeStateSha256
            || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
            || String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.sha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    if (!reviewerIdentity.startsWith('agent:')) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
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
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function getDelegatedReviewRoutingShaAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): string | null {
    if (!reviewerIdentity.startsWith('agent:')) {
        return null;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return null;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
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
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
                return /^[0-9a-f]{64}$/.test(eventSha256) ? eventSha256 : null;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return null;
}

function getArtifactStringField(artifact: Record<string, unknown>, ...fieldNames: string[]): string {
    for (const fieldName of fieldNames) {
        const rawValue = artifact[fieldName];
        if (typeof rawValue === 'string' && rawValue.trim()) {
            return rawValue.trim();
        }
    }
    return '';
}

function hasCompletedReviewerLaunchEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc')
        && freshContext
    );
}

type CurrentReviewerLaunchArtifactState = 'missing_or_invalid' | 'prepared' | 'launched';

interface CurrentReviewerLaunchArtifactEvidence {
    state: CurrentReviewerLaunchArtifactState;
    path: string | null;
    sha256: string | null;
}

function resolveReviewerLaunchArtifactPathFromTelemetry(repoRoot: string, rawPath: unknown): string | null {
    const pathValue = String(rawPath || '').trim();
    if (!pathValue) {
        return null;
    }
    try {
        const resolvedPath = resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            return null;
        }
        const reviewScratchRoot = normalizePath(path.resolve(resolveReviewScratchRoot(repoRoot))).toLowerCase();
        const normalizedPath = normalizePath(path.resolve(resolvedPath)).toLowerCase();
        return normalizedPath === reviewScratchRoot || normalizedPath.startsWith(`${reviewScratchRoot}/`)
            ? resolvedPath
            : null;
    } catch {
        return null;
    }
}

function getCurrentReviewerLaunchArtifactEvidenceForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactEvidence {
    const missing: CurrentReviewerLaunchArtifactEvidence = {
        state: 'missing_or_invalid',
        path: null,
        sha256: null
    };
    const reviewerIdentity = state.contextReviewerIdentity || '';
    if (!reviewerIdentity.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return missing;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (!reviewContextSha256 || !routingEventSha256) {
        return missing;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return missing;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_PREPARED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const details = isPlainRecord(event.details) ? event.details : {};
            const preparedLaunchEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const launchArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                details.reviewer_launch_artifact_path
            ) || resolveDefaultReviewScratchPath(repoRoot, taskId, state.reviewType, 'reviewer-launch.json');
            const launchArtifact = safeReadJson(launchArtifactPath);
            if (!launchArtifact) {
                continue;
            }
            const launchBindingSha256 = getArtifactStringField(
                launchArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ).toLowerCase();
            if (
                !/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)
                || !/^[0-9a-f]{64}$/.test(launchBindingSha256)
                || getArtifactStringField(launchArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase() !== preparedLaunchEventSha256
                || getArtifactStringField(launchArtifact, 'task_id', 'taskId') !== taskId
                || getArtifactStringField(launchArtifact, 'review_type', 'reviewType') !== state.reviewType
                || getArtifactStringField(launchArtifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== 'delegated_subagent'
                || getArtifactStringField(
                    launchArtifact,
                    'reviewer_identity',
                    'reviewerIdentity',
                    'reviewer_session_id',
                    'reviewerSessionId'
                ) !== reviewerIdentity
                || getArtifactStringField(launchArtifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== reviewContextSha256
                || getArtifactStringField(launchArtifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== routingEventSha256
                || String(details.review_type || '').trim() !== state.reviewType
                || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
                || String(details.reviewer_session_id || details.reviewer_identity || '').trim() !== reviewerIdentity
                || String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewContextSha256
                || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
                || String(details.launch_binding_sha256 || '').trim().toLowerCase() !== launchBindingSha256
            ) {
                continue;
            }
            const evidenceType = getArtifactStringField(launchArtifact, 'evidence_type', 'artifact_type');
            const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
            let artifactState: CurrentReviewerLaunchArtifactState = 'missing_or_invalid';
            if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE && attestationState === 'prepared') {
                artifactState = 'prepared';
            } else if (
                evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'launched'
                && hasCompletedReviewerLaunchEvidence(launchArtifact)
            ) {
                artifactState = 'launched';
            }
            if (artifactState === 'missing_or_invalid') {
                continue;
            }
            const launchArtifactSha256 = fileSha256(launchArtifactPath);
            return {
                state: artifactState,
                path: launchArtifactPath,
                sha256: launchArtifactSha256 || null
            };
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return missing;
}

function getCurrentReviewerLaunchArtifactStateForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactState {
    return getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state).state;
}

function buildReviewerReadinessChainSummary(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    state: ReviewArtifactState | undefined
): string {
    const contextStatus = !state || !state.contextExists
        ? 'missing'
        : state.contextCurrent
            ? 'current'
            : 'stale';
    const reviewerIdentity = state?.contextReviewerIdentity || '';
    const routingCurrent = Boolean(
        state
        && contextStatus === 'current'
        && reviewerIdentity.startsWith('agent:')
        && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity)
    );
    const routingStatus = routingCurrent
        ? 'current'
        : contextStatus !== 'current'
            ? 'blocked until current context'
            : reviewerIdentity
                ? 'missing current-cycle telemetry'
                : 'missing reviewer identity';
    const launchArtifactState = routingCurrent && state
        ? getCurrentReviewerLaunchArtifactStateForInvocation(repoRoot, eventsRoot, taskId, state)
        : 'missing_or_invalid';
    const launchStatus = !routingCurrent
        ? 'blocked until routing'
        : launchArtifactState === 'prepared'
            ? 'prepared'
            : launchArtifactState === 'launched'
                ? 'launched'
                : 'missing or stale';
    const invocationCurrent = Boolean(
        state
        && timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
    );
    const invocationStatus = invocationCurrent
        ? 'attested'
        : launchArtifactState === 'launched'
            ? 'missing current-cycle attestation'
            : launchArtifactState === 'prepared'
                ? 'blocked until launch completion'
                : 'blocked until launch artifact';
    let resultStatus = 'blocked until invocation';
    if (invocationCurrent && state) {
        if (!state.artifactExists && !state.receiptExists) {
            resultStatus = 'review output and receipt missing';
        } else if (!state.artifactExists) {
            resultStatus = 'review output missing';
        } else if (!state.receiptExists) {
            resultStatus = 'receipt missing';
        } else if (!state.ready) {
            resultStatus = 'receipt invalid or stale';
        } else if (!reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state)) {
            resultStatus = 'receipt missing current-cycle provenance';
        } else {
            resultStatus = 'ready';
        }
    }
    return `Reviewer readiness chain: ${[
        'preflight scope=current',
        `review context=${contextStatus}`,
        `routing=${routingStatus}`,
        `launch artifact=${launchStatus}`,
        `invocation=${invocationStatus}`,
        `review output/receipt=${resultStatus}.`
    ].join(' -> ')}`;
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

function readReviewTrust(
    reviewsRoot: string,
    taskId: string,
    requiredReviewTypes: string[],
    scopeCategory: string | null
): ReviewTrustSummary | null {
    const entries = requiredReviewTypes.flatMap((reviewType) => {
        const receipt = safeReadJson(path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`));
        if (!receipt) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string'
                ? receipt.reviewer_identity
                : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_provenance: receipt.reviewer_provenance ?? null
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}

function getNextReviewType(
    repoRoot: string,
    requiredReviewTypes: string[],
    policyMode: EffectiveReviewExecutionPolicyMode,
    requiredReviews: Record<string, boolean>,
    reviewStates: ReviewArtifactState[],
    eventsRoot: string,
    taskId: string
): { reviewType: string | null; blockedDependencies: string[] } {
    const passedReviews = new Set(
        reviewStates
            .filter((state) => reviewStateHasSatisfiedEvidence(repoRoot, eventsRoot, taskId, state))
            .map((state) => state.reviewType)
    );
    for (const reviewType of requiredReviewTypes) {
        if (passedReviews.has(reviewType)) {
            continue;
        }
        const blockedDependencies = getReviewExecutionDependencies(reviewType, requiredReviews, policyMode)
            .filter((dependency) => !passedReviews.has(dependency));
        if (blockedDependencies.length > 0) {
            return {
                reviewType,
                blockedDependencies
            };
        }
        return {
            reviewType,
            blockedDependencies: []
        };
    }
    return {
        reviewType: null,
        blockedDependencies: []
    };
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
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
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
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getDownstreamReviewTypesFor(
    failedReviewType: string,
    requiredReviewTypes: string[],
    requiredReviews: Record<string, boolean>,
    policyMode: EffectiveReviewExecutionPolicyMode
): string[] {
    return requiredReviewTypes.filter((reviewType) => (
        reviewType !== failedReviewType
        && getReviewExecutionDependencies(reviewType, requiredReviews, policyMode).includes(failedReviewType)
    ));
}

function describeBlockedReviewDependencies(
    dependencies: readonly string[],
    reviewStates: readonly ReviewArtifactState[]
): string {
    const stateByType = new Map(reviewStates.map((state) => [state.reviewType, state]));
    return dependencies
        .map((dependency) => {
            const dependencyState = stateByType.get(dependency);
            if (dependencyState?.failed) {
                return `${dependency} failed with '${dependencyState.verdictToken || dependencyState.failToken || 'FAILED'}'`;
            }
            if (dependencyState?.artifactExists && !dependencyState.ready) {
                return `${dependency} is not PASS-ready (${dependencyState.violations.join('; ')})`;
            }
            return `${dependency} has no current PASS artifact and receipt`;
        })
        .join('; ');
}

function readCompileReadiness(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    preflightPath: string
): CompileReadiness {
    const compilePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    if (!fileExists(compilePath)) {
        return {
            ready: false,
            reason: `Compile gate evidence missing: ${normalizePath(compilePath)}.`
        };
    }
    const evidence = safeReadJson(compilePath);
    if (!evidence) {
        return {
            ready: false,
            reason: 'Compile gate evidence is invalid JSON; rerun compile-gate.'
        };
    }
    const expectedPreflightHash = fileSha256(preflightPath);
    const evidenceStatus = String(evidence.status || '').trim().toUpperCase();
    const evidenceOutcome = String(evidence.outcome || '').trim().toUpperCase();
    if (evidence.task_id !== taskId) {
        return {
            ready: false,
            reason: `Compile gate evidence belongs to task '${String(evidence.task_id || '')}'.`
        };
    }
    if (String(evidence.event_source || '').trim() !== 'compile-gate') {
        return {
            ready: false,
            reason: 'Compile gate evidence source is invalid; rerun compile-gate.'
        };
    }
    if (evidenceStatus !== 'PASSED' || evidenceOutcome !== 'PASS') {
        return {
            ready: false,
            reason: `Compile gate did not pass. Evidence status='${evidenceStatus || 'UNKNOWN'}', outcome='${evidenceOutcome || 'UNKNOWN'}'.`
        };
    }
    const evidencePreflightHash = String(evidence.preflight_hash_sha256 || '').trim().toLowerCase();
    if (!expectedPreflightHash || evidencePreflightHash !== expectedPreflightHash) {
        return {
            ready: false,
            reason: 'Compile gate evidence preflight hash does not match the current preflight; rerun compile-gate.'
        };
    }
    const detectionSource = String(evidence.scope_detection_source || '').trim();
    const changedFiles = Array.isArray(evidence.scope_changed_files)
        ? evidence.scope_changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const scopeSha256 = String(evidence.scope_sha256 || '').trim();
    const scopeContentSha256 = String(evidence.scope_content_sha256 || '').trim().toLowerCase();
    const changedFilesSha256 = String(evidence.scope_changed_files_sha256 || '').trim();
    const changedLinesTotal = Number.parseInt(String(evidence.scope_changed_lines_total || 0), 10) || 0;
    if (!detectionSource || !scopeSha256 || !changedFilesSha256) {
        return {
            ready: false,
            reason: 'Compile gate evidence is missing scope snapshot fields; rerun compile-gate.'
        };
    }
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    if (
        currentScope.scope_sha256 !== scopeSha256
        || currentScope.changed_files_sha256 !== changedFilesSha256
        || currentScope.changed_lines_total !== changedLinesTotal
    ) {
        const includeUntracked = evidence.scope_include_untracked == null ? true : !!evidence.scope_include_untracked;
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        const docsOnlyDeltaReadiness = currentGitSnapshot
            ? buildDocsOnlyDeltaReadiness(
                repoRoot,
                currentGitSnapshot.changed_files,
                changedFiles,
                changedLinesTotal,
                includeUntracked,
                detectionSource,
                changedFilesSha256,
                scopeContentSha256,
                getDocImpactDeclaredDocsUpdated(path.join(reviewsRoot, `${taskId}-doc-impact.json`))
            )
            : null;
        if (docsOnlyDeltaReadiness) {
            return {
                ready: true,
                reason: `Compile gate evidence is current after accepting ordinary docs-only updates for doc-impact. ${docsOnlyDeltaReadiness.reason}`
            };
        }
        return {
            ready: false,
            reason: 'Workspace changed after compile gate; rerun compile-gate before review preparation.'
        };
    }
    return {
        ready: true,
        reason: 'Compile gate evidence is current.'
    };
}

function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function describePathList(paths: readonly string[], limit = 8): string {
    const normalized = [...new Set(paths.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    if (normalized.length === 0) {
        return '[]';
    }
    const visible = normalized.slice(0, limit);
    const suffix = normalized.length > visible.length ? `, ... +${normalized.length - visible.length} more` : '';
    return `[${visible.join(', ')}${suffix}]`;
}

function readCurrentGitWorkspaceSnapshot(
    repoRoot: string,
    includeUntracked: boolean
): (WorkspaceSnapshot & { cache_hit: boolean }) | null {
    try {
        return getWorkspaceSnapshotCached(repoRoot, 'git_auto', includeUntracked, [], {
            noCache: true,
            readOnly: true
        });
    } catch {
        return null;
    }
}

function getUnchangedProtectedDirtyWorkspaceFiles(
    repoRoot: string,
    preflight: Record<string, unknown>
): Set<string> {
    const triggers = getPreflightTriggers(preflight);
    const protectedFiles = Array.isArray(triggers.dirty_workspace_protected_files)
        ? [...new Set(triggers.dirty_workspace_protected_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const protectedHashes = isPlainRecord(triggers.dirty_workspace_protected_file_hashes)
        ? triggers.dirty_workspace_protected_file_hashes
        : {};
    const unchanged = new Set<string>();
    for (const protectedFile of protectedFiles) {
        const expectedHash = String(protectedHashes[protectedFile] || '').trim().toLowerCase();
        if (!expectedHash) {
            continue;
        }
        const currentHash = fileSha256(path.join(repoRoot, protectedFile));
        if (currentHash && currentHash === expectedHash) {
            unchanged.add(protectedFile);
        }
    }
    return unchanged;
}

function getDocImpactDeclaredDocsUpdated(docImpactPath: string | null | undefined): string[] {
    if (!docImpactPath) {
        return [];
    }
    const docImpact = safeReadJson(docImpactPath);
    if (!docImpact || String(docImpact.decision || '').trim().toUpperCase() !== 'DOCS_UPDATED') {
        return [];
    }
    return Array.isArray(docImpact.docs_updated)
        ? [...new Set(docImpact.docs_updated.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
}

function isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource: string): boolean {
    const normalized = String(detectionSource || '').trim().toLowerCase();
    return normalized === 'git_auto' || normalized === 'explicit_changed_files';
}

function isOrdinaryDocumentationDeltaPath(
    filePath: string,
    classificationConfig: ResolvedClassificationConfig
): boolean {
    return isSafeOrdinaryDocumentationPath(filePath, classificationConfig);
}

function buildDocsOnlyDeltaReadiness(
    repoRoot: string,
    currentChangedFiles: string[],
    preflightChangedFiles: string[],
    expectedChangedLinesTotal: number,
    includeUntracked: boolean,
    detectionSource: string,
    expectedChangedFilesSha256: string,
    expectedScopeContentSha256: string,
    declaredDocsUpdated: string[]
): PreflightWorkspaceReadiness | null {
    if (!isReviewScopeDetectionSourceSupportedForDocImpactExemption(detectionSource)) {
        return null;
    }

    const classificationConfig = getClassificationConfig(repoRoot);

    const preflightSet = new Set(preflightChangedFiles);
    const currentFiles = [...new Set(currentChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    const missingPreflightFiles = preflightChangedFiles.filter((entry) => !currentFiles.includes(entry));
    const docsOnlyDeltaFiles = currentFiles.filter((entry) => !preflightSet.has(entry));
    if (missingPreflightFiles.length > 0 || docsOnlyDeltaFiles.length === 0) {
        return null;
    }

    const declaredDocsSet = declaredDocsUpdated.length > 0
        ? new Set(declaredDocsUpdated.map((entry) => normalizePath(entry)).filter(Boolean))
        : null;
    if (declaredDocsSet && docsOnlyDeltaFiles.some((entry) => !declaredDocsSet.has(entry))) {
        return null;
    }

    const nonOrdinaryDocs = docsOnlyDeltaFiles.filter((filePath) => (
        !isOrdinaryDocumentationDeltaPath(filePath, classificationConfig)
    ));
    if (nonOrdinaryDocs.length > 0) {
        return null;
    }

    const currentReviewScope = getWorkspaceSnapshotCached(
        repoRoot,
        'explicit_changed_files',
        includeUntracked,
        preflightChangedFiles,
        { noCache: true, readOnly: true }
    );
    const reviewScopeViolations: string[] = [];
    if (currentReviewScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        reviewScopeViolations.push('preflight changed_files differ from the current non-doc workspace snapshot');
    }
    if (currentReviewScope.changed_lines_total !== expectedChangedLinesTotal) {
        reviewScopeViolations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current non-doc changed_lines_total=${currentReviewScope.changed_lines_total}`
        );
    }
    if (
        expectedScopeContentSha256
        && currentReviewScope.scope_content_sha256 !== expectedScopeContentSha256
    ) {
        reviewScopeViolations.push(
            `preflight scope_content_sha256=${expectedScopeContentSha256} differs from current non-doc scope_content_sha256=${currentReviewScope.scope_content_sha256}`
        );
    }
    if (reviewScopeViolations.length > 0) {
        return null;
    }

    return {
        ready: true,
        reason:
            'Preflight implementation scope still matches the current workspace after accepting ordinary docs-only updates for doc-impact: ' +
            `${describePathList(docsOnlyDeltaFiles)}.`,
        currentChangedFiles: currentFiles,
        acceptedDocsOnlyDeltaFiles: docsOnlyDeltaFiles
    };
}

function readPreflightWorkspaceReadiness(
    repoRoot: string,
    preflight: Record<string, unknown>,
    options: PreflightWorkspaceReadinessOptions = {}
): PreflightWorkspaceReadiness {
    const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
    const expectedChangedLinesTotal = typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : Number(metrics.changed_lines_total);
    if (!Number.isFinite(expectedChangedLinesTotal) || expectedChangedLinesTotal < 0) {
        return {
            ready: true,
            reason: 'Preflight workspace freshness cannot be checked because metrics.changed_lines_total is missing.'
        };
    }

    const detectionSource = String(preflight.detection_source || 'git_auto').trim() || 'git_auto';
    const normalizedDetectionSource = detectionSource.toLowerCase();
    const includeUntracked = normalizedDetectionSource === 'git_staged_only'
        ? false
        : (typeof preflight.include_untracked === 'boolean' ? preflight.include_untracked : true);
    const changedFiles = Array.isArray(preflight.changed_files)
        ? [...new Set(preflight.changed_files.map((entry) => normalizePath(entry)).filter(Boolean))].sort()
        : [];
    const expectedChangedFilesSha256 = stringSha256(changedFiles.join('\n'));
    const expectedScopeContentSha256 = typeof metrics.scope_content_sha256 === 'string'
        ? metrics.scope_content_sha256.trim().toLowerCase()
        : '';
    const currentScope = getWorkspaceSnapshotCached(
        repoRoot,
        detectionSource,
        includeUntracked,
        changedFiles,
        { noCache: true, readOnly: true }
    );
    const violations: string[] = [];
    if (currentScope.changed_files_sha256 !== expectedChangedFilesSha256) {
        const currentScopeFiles = Array.isArray(currentScope.changed_files)
            ? currentScope.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        const expectedSet = new Set(changedFiles);
        const currentSet = new Set(currentScopeFiles);
        const missingFromPreflight = currentScopeFiles.filter((entry) => !expectedSet.has(entry));
        const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
        violations.push(
            `stale preflight file set ${describePathList(changedFiles)} differs from current workspace snapshot ${describePathList(currentScopeFiles)}` +
            `; missing from preflight: ${describePathList(missingFromPreflight)}` +
            `; no longer current: ${describePathList(noLongerCurrent)}`
        );
    }
    if (currentScope.changed_lines_total !== expectedChangedLinesTotal) {
        violations.push(
            `preflight changed_lines_total=${expectedChangedLinesTotal} differs from current changed_lines_total=${currentScope.changed_lines_total}`
        );
    }
    const expectedScopeSha256 = typeof metrics.scope_sha256 === 'string'
        ? metrics.scope_sha256.trim().toLowerCase()
        : '';
    if (expectedScopeSha256 && currentScope.scope_sha256 !== expectedScopeSha256) {
        violations.push(
            `preflight scope_sha256=${expectedScopeSha256} differs from current scope_sha256=${currentScope.scope_sha256}`
        );
    }
    let currentChangedFiles: string[] | undefined;
    if (normalizedDetectionSource === 'explicit_changed_files') {
        const currentGitSnapshot = readCurrentGitWorkspaceSnapshot(repoRoot, includeUntracked);
        if (currentGitSnapshot) {
            const unchangedProtectedFiles = getUnchangedProtectedDirtyWorkspaceFiles(repoRoot, preflight);
            const currentGitChangedFiles = currentGitSnapshot.changed_files.filter((entry) => (
                !unchangedProtectedFiles.has(normalizePath(entry))
            ));
            currentChangedFiles = currentGitChangedFiles;
            const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
                repoRoot,
                currentGitChangedFiles,
                changedFiles,
                expectedChangedLinesTotal,
                includeUntracked,
                detectionSource,
                expectedChangedFilesSha256,
                expectedScopeContentSha256,
                getDocImpactDeclaredDocsUpdated(options.docImpactPath)
            );
            if (docsOnlyDeltaReadiness) {
                return docsOnlyDeltaReadiness;
            }
            const currentFileSetHash = stringSha256(currentGitChangedFiles.join('\n'));
            if (currentFileSetHash !== expectedChangedFilesSha256) {
                const expectedSet = new Set(changedFiles);
                const currentSet = new Set(currentGitChangedFiles);
                const missingFromPreflight = currentGitChangedFiles.filter((entry) => !expectedSet.has(entry));
                const noLongerCurrent = changedFiles.filter((entry) => !currentSet.has(entry));
                const ignoredProtectedNote = unchangedProtectedFiles.size > 0
                    ? `; ignored unchanged dirty-baseline files: ${describePathList([...unchangedProtectedFiles])}`
                    : '';
                violations.push(
                    `stale preflight file set ${describePathList(changedFiles)} differs from current git snapshot ${describePathList(currentGitChangedFiles)}` +
                    `; missing from preflight: ${describePathList(missingFromPreflight)}` +
                    `; no longer current: ${describePathList(noLongerCurrent)}${ignoredProtectedNote}`
                );
            }
        }
    }

    const docsOnlyDeltaReadiness = buildDocsOnlyDeltaReadiness(
        repoRoot,
        currentScope.changed_files,
        changedFiles,
        expectedChangedLinesTotal,
        includeUntracked,
        detectionSource,
        expectedChangedFilesSha256,
        expectedScopeContentSha256,
        getDocImpactDeclaredDocsUpdated(options.docImpactPath)
    );
    if (docsOnlyDeltaReadiness) {
        return docsOnlyDeltaReadiness;
    }

    if (violations.length === 0) {
        return {
            ready: true,
            reason: 'Preflight scope still matches the current workspace.',
            currentChangedFiles
        };
    }
    const failedReviewType = String(options.failedReviewType || '').trim();
    const failedReviewNote = failedReviewType
        ? ` Stale failed review detected: '${failedReviewType}' previously recorded '${String(options.failedReviewVerdict || 'FAILED').trim() || 'FAILED'}', but the workspace hash changed after that review.`
        : '';
    return {
        ready: false,
        reason: `Preflight scope is stale before compile (${violations.join('; ')}).${failedReviewNote} Refresh classify-change for the current scope first.`,
        currentChangedFiles
    };
}

function readPreflightCycleReadiness(
    eventsRoot: string,
    taskId: string
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
    rulePackPath: string
): RulePackReadiness {
    const evidence = getRulePackEvidence(repoRoot, taskId, 'POST_PREFLIGHT', {
        preflightPath,
        artifactPath: rulePackPath
    });
    const sequenceEvidence = getPostPreflightSequenceEvidence(repoRoot, taskId, preflightPath, {
        artifactPath: rulePackPath
    });
    const violations = [
        ...getRulePackEvidenceViolations(evidence),
        ...sequenceEvidence.violations
    ];
    if (violations.length === 0 && evidence.binding_equivalent_to_current_preflight && sequenceEvidence.binding_equivalent_to_current_preflight) {
        return {
            ready: true,
            reason: 'POST_PREFLIGHT rule-pack evidence is current for the latest preflight.'
        };
    }
    if (violations.length === 0) {
        violations.push('POST_PREFLIGHT rule-pack evidence is not bound to the latest preflight.');
    }
    return {
        ready: false,
        reason: violations.join(' ')
    };
}

function readStartupCycleReadiness(
    eventsRoot: string,
    taskId: string
): StartupCycleReadiness {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const timelineErrors: string[] = [];
    const events = collectOrderedTimelineEvents(timelinePath, timelineErrors);
    if (timelineErrors.length > 0 || events.length === 0) {
        return {
            ready: true,
            nextGate: null,
            title: 'Startup cycle ordering was not checked.',
            reason: 'Timeline ordering could not be checked by next-step; downstream gates will report timeline integrity.'
        };
    }

    const latestTaskMode = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'TASK_MODE_ENTERED'
    );
    if (!latestTaskMode) {
        return {
            ready: true,
            nextGate: null,
            title: 'No task-mode cycle exists yet.',
            reason: 'No TASK_MODE_ENTERED event exists yet.'
        };
    }

    const isStartupRulePackEvent = (entry: TimelineEventEntry): boolean => {
        if (entry.event_type !== 'RULE_PACK_LOADED') {
            return false;
        }
        const stage = String(entry.details?.stage || '').trim().toUpperCase();
        return stage !== 'POST_PREFLIGHT';
    };
    const latestRulePack = findLatestTimelineEvent(
        events,
        (entry) => isStartupRulePackEvent(entry) && entry.sequence > latestTaskMode.sequence
    );
    if (!latestRulePack) {
        return {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, but no RULE_PACK_LOADED event exists after it. Load TASK_ENTRY rules before handshake, preflight, compile, review, or completion.`
        };
    }

    const latestHandshake = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED' && entry.sequence > latestRulePack.sequence
    );
    if (!latestHandshake) {
        return {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: `The latest TASK_MODE_ENTERED event is seq ${latestTaskMode.sequence}, and the latest startup rule-pack event is seq ${latestRulePack.sequence}, but no HANDSHAKE_DIAGNOSTICS_RECORDED event exists after them.`
        };
    }

    const latestShellSmoke = findLatestTimelineEvent(
        events,
        (entry) => entry.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED' && entry.sequence > latestHandshake.sequence
    );
    if (!latestShellSmoke) {
        return {
            ready: false,
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight for the current task-mode cycle.',
            reason: `The latest HANDSHAKE_DIAGNOSTICS_RECORDED event is seq ${latestHandshake.sequence}, but no SHELL_SMOKE_PREFLIGHT_RECORDED event exists after it.`
        };
    }

    return {
        ready: true,
        nextGate: null,
        title: 'Startup cycle is current.',
        reason: 'TASK_ENTRY rule-pack, handshake, and shell-smoke evidence are current for the latest task-mode cycle.'
    };
}

function findLatestTimelineEvent(
    events: TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

function getTimelineEventDetailString(
    event: TimelineEventEntry | null,
    fieldName: string
): string {
    const value = event?.details?.[fieldName];
    return typeof value === 'string' ? value.trim() : '';
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
    const currentWorkspace = readCurrentGitWorkspaceSnapshot(repoRoot, true);
    const currentChangedFiles = Array.isArray(currentWorkspace?.changed_files)
        ? currentWorkspace.changed_files
        : [];

    return {
        nextGate: 'enter-task-mode',
        title: 'Recover failed classify-change as orchestrator work.',
        reason:
            `Latest PREFLIGHT_FAILED event (seq ${latestPreflightFailure.sequence}) contains a protected control-plane recovery signal. ` +
            'Run the deterministic recovery command rebuilt from current task-mode and workspace state before reclassifying.',
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
    preflightPath: string
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

    const compileEvidence = safeReadJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`));
    const commandsPath = typeof compileEvidence?.commands_path === 'string' && compileEvidence.commands_path.trim()
        ? compileEvidence.commands_path.trim()
        : getDefaultCommandsPath(repoRoot);
    const outputFiltersPath = typeof compileEvidence?.output_filters_path === 'string' && compileEvidence.output_filters_path.trim()
        ? compileEvidence.output_filters_path.trim()
        : getDefaultOutputFiltersPath(repoRoot);
    const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
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

function buildCommand(label: string, command: string): NextStepCommand {
    return { label, command };
}

function buildNavigatorCommand(cliPrefix: string, taskId: string): string {
    return `${cliPrefix} next-step "${taskId}" --repo-root "."`;
}

function quoteCommandValue(value: string): string {
    const text = String(value);
    if (/["$`]/.test(text)) {
        if (process.platform === 'win32') {
            return `'${text.replace(/'/g, "''")}'`;
        }
        return `'${text.replace(/'/g, "'\\''")}'`;
    }
    return `"${text.replace(/\\/g, '\\\\')}"`;
}

function readTaskQueueEntry(repoRoot: string, taskId: string): TaskQueueEntry | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return null;
    }
    const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rowPattern = new RegExp(`^\\|\\s*${escapedTaskId}\\s*\\|`);
    for (const line of fs.readFileSync(taskPath, 'utf8').split('\n')) {
        if (!rowPattern.test(line)) {
            continue;
        }
        const cells = line
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 8) {
            return {
                taskId,
                title: null,
                profile: null
            };
        }
        return {
            taskId,
            title: cells[4] || null,
            profile: cells[7] || null
        };
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

function getTimelineReviewType(details: Record<string, unknown> | null): string {
    return String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
}

function getTimelineReviewerIdentity(details: Record<string, unknown> | null): string {
    return String(details?.reviewer_identity || details?.reviewerIdentity || '').trim();
}

function getTimelineReviewContextSha256(details: Record<string, unknown> | null): string {
    return String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase();
}

function getTimelineReviewFailure(eventType: string, details: Record<string, unknown> | null, outcome: string | null): boolean | null {
    const verdictToken = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    if (verdictToken.endsWith('FAILED')) {
        return true;
    }
    if (verdictToken.endsWith('PASSED')) {
        return false;
    }
    if (
        eventType === 'REVIEW_RECORDED'
        && String(details?.review_artifact_path || details?.reviewArtifactPath || '').trim()
    ) {
        return null;
    }
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (normalizedOutcome === 'FAIL') {
        return true;
    }
    if (normalizedOutcome === 'PASS') {
        return false;
    }
    return null;
}

function reviewRecordedArtifactHasFailToken(
    repoRoot: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    verdictCache: Map<string, boolean>
): boolean {
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    const artifactPathText = String(details?.review_artifact_path || details?.reviewArtifactPath || '').trim();
    if (!failToken || !artifactPathText) {
        return false;
    }
    const resolvedArtifactPath = path.isAbsolute(artifactPathText)
        ? path.resolve(artifactPathText)
        : path.resolve(repoRoot, artifactPathText);
    const resolvedRepoRoot = path.resolve(repoRoot);
    const relativeToRepo = path.relative(resolvedRepoRoot, resolvedArtifactPath);
    if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
        return false;
    }
    if (!fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        return false;
    }
    const cacheKey = `${reviewType}|${resolvedArtifactPath}`;
    const cached = verdictCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const file = fs.openSync(resolvedArtifactPath, 'r');
    let content = '';
    try {
        const buffer = Buffer.alloc(128 * 1024);
        const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
        content = buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        fs.closeSync(file);
    }
    if (!content.includes(failToken)) {
        verdictCache.set(cacheKey, false);
        return false;
    }
    const failed = extractReviewVerdictToken(content, REVIEW_VERDICT_PASS_TOKENS[reviewType] || null, failToken, reviewType) === failToken;
    verdictCache.set(cacheKey, failed);
    return failed;
}

function parseReviewCycleTimelineLine(line: string, sequence: number): TimelineEventEntry | null {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventType = String(parsed.event_type || '').trim().toUpperCase();
    if (!eventType) {
        return null;
    }
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details as Record<string, unknown>
        : null;
    return {
        event_type: eventType,
        outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(parsed.timestamp_utc || '').trim(),
        sequence,
        details
    };
}

interface ReviewCycleGuardReadResult {
    attempts: { reviewType: string; failed: boolean; passed: boolean }[];
    timelineValid: boolean;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

interface ReviewCycleGuardReadEvaluationResult {
    evaluation: ReviewCycleGuardEvaluation;
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null;
}

function getTimelineDetailText(details: Record<string, unknown> | null, fieldNames: string[]): string | null {
    for (const fieldName of fieldNames) {
        const value = details?.[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function buildLatestFailedReviewSummary(
    event: TimelineEventEntry,
    reviewType: string,
    details: Record<string, unknown> | null
): NextStepReviewCycleLatestFailedReview {
    return {
        review_type: reviewType,
        event_type: event.event_type,
        outcome: event.outcome || null,
        verdict_token: getTimelineDetailText(details, ['verdict_token', 'verdictToken']),
        reviewer_identity: getTimelineReviewerIdentity(details) || null,
        review_artifact_path: getTimelineDetailText(details, ['review_artifact_path', 'reviewArtifactPath']),
        summary: getTimelineDetailText(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
        sequence: event.sequence,
        timestamp_utc: event.timestamp_utc || null
    };
}

function readReviewCycleGuardAttempts(
    repoRoot: string,
    timelinePath: string,
    reviewCycleGuardConfig: ReturnType<typeof normalizeReviewCycleGuardConfig>
): ReviewCycleGuardReadResult {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            attempts: [],
            timelineValid: false,
            latestFailedReview: null
        };
    }

    const attemptsByKey = new Map<string, { reviewType: string; failed: boolean; passed: boolean }>();
    const verdictCache = new Map<string, boolean>();
    const excludedReviewTypes = new Set(reviewCycleGuardConfig.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    let malformedReviewCycleEvent = false;
    let guardLimitExceeded = false;
    let totalNonTestReviewCount = 0;
    let failedNonTestReviewCount = 0;
    let latestFailedReview: NextStepReviewCycleLatestFailedReview | null = null;
    let sequence = 0;
    let pending = '';
    const file = fs.openSync(resolvedPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);

    const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
            return false;
        }
        let event: TimelineEventEntry | null = null;
        try {
            event = parseReviewCycleTimelineLine(line, sequence);
        } catch {
            if (!guardLimitExceeded) {
                malformedReviewCycleEvent = true;
            }
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION' && !guardLimitExceeded;
        } finally {
            sequence += 1;
        }
        if (!event || !['REVIEWER_INVOCATION_ATTESTED', 'REVIEW_RECORDED'].includes(event.event_type)) {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            if (!guardLimitExceeded) {
                malformedReviewCycleEvent = true;
            }
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION' && !guardLimitExceeded;
        }
        const reviewerIdentity = getTimelineReviewerIdentity(event.details);
        const reviewContextSha256 = getTimelineReviewContextSha256(event.details);
        const key = reviewerIdentity && reviewContextSha256
            ? `${reviewType}|${reviewerIdentity}|${reviewContextSha256}`
            : `${event.event_type}:${event.sequence}`;
        const timelineFailure = getTimelineReviewFailure(event.event_type, event.details, event.outcome || null);
        const artifactFailed = timelineFailure == null && event.event_type === 'REVIEW_RECORDED'
            ? reviewRecordedArtifactHasFailToken(repoRoot, reviewType, event.details, verdictCache)
            : false;
        const failed = timelineFailure ?? artifactFailed;
        const hasReviewArtifactPath = Boolean(getTimelineDetailText(event.details, ['review_artifact_path', 'reviewArtifactPath']));
        const passed = !failed && (
            timelineFailure === false
            || (
                event.event_type === 'REVIEW_RECORDED'
                && event.outcome === 'PASS'
                && !hasReviewArtifactPath
            )
        );
        const existing = attemptsByKey.get(key);
        const existingFailed = Boolean(existing?.failed);
        const existingPassed = Boolean(existing?.passed);
        const nextFailed = Boolean(existingFailed || failed);
        const nextPassed = Boolean(!nextFailed && (existingPassed || passed));
        attemptsByKey.set(key, {
            reviewType,
            failed: nextFailed,
            passed: nextPassed
        });
        const countedReviewType = reviewType.trim().toLowerCase();
        const countsTowardGuard = countedReviewType && !excludedReviewTypes.has(countedReviewType);
        if (!existing && countsTowardGuard) {
            totalNonTestReviewCount += 1;
        }
        if (!existingFailed && nextFailed && countsTowardGuard) {
            failedNonTestReviewCount += 1;
            latestFailedReview = buildLatestFailedReviewSummary(event, countedReviewType, event.details);
        }
        guardLimitExceeded = guardLimitExceeded || (
            failedNonTestReviewCount > reviewCycleGuardConfig.max_failed_non_test_reviews
            || totalNonTestReviewCount > reviewCycleGuardConfig.max_total_non_test_reviews
        );
        return false;
    };

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead <= 0) {
                break;
            }
            pending += buffer.subarray(0, bytesRead).toString('utf8');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                pending = pending.slice(newlineIndex + 1);
                if (handleLine(line)) {
                    return {
                        attempts: [...attemptsByKey.values()],
                        timelineValid: !malformedReviewCycleEvent,
                        latestFailedReview
                    };
                }
                newlineIndex = pending.indexOf('\n');
            }
        } while (bytesRead > 0);
        if (pending.trim() && handleLine(pending.replace(/\r$/, ''))) {
            return {
                attempts: [...attemptsByKey.values()],
                timelineValid: !malformedReviewCycleEvent,
                latestFailedReview
            };
        }
    } finally {
        fs.closeSync(file);
    }

    return {
        attempts: [...attemptsByKey.values()],
        timelineValid: !malformedReviewCycleEvent,
        latestFailedReview
    };
}

function readReviewCycleGuardEvaluation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string
): ReviewCycleGuardReadEvaluationResult {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    let rawReviewCycleGuard: unknown = defaultWorkflowConfig.review_cycle_guard;
    const workflowConfig = readWorkflowConfigRecordForNextStep(repoRoot);
    if (workflowConfig?.review_cycle_guard !== undefined) {
        const validatedWorkflowConfig = validateWorkflowConfig({
            full_suite_validation: defaultWorkflowConfig.full_suite_validation,
            review_execution_policy: defaultWorkflowConfig.review_execution_policy,
            scope_budget_guard: defaultWorkflowConfig.scope_budget_guard,
            review_cycle_guard: workflowConfig.review_cycle_guard
        });
        rawReviewCycleGuard = isPlainRecord(validatedWorkflowConfig.review_cycle_guard)
            ? validatedWorkflowConfig.review_cycle_guard
            : defaultWorkflowConfig.review_cycle_guard;
    }
    const reviewCycleGuardConfig = normalizeReviewCycleGuardConfig(rawReviewCycleGuard);
    if (!reviewCycleGuardConfig.enabled) {
        return {
            evaluation: evaluateReviewCycleGuard(reviewCycleGuardConfig, {
                attempts: [],
                timelineValid: true
            }),
            latestFailedReview: null
        };
    }

    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const reviewCycleAttempts = readReviewCycleGuardAttempts(repoRoot, timelinePath, reviewCycleGuardConfig);

    return {
        evaluation: evaluateReviewCycleGuard(
            reviewCycleGuardConfig,
            {
                attempts: reviewCycleAttempts.attempts,
                timelineValid: reviewCycleAttempts.timelineValid
            }
        ),
        latestFailedReview: reviewCycleAttempts.latestFailedReview
    };
}

const REVIEW_CYCLE_OPERATOR_CHOICES = Object.freeze([
    'split_task',
    'mark_blocked',
    'raise_limits',
    'allow_one_more_cycle',
    'create_follow_up_tasks'
]);

const REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH = 'template/docs/prompts/review-cycle-auto-split.md';

function formatLatestFailedReviewForTemplate(latestFailedReview: NextStepReviewCycleLatestFailedReview | null): string {
    if (!latestFailedReview) {
        return 'none';
    }
    const parts = [
        `review_type=${formatNextStepInlineValue(latestFailedReview.review_type)}`,
        `event=${formatNextStepInlineValue(latestFailedReview.event_type)}`,
        `outcome=${formatNextStepInlineValue(latestFailedReview.outcome || 'unknown')}`,
        `sequence=${latestFailedReview.sequence}`
    ];
    if (latestFailedReview.review_artifact_path) {
        parts.push(`artifact=${formatNextStepInlineValue(latestFailedReview.review_artifact_path)}`);
    }
    if (latestFailedReview.summary) {
        parts.push(`summary=${formatNextStepInlineValue(latestFailedReview.summary)}`);
    }
    return parts.join('; ');
}

function readReviewCycleAutoSplitTemplate(repoRoot: string): string {
    const templatePath = path.join(resolveBundleRootForNextStep(repoRoot), REVIEW_CYCLE_AUTO_SPLIT_TEMPLATE_PATH);
    try {
        return fs.readFileSync(templatePath, 'utf8');
    } catch (error: unknown) {
        throw new Error(
            `Review-cycle auto-split prompt template is required but unreadable: ${normalizePath(templatePath)}. ` +
            `${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildReviewCycleAutoSplitPromptContent(
    repoRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): string {
    const replacements: Record<string, string> = {
        TASK_ID: taskId,
        GUARD_REASON: formatNextStepInlineValue(evaluation.summary_line),
        TOTAL_NON_TEST_REVIEWS: String(evaluation.total_non_test_review_count),
        FAILED_NON_TEST_REVIEWS: String(evaluation.failed_non_test_review_count),
        EXCLUDED_REVIEW_TYPES: formatNextStepInlineList(evaluation.excluded_review_types),
        LATEST_FAILED_REVIEW: formatLatestFailedReviewForTemplate(latestFailedReview)
    };
    const template = readReviewCycleAutoSplitTemplate(repoRoot);
    return `${template.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key: string) => replacements[key] ?? match).trimEnd()}\n`;
}

function materializeReviewCycleAutoSplitPrompt(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): NextStepReviewCycleAutoSplitPrompt {
    const artifactPath = path.join(reviewsRoot, `${taskId}-review-cycle-auto-split-prompt.md`);
    const content = buildReviewCycleAutoSplitPromptContent(repoRoot, taskId, evaluation, latestFailedReview);
    fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
    if (!fs.existsSync(artifactPath) || fs.readFileSync(artifactPath, 'utf8') !== content) {
        fs.writeFileSync(artifactPath, content, 'utf8');
    }
    return {
        kind: 'review_cycle_auto_split_prompt',
        artifact_path: normalizePath(path.relative(repoRoot, artifactPath)),
        artifact_sha256: createHash('sha256').update(content).digest('hex'),
        next_action: 'follow_auto_split_prompt',
        instructions: [
            'move_parent_to_blocked_split_state',
            'commit_only_completed_reviewed_work_if_required',
            'create_maximally_small_numeric_child_tasks',
            'execute_child_tasks_sequentially'
        ],
        constraints: [
            'do_not_auto_commit_unfinished_or_unreviewed_work',
            'do_not_mark_parent_done_because_split_exists',
            'preserve_review_cycle_block_reason',
            'stop_if_split_cannot_proceed_cleanly'
        ]
    };
}

function buildReviewCycleOperatorBlock(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    evaluation: ReviewCycleGuardEvaluation,
    latestFailedReview: NextStepReviewCycleLatestFailedReview | null
): NextStepReviewCycleBlock {
    const countsByReviewType = Object.fromEntries(
        Object.entries(evaluation.counts_by_review_type)
            .sort(([left], [right]) => left.localeCompare(right))
            .map(([reviewType, counts]) => [
                reviewType,
                {
                    total: counts.total,
                    failed: counts.failed,
                    passed: counts.passed,
                    pending: counts.pending
                }
            ])
    );
    const autoSplitEnabled = evaluation.action === 'BLOCK_FOR_OPERATOR_DECISION'
        && evaluation.violations.length > 0
        && evaluation.active
        && evaluation.auto_split_enabled === true;
    const autoSplitPrompt = autoSplitEnabled
        ? materializeReviewCycleAutoSplitPrompt(repoRoot, reviewsRoot, taskId, evaluation, latestFailedReview)
        : null;

    return {
        kind: 'review_cycle_guard',
        operator_decision_required: !autoSplitEnabled,
        wait_for_operator: !autoSplitEnabled,
        auto_split_enabled: autoSplitEnabled,
        reason: evaluation.summary_line,
        total_non_test_review_count: evaluation.total_non_test_review_count,
        failed_non_test_review_count: evaluation.failed_non_test_review_count,
        counts_by_review_type: countsByReviewType,
        excluded_review_types: evaluation.excluded_review_types,
        latest_failed_review: latestFailedReview,
        choices: [...REVIEW_CYCLE_OPERATOR_CHOICES],
        auto_split_prompt: autoSplitPrompt
    };
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

    let resolvedSelection: ReturnType<typeof resolveTaskProfileSelection>['selection'] | null = null;
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
    const explicitProvider = normalizeProviderId(process.env.GARDA_EXECUTION_PROVIDER);
    if (explicitProvider) {
        return explicitProvider;
    }
    if (process.env.CODEX_THREAD_ID || process.env.CODEX_HOME) {
        return 'Codex';
    }
    if (process.env.CLAUDE_CODE_SSE_PORT) {
        return 'Claude';
    }
    if (process.env.CURSOR_TRACE_ID || process.env.CURSOR_AGENT) {
        return 'Cursor';
    }
    return null;
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
        `--task-summary ${quoteCommandValue(taskEntry?.title || taskId)}`,
        '--start-banner "Garda captures my mind"'
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
    const parts = [
        `${cliPrefix} gate doc-impact-gate`,
        `--task-id ${quoteCommandValue(taskId)}`,
        `--preflight-path ${quoteCommandValue(preflightCommandPath)}`
    ];
    if (docsUpdated.length > 0) {
        parts.push('--decision "DOCS_UPDATED"');
        parts.push('--behavior-changed false');
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
        ? '--rationale "Documentation or changelog files were changed in the current preflight; next-step records them without requiring a fresh code/test review when non-doc scope is unchanged."'
        : '--rationale "No user-facing documentation impact detected by next-step; adjust this command before running if docs or behavior changed."');
    parts.push('--repo-root "."');
    return parts.join(' ');
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
        if (typeof sequence !== 'number' || !Number.isFinite(sequence)) {
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
        `--start-banner ${quoteCommandValue(getStringField(taskMode, 'start_banner', '<repo-owned-banner>'))}`,
        `--provider ${quoteCommandValue(getStringField(taskMode, 'provider', '<provider>'))}`
    ];
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
    if (plannedChangedFiles.length > 0) {
        return plannedChangedFiles;
    }
    const detectionSource = String(preflight?.detection_source || '').trim().toLowerCase();
    if (detectionSource === 'explicit_changed_files') {
        return getPreflightChangedFiles(preflight);
    }
    return [];
}

function buildClassifyChangeCommand(params: {
    cliPrefix: string;
    taskId: string;
    taskMode: Record<string, unknown> | null;
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
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
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
        review: params.review,
        audit_status: params.auditStatus,
        profile: params.profile,
        warnings: params.warnings || [],
        review_cycle_block: params.reviewCycleBlock || null,
        final_report: params.finalReport || null
    };
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
    review: NextStepReviewSummary;
    auditStatus: TaskAuditSummaryResult['status'];
    profile: NextStepProfileSummary | null;
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
        review: params.review,
        auditStatus: params.auditStatus,
        profile: params.profile
    });
}

function buildFinalReportOrder(summary: TaskAuditSummaryResult, commitCommandSuggestion: string, commitQuestion: string): string[] {
    const requirements = summary.final_report_contract.implementation_summary_requirements
        .map((entry) => String(entry || '').trim())
        .filter(Boolean);
    const implementationSummary = requirements.length > 0
        ? `implementation summary (include ${requirements.join(', ')})`
        : 'implementation summary';
    return [
        implementationSummary,
        commitCommandSuggestion,
        commitQuestion
    ];
}

function finalCloseoutMatchesCurrentCycle(
    expected: TaskAuditSummaryResult['final_closeout']['cycle_binding'] | null | undefined,
    actualPayload: Record<string, unknown>,
    repoRoot: string
): boolean {
    const expectedBinding = expected || null;
    const actualBinding = getCycleBindingSnapshotFromPayload(actualPayload, repoRoot);
    if (!expectedBinding?.compile_gate_timestamp || !actualBinding?.compile_gate_timestamp) {
        return false;
    }
    if (actualBinding.compile_gate_timestamp !== expectedBinding.compile_gate_timestamp) {
        return false;
    }
    if (expectedBinding.preflight_sha256 && actualBinding.preflight_sha256 !== expectedBinding.preflight_sha256) {
        return false;
    }
    if (expectedBinding.preflight_path && actualBinding.preflight_path !== expectedBinding.preflight_path) {
        return false;
    }
    return true;
}

function readReadyFinalReportSummary(
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    summary: TaskAuditSummaryResult
): NextStepFinalReportSummary | null {
    const closeoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
    const closeoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
    if (!fileExists(closeoutJsonPath) || !fileExists(closeoutMarkdownPath)) {
        return null;
    }

    const closeout = safeReadJson(closeoutJsonPath);
    if (!isPlainRecord(closeout)) {
        return null;
    }
    if (String(closeout.task_id || '').trim() !== taskId) {
        return null;
    }
    if (String(closeout.status || '').trim().toUpperCase() !== 'READY') {
        return null;
    }
    if (!finalCloseoutMatchesCurrentCycle(summary.final_closeout.cycle_binding, closeout, repoRoot)) {
        return null;
    }

    const commitCommandSuggestion = typeof closeout.commit_command_suggestion === 'string' && closeout.commit_command_suggestion.trim()
        ? closeout.commit_command_suggestion.trim()
        : summary.final_report_contract.commit_command_suggestion;
    const commitQuestion = typeof closeout.commit_question === 'string' && closeout.commit_question.trim()
        ? closeout.commit_question.trim()
        : summary.final_report_contract.commit_question;

    return {
        closeout_json_path: toRepoDisplayPath(repoRoot, closeoutJsonPath),
        closeout_markdown_path: toRepoDisplayPath(repoRoot, closeoutMarkdownPath),
        required_order: buildFinalReportOrder(summary, commitCommandSuggestion, commitQuestion),
        commit_command_suggestion: commitCommandSuggestion,
        commit_question: commitQuestion
    };
}

function buildTaskEntryRulePackCommand(repoRoot: string, cliPrefix: string, taskId: string): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "TASK_ENTRY"',
        `--loaded-rule-file "${buildBundleRelativePath(repoRoot, 'live/docs/agent-rules/00-core.md')}"`,
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
    ruleFileNames: string[]
): string {
    return [
        `${cliPrefix} gate load-rule-pack`,
        `--task-id "${taskId}"`,
        '--stage "POST_PREFLIGHT"',
        `--preflight-path "${buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`)}"`,
        ...ruleFileNames.map((fileName) => (
            `--loaded-rule-file "${buildBundleRelativePath(repoRoot, `live/docs/agent-rules/${fileName}`)}"`
        )),
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

export function resolveNextStep(options: NextStepOptions): NextStepResult {
    const repoRoot = path.resolve(options.repoRoot || '.');
    const taskId = assertValidTaskId(options.taskId);
    const reviewsRoot = resolveReviewsRoot(repoRoot, options.reviewsRoot);
    const eventsRoot = resolveEventsRoot(repoRoot, options.eventsRoot);
    const cliPrefix = buildCliPrefix(repoRoot);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const preflightCommandPath = buildBundleRelativePath(repoRoot, `runtime/reviews/${taskId}-preflight.json`);
    const navigatorCommand = buildNavigatorCommand(cliPrefix, taskId);
    const rulePackPath = path.join(reviewsRoot, `${taskId}-rule-pack.json`);
    const preflight = safeReadJson(preflightPath);
    const rulePack = safeReadJson(rulePackPath);
    const taskMode = safeReadJson(path.join(reviewsRoot, `${taskId}-task-mode.json`));
    const taskEntry = readTaskQueueEntry(repoRoot, taskId);
    const defaultExecutionProvider = resolveProviderFromEnvironment();
    const profileSummary = buildNextStepProfileSummary(repoRoot, taskEntry, taskMode, preflight);
    try {
        readWorkflowConfigRecordForNextStep(repoRoot);
    } catch (error: unknown) {
        const fallbackFullSuiteConfig = loadFullSuiteValidationConfig(repoRoot);
        const coreArtifacts = artifactState(repoRoot, [
            { key: 'task-mode', path: path.join(reviewsRoot, `${taskId}-task-mode.json`) },
            { key: 'rule-pack', path: rulePackPath },
            { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
            { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
            { key: 'preflight', path: preflightPath },
            { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
            { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
            { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
            { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
            { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
        ]);
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
                config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
                config_source: 'effective_workflow_config',
                note: 'Full-suite validation is unavailable until workflow config validation passes.'
            },
            review: {
                required_reviews: [],
                review_execution_policy_mode: LEGACY_REVIEW_EXECUTION_POLICY_MODE,
                review_execution_policy_source: 'workflow_config_fallback',
                next_review_type: null,
                blocked_review_dependencies: [],
                ordinary_doc_review_skips: [],
                trust: null,
                trust_note: 'Review trust is unavailable until workflow config validation passes.'
            },
            auditStatus: 'INCOMPLETE',
            profile: profileSummary,
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
    const fullSuiteSummary: NextStepFullSuiteSummary = {
        enabled: fullSuiteConfig.enabled,
        command: fullSuiteConfig.command,
        config_path: toRepoDisplayPath(repoRoot, resolveWorkflowConfigPath(repoRoot)),
        config_source: 'effective_workflow_config',
        note: fullSuiteConfig.enabled
            ? 'Full-suite validation is mandatory because the effective workflow config enables it.'
            : 'Full-suite validation is disabled in the effective workflow config.'
    };
    const requiredReviewTypes = getRequiredReviewTypes(summary.required_reviews);
    const reviewPolicy = resolveReviewPolicy(preflight);
    const preflightSha256 = fileExists(preflightPath) ? fileSha256(preflightPath) : null;
    const reviewStates = requiredReviewTypes.map((reviewType) => (
        readReviewArtifactState(reviewsRoot, taskId, reviewType, preflightPath, preflightSha256, preflight)
    ));
    const nextReview = getNextReviewType(
        repoRoot,
        requiredReviewTypes,
        reviewPolicy.mode,
        summary.required_reviews,
        reviewStates,
        eventsRoot,
        taskId
    );
    const reviewTrust = readReviewTrust(reviewsRoot, taskId, requiredReviewTypes, summary.scope_category);
    const reviewSummary: NextStepReviewSummary = {
        required_reviews: requiredReviewTypes,
        review_execution_policy_mode: reviewPolicy.mode,
        review_execution_policy_source: reviewPolicy.source,
        next_review_type: nextReview.reviewType,
        blocked_review_dependencies: nextReview.blockedDependencies,
        ordinary_doc_review_skips: getOrdinaryDocReviewSkips(preflight),
        trust: reviewTrust,
        trust_note: reviewTrust?.visible_summary_line || (
            requiredReviewTypes.length > 0
                ? 'Review trust is unavailable until required review receipts exist.'
                : null
        )
    };
    const coreArtifacts = artifactState(repoRoot, [
        { key: 'task-mode', path: path.join(reviewsRoot, `${taskId}-task-mode.json`) },
        { key: 'rule-pack', path: rulePackPath },
        { key: 'handshake', path: path.join(reviewsRoot, `${taskId}-handshake.json`) },
        { key: 'shell-smoke', path: path.join(reviewsRoot, `${taskId}-shell-smoke.json`) },
        { key: 'preflight', path: preflightPath },
        { key: 'compile-gate', path: path.join(reviewsRoot, `${taskId}-compile-gate.json`) },
        { key: 'review-gate', path: path.join(reviewsRoot, `${taskId}-review-gate.json`) },
        { key: 'doc-impact', path: path.join(reviewsRoot, `${taskId}-doc-impact.json`) },
        { key: 'full-suite-validation', path: path.join(reviewsRoot, `${taskId}-full-suite-validation.json`) },
        { key: 'completion-gate', path: path.join(reviewsRoot, `${taskId}-completion-gate.json`) }
    ]);

    const sourceRuntimeStaleness = detectSourceCheckoutRuntimeStaleness(repoRoot);
    const resultBase = {
        taskId,
        navigatorCommand,
        missingArtifacts: coreArtifacts.missing,
        presentArtifacts: coreArtifacts.present,
        fullSuite: fullSuiteSummary,
        review: reviewSummary,
        profile: profileSummary,
        auditStatus: summary.status,
        warnings: [] as string[],
        sourceRuntimeStaleness
    };
    if (isGatePassed(summary, 'completion-gate') && isLatestCompletionCurrent(eventsRoot, taskId)) {
        const finalReport = readReadyFinalReportSummary(repoRoot, reviewsRoot, taskId, summary);
        if (finalReport) {
            return buildResult({
                ...resultBase,
                status: 'DONE',
                nextGate: null,
                title: 'Task gate flow is complete.',
                reason: 'Completion gate passed and the canonical final closeout is materialized. Deliver the final report in the required order below; do not auto-commit without explicit user approval.',
                commands: [],
                finalReport
            });
        }
        return buildResult({
            ...resultBase,
            status: 'READY',
            nextGate: 'task-audit-summary',
            title: 'Materialize final closeout before stopping.',
            reason: 'Completion gate passed, but the canonical final closeout artifacts are not materialized yet. Run task-audit-summary to materialize the final report order and commit guidance before stopping.',
            commands: [
                buildCommand(
                    'Build final audit summary',
                    `${cliPrefix} gate task-audit-summary --task-id "${taskId}" --repo-root "."`
                )
            ],
            finalReport: null
        });
    }

    if (!isGatePassed(summary, 'enter-task-mode')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Enter task mode first.',
            reason: defaultExecutionProvider
                ? 'No TASK_MODE_ENTERED event exists for this task.'
                : 'No TASK_MODE_ENTERED event exists for this task, and runtime provider could not be detected from GARDA_EXECUTION_PROVIDER or known provider environment markers. Set GARDA_EXECUTION_PROVIDER to the current execution provider before running the command; do not use SourceOfTruth as a runtime-provider fallback.',
            commands: [
                buildCommand(
                    'Enter task mode',
                    buildEnterTaskModeCommand(cliPrefix, taskId, taskEntry, defaultExecutionProvider)
                )
            ]
        });
    }

    const startupCycleReadiness = readStartupCycleReadiness(eventsRoot, taskId);
    if (!startupCycleReadiness.ready) {
        const command = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId)
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`
                : `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`;
        const label = startupCycleReadiness.nextGate === 'load-rule-pack'
            ? 'Load TASK_ENTRY rules'
            : startupCycleReadiness.nextGate === 'handshake-diagnostics'
                ? 'Run handshake diagnostics'
                : 'Run shell smoke preflight';
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: startupCycleReadiness.nextGate,
            title: startupCycleReadiness.title,
            reason: startupCycleReadiness.reason,
            commands: [buildCommand(label, command)]
        });
    }

    if (!isGatePassed(summary, 'load-rule-pack') || resolveRulePackStage(rulePack) !== 'TASK_ENTRY' && !preflight) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record TASK_ENTRY rule files.',
            reason: 'Task execution must record the loaded core workflow rule pack before preflight.',
            commands: [buildCommand('Load TASK_ENTRY rules', buildTaskEntryRulePackCommand(repoRoot, cliPrefix, taskId))]
        });
    }

    if (!isGatePassed(summary, 'handshake-diagnostics')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics.',
            reason: 'Runtime identity and reviewer launchability have not been recorded.',
            commands: [
                buildCommand('Run handshake diagnostics', `${cliPrefix} gate handshake-diagnostics --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

    if (!isGatePassed(summary, 'shell-smoke-preflight')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'shell-smoke-preflight',
            title: 'Run shell smoke preflight.',
            reason: 'CLI launchability and filesystem probes have not been recorded.',
            commands: [
                buildCommand('Run shell smoke preflight', `${cliPrefix} gate shell-smoke-preflight --task-id "${taskId}" --repo-root "."`)
            ]
        });
    }

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

        const classifyCommand = buildClassifyChangeCommand({
            cliPrefix,
            taskId,
            taskMode,
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

    const preflightCycleReadiness = readPreflightCycleReadiness(eventsRoot, taskId);
    if (!preflightCycleReadiness.ready) {
        const classifyCommand = buildClassifyChangeCommand({
            cliPrefix,
            taskId,
            taskMode,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: getPreflightRefreshChangedFiles(taskMode, preflight)
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current task cycle.',
            reason: preflightCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
                    classifyCommand
                )
            ]
        });
    }

    if (
        preflightTouchesProtectedControlPlane(preflight)
        && !taskMode?.orchestrator_work
    ) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode as orchestrator work.',
            reason: 'The current preflight touches protected orchestrator control-plane files, but task-mode evidence does not declare --orchestrator-work.',
            commands: [
                buildCommand(
                    'Restart task mode with orchestrator work',
                    buildOrchestratorWorkRestartCommand(cliPrefix, taskId, taskMode)
                )
            ]
        });
    }

    const failedCurrentReviewStateForPreflight = nextReview.reviewType
        ? reviewStates.find((candidate) => candidate.reviewType === nextReview.reviewType && candidate.failed)
        : undefined;
    const preflightWorkspaceReadiness = preflight
        ? readPreflightWorkspaceReadiness(repoRoot, preflight, {
            failedReviewType: failedCurrentReviewStateForPreflight?.reviewType || null,
            failedReviewVerdict: failedCurrentReviewStateForPreflight?.verdictToken || failedCurrentReviewStateForPreflight?.failToken || null,
            docImpactPath: path.join(reviewsRoot, `${taskId}-doc-impact.json`)
        })
        : { ready: false, reason: 'No current preflight exists.' };
    if (!preflightWorkspaceReadiness.ready) {
        const classifyCommand = buildClassifyChangeCommand({
            cliPrefix,
            taskId,
            taskMode,
            preflightCommandPath,
            includePlannedScope: false,
            changedFiles: preflightWorkspaceReadiness.currentChangedFiles
                ?? getPreflightRefreshChangedFiles(taskMode, preflight)
        });
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'classify-change',
            title: 'Refresh preflight for the current workspace.',
            reason: preflightWorkspaceReadiness.reason,
            commands: [
                buildCommand(
                    'Refresh preflight',
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
        preflightPath
    );
    if (!coherentCycleReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'restart-coherent-cycle',
            title: 'Restart the latest coherent task cycle.',
            reason: coherentCycleReadiness.reason,
            commands: [
                buildCommand(
                    'Restart coherent cycle',
                    coherentCycleReadiness.command || navigatorCommand
                )
            ]
        });
    }

    const postPreflightRulePackReadiness = readPostPreflightRulePackReadiness(
        repoRoot,
        taskId,
        preflightPath,
        rulePackPath
    );
    if (resolveRulePackStage(rulePack) !== 'POST_PREFLIGHT' || !postPreflightRulePackReadiness.ready) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'load-rule-pack',
            title: 'Record POST_PREFLIGHT rule files.',
            reason: postPreflightRulePackReadiness.ready
                ? 'Preflight exists; downstream rule files and risk-specific packs must be recorded for the current scope.'
                : postPreflightRulePackReadiness.reason,
            commands: [
                buildCommand(
                    'Load POST_PREFLIGHT rules',
                    buildPostPreflightRulePackCommandForFiles(
                        repoRoot,
                        cliPrefix,
                        taskId,
                        getPostPreflightRuleFileNames(preflight, taskMode)
                    )
                )
            ]
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
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'scope-budget-decomposition-guard',
            title: 'Split or decompose the task before expensive gates.',
            reason:
                `${scopeBudgetGuardEvaluation.summary_line}. ` +
                'The configured workflow budget requires decomposition before compile, review, or full-suite gates continue.',
            commands: [
                buildCommand(
                    'Inspect scope budget guard',
                    `${cliPrefix} workflow explain --target-root "."`
                )
            ]
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
        const reviewCycleBlock = buildReviewCycleOperatorBlock(
            repoRoot,
            reviewsRoot,
            taskId,
            reviewCycleGuardEvaluation,
            latestFailedReviewCycleAttempt
        );
        const autoSplitEnabled = reviewCycleBlock.auto_split_enabled;
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: autoSplitEnabled ? 'review-cycle-auto-split' : 'review-cycle-attempt-guard',
            title: autoSplitEnabled ? 'Review cycle limit exceeded; auto-split prompt is ready.' : 'Review cycle limit exceeded.',
            reason:
                `${reviewCycleGuardEvaluation.summary_line}. ` +
                `Counts: total_non_test_reviews=${reviewCycleGuardEvaluation.total_non_test_review_count}, ` +
                `failed_non_test_reviews=${reviewCycleGuardEvaluation.failed_non_test_review_count}, ` +
                `excluded_review_types=${formatNextStepInlineList(reviewCycleGuardEvaluation.excluded_review_types)}. ` +
                (autoSplitEnabled
                    ? 'The configured workflow guard blocks parent compile, review, or full-suite continuation; follow the auto-split prompt artifact before continuing child work.'
                    : 'The configured workflow guard blocks additional compile, review, or full-suite continuation until operator decision; wait for the operator before continuing.'),
            commands: autoSplitEnabled
                ? []
                : [
                    buildCommand(
                        'Inspect review cycle guard',
                        `${cliPrefix} workflow explain --target-root "."`
                    )
                ],
            reviewCycleBlock
        });
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

    const compileReadiness = preflight
        ? readCompileReadiness(repoRoot, reviewsRoot, taskId, preflightPath)
        : { ready: false, reason: 'No current preflight exists.' };
    if (!isGatePassed(summary, 'compile-gate') || !compileReadiness.ready) {
        const compileCommand = `${cliPrefix} gate compile-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'compile-gate',
            title: 'Run compile gate.',
            reason: compileReadiness.reason,
            commands: [
                buildCommand(
                    'Run compile gate',
                    compileCommand
                )
            ]
        });
    }

    const fullSuiteGateStatus = getGateStatus(summary, 'full-suite-validation');
    if (fullSuiteConfig.enabled && nextReview.reviewType === 'test') {
        if (fullSuiteGateStatus === 'FAIL') {
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
        if (!isGatePassed(summary, 'full-suite-validation')) {
            const fullSuiteCommand = `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'full-suite-validation',
                title: 'Run full-suite validation before test review.',
                reason:
                    `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path}. ` +
                    `Run it before launching the mandatory test reviewer so suite failures fail fast on the same compiled scope. ` +
                    `The final closeout can reuse this artifact only if no relevant task scope changes occur afterward. Command: ${fullSuiteConfig.command}.`,
                commands: [
                    buildCommand(
                        'Run full-suite validation',
                        fullSuiteCommand
                    )
                ]
            });
        }
    }

    if (nextReview.reviewType) {
        const reviewType = nextReview.reviewType;
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
        const dependencies = nextReview.blockedDependencies;
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
            state
        );
        if (dependencies.length > 0) {
            const dependencyDetails = describeBlockedReviewDependencies(dependencies, reviewStates);
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Review '${reviewType}' is waiting for upstream review evidence.`,
                reason: `Configured review policy '${reviewPolicy.mode}' requires upstream PASS evidence before '${reviewType}': ${dependencyDetails}. Do not launch '${reviewType}' reviewer until those dependencies pass. ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Finish upstream review first',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && currentReviewRecordedEvidenceCurrent) {
            const downstreamReviewTypes = getDownstreamReviewTypesFor(
                reviewType,
                requiredReviewTypes,
                summary.required_reviews,
                reviewPolicy.mode
            );
            const downstreamText = downstreamReviewTypes.length > 0
                ? ` Dependent reviews currently blocked by this failure: ${downstreamReviewTypes.join(', ')}.`
                : '';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'implementation',
                title: `Fix failed '${reviewType}' review findings before continuing.`,
                reason:
                    `Recorded '${reviewType}' review verdict is '${state.verdictToken || state.failToken || 'FAILED'}'. ` +
                    `Do not launch downstream reviewers or rerun '${reviewType}' before implementation changes are made. ` +
                    `Fix the findings, rerun compile-gate, then rebuild and rerun '${reviewType}' review.${downstreamText}`,
                commands: [
                    buildCommand(
                        'Rerun navigator after fixing implementation',
                        navigatorCommand
                    )
                ]
            });
        }
        if (state?.failed && !currentReviewRecordedEvidenceCurrent && !currentReviewContextPrepared) {
            if (!scopedDiffReadiness.ready) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'build-scoped-diff',
                    title: `Prepare '${reviewType}' scoped diff metadata.`,
                    reason:
                        `${scopedDiffReadiness.reason} A previous '${reviewType}' review recorded ` +
                        `'${state.verdictToken || state.failToken || 'FAILED'}', but scoped diff metadata must be refreshed ` +
                        `before rebuilding '${reviewType}' review context. ${reviewerReadinessChain}`,
                    commands: [
                        buildCommand(
                            'Build scoped diff',
                            `${cliPrefix} gate build-scoped-diff --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --output-path "${toRepoDisplayPath(repoRoot, scopedDiffOutputPath)}" --metadata-path "${toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)}" --repo-root "."`
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Refresh '${reviewType}' review context after implementation changes.`,
                reason:
                    `A previous '${reviewType}' review recorded '${state.verdictToken || state.failToken || 'FAILED'}', ` +
                    'but that failed-review routing is no longer current after the latest compile cycle. ' +
                    `Rebuild '${reviewType}' review context and launch a fresh reviewer before any dependent reviews. ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Build review context',
                        `${cliPrefix} gate build-review-context --review-type "${reviewType}" --depth "${reviewDepth}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
        if (!state || !state.contextExists || !state.contextCurrent) {
            const contextDetails = state?.violations
                .filter((violation) => violation.includes('review context'))
                .join(' ');
            const contextDetailsSuffix = contextDetails ? ` ${contextDetails}` : '';
            if (!scopedDiffReadiness.ready) {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'build-scoped-diff',
                    title: `Prepare '${reviewType}' scoped diff metadata.`,
                    reason: `${scopedDiffReadiness.reason} Required '${reviewType}' review contexts for code-changing scopes must include scoped diff metadata before reviewer routing. ${reviewerReadinessChain}`,
                    commands: [
                        buildCommand(
                            'Build scoped diff',
                            `${cliPrefix} gate build-scoped-diff --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --output-path "${toRepoDisplayPath(repoRoot, scopedDiffOutputPath)}" --metadata-path "${toRepoDisplayPath(repoRoot, scopedDiffMetadataPath)}" --repo-root "."`
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'build-review-context',
                title: `Prepare '${reviewType}' review context.`,
                reason: !state || !state.contextExists
                    ? `Required review '${reviewType}' has no canonical review-context artifact. ${reviewerReadinessChain}`
                    : `Required review '${reviewType}' review-context artifact is stale for the current preflight.${contextDetailsSuffix} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Build review context',
                        `${cliPrefix} gate build-review-context --review-type "${reviewType}" --depth "${reviewDepth}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                    )
                ]
            });
        }
        const contextReviewerIdentity = state.contextReviewerIdentity || '';
        const reviewOutputPath = buildDefaultReviewScratchCommandPath(
            repoRoot,
            taskId,
            reviewType,
            'review-output.md'
        );
        if (
            !currentReviewReuseRecorded
            && (
                !contextReviewerIdentity.startsWith('agent:')
                || !timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, contextReviewerIdentity)
            )
        ) {
            const reviewerIdentity = contextReviewerIdentity || '<agent:reviewer-session-id-from-delegated-agent>';
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-routing',
                title: `Record '${reviewType}' delegated reviewer routing.`,
                reason: `Required review '${reviewType}' needs current REVIEWER_DELEGATION_ROUTED telemetry after the latest compile pass before a review receipt can be recorded. ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION} ${REVIEWER_FRESH_CONTEXT_LAUNCH_INSTRUCTION} ${REVIEWER_SESSION_REUSE_BOUNDARY_INSTRUCTION} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Record fresh delegated review routing',
                        `${cliPrefix} gate record-review-routing --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
        if (
            !currentReviewReuseRecorded
            && !currentReviewContextInvocationAttested
            && (
                !state.artifactExists
                || !state.receiptExists
                || state.reviewerIdentity !== state.contextReviewerIdentity
                || state.ready
            )
        ) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const launchArtifactPath = buildDefaultReviewScratchCommandPath(
                repoRoot,
                taskId,
                reviewType,
                'reviewer-launch.json'
            );
            const launchArtifactState = getCurrentReviewerLaunchArtifactStateForInvocation(
                repoRoot,
                eventsRoot,
                taskId,
                state
            );
            if (launchArtifactState === 'missing_or_invalid') {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                    nextGate: 'prepare-reviewer-launch',
                    title: `Prepare '${reviewType}' delegated reviewer launch metadata.`,
                    reason: `Required review '${reviewType}' needs task-owned reviewer launch metadata bound to the current routing event and review context before launch. This prepares hashes and prompt paths only; it is not completed invocation evidence. ${reviewerReadinessChain}`,
                    commands: [
                        buildCommand(
                            'Prepare delegated reviewer launch metadata',
                            `${cliPrefix} gate prepare-reviewer-launch --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --reviewer-launch-artifact-path "${launchArtifactPath}" --repo-root "."`
                        )
                    ]
                });
            }
            if (launchArtifactState === 'prepared') {
                return buildResult({
                    ...resultBase,
                    status: 'BLOCKED',
                nextGate: 'complete-reviewer-launch',
                title: `Complete '${reviewType}' delegated reviewer launch metadata.`,
                reason:
                    `Required review '${reviewType}' has prepared launch metadata for the current routing event and review context. ` +
                    `Launch the delegated reviewer with the prepared prompt path as an opaque handoff, then run complete-reviewer-launch to persist the post-launch fields before recording the invocation. ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Complete delegated reviewer launch metadata',
                            `${cliPrefix} gate complete-reviewer-launch --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --reviewer-launch-artifact-path "${launchArtifactPath}" --provider-invocation-id "<actual-invocation-id>" --launched-at-utc "<ISO-8601>" --attestation-source "<provider-source>" --fork-context false --repo-root "."`
                        )
                    ]
                });
            }
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-invocation',
                title: `Record '${reviewType}' delegated reviewer launch attestation.`,
                reason:
                    `Required review '${reviewType}' has launch metadata for the current routing event and review context. ` +
                    `The launch artifact already contains completed launch evidence; record that evidence with record-review-invocation. ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Record delegated reviewer launch attestation',
                        `${cliPrefix} gate record-review-invocation --task-id "${taskId}" --review-type "${reviewType}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --reviewer-launch-artifact-path "${launchArtifactPath}" --repo-root "."`
                    )
                ]
            });
        }
        if (!state.ready) {
            const stateViolations = state.violations.length > 0
                ? state.violations.join('; ')
                : 'review artifact or receipt is missing';
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
                buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
            );
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `Required review '${reviewType}' needs a valid delegated artifact and receipt (${stateViolations}). ${acceptedVerdictTokens} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        `${cliPrefix} gate record-review-result --task-id "${taskId}" --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --review-output-path "${reviewOutputPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
        if (!currentReviewEvidenceSatisfied) {
            const reviewerIdentity = state.contextReviewerIdentity
                || '<agent:reviewer-session-id-from-review-context>';
            const acceptedVerdictTokens = formatAcceptedReviewVerdictTokens(
                buildReviewVerdictTokenSet(reviewType, state.passToken || null, state.failToken || null)
            );
            const missingEvidenceReason = state.reusedExistingReview && !currentReviewReuseRecorded
                ? `Required review '${reviewType}' is reused, but current-cycle REVIEW_RECORDED reuse telemetry is missing or does not match the receipt, review artifact, review context, and tree-state provenance, so rerun review reuse materialization or record a fresh delegated review result.`
                : `Required review '${reviewType}' has stale or invalid reviewer_provenance; matching REVIEWER_INVOCATION_ATTESTED launch telemetry is missing for the current receipt, so rerun reviewer output materialization after valid launch telemetry exists.`;
            return buildResult({
                ...resultBase,
                status: 'BLOCKED',
                nextGate: 'record-review-result',
                title: `Record '${reviewType}' review result from a delegated reviewer.`,
                reason: `${missingEvidenceReason} ${acceptedVerdictTokens} ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION} ${reviewerReadinessChain}`,
                commands: [
                    buildCommand(
                        'Record delegated review output, then close reviewer',
                        `${cliPrefix} gate record-review-result --task-id "${taskId}" --review-type "${reviewType}" --preflight-path "${preflightCommandPath}" --review-output-path "${reviewOutputPath}" --reviewer-execution-mode "delegated_subagent" --reviewer-identity "${reviewerIdentity}" --repo-root "."`
                    )
                ]
            });
        }
    }

    if (!isGatePassed(summary, 'required-reviews-check')) {
        const zeroDiffNoReviewCloseout = hasZeroDiffNoReviewableScopeSuppression(preflight, requiredReviewTypes);
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'required-reviews-check',
            title: zeroDiffNoReviewCloseout
                ? 'Validate zero-diff no-review closeout.'
                : 'Run required reviews check.',
            reason: zeroDiffNoReviewCloseout
                ? 'Profile-forced reviews were suppressed because the current preflight is BASELINE_ONLY with no reviewable diff; required-reviews-check must validate audited no-op evidence before closeout.'
                : 'All required review artifacts appear present, but the review gate has not validated them.',
            commands: [
                buildCommand(
                    'Run required reviews check',
                    `${cliPrefix} gate required-reviews-check --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'doc-impact-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'doc-impact-gate',
            title: 'Record documentation impact.',
            reason: 'Completion requires an explicit docs decision.',
            commands: [
                buildCommand(
                    'Run doc impact gate',
                    buildDocImpactCommand(
                        cliPrefix,
                        taskId,
                        preflightCommandPath,
                        preflight,
                        repoRoot,
                        preflightWorkspaceReadiness.acceptedDocsOnlyDeltaFiles || []
                    )
                )
            ]
        });
    }

    if (fullSuiteConfig.enabled && !isGatePassed(summary, 'full-suite-validation')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'full-suite-validation',
            title: 'Run full-suite validation.',
            reason: `Effective workflow config enables full-suite validation at ${fullSuiteSummary.config_path}. Command: ${fullSuiteConfig.command}.`,
            commands: [
                buildCommand(
                    'Run full-suite validation',
                    `${cliPrefix} gate full-suite-validation --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    if (!isGatePassed(summary, 'completion-gate')) {
        return buildResult({
            ...resultBase,
            status: 'BLOCKED',
            nextGate: 'completion-gate',
            title: 'Run completion gate.',
            reason: 'All upstream gates appear ready; completion has not finalized the task.',
            commands: [
                buildCommand(
                    'Run completion gate',
                    `${cliPrefix} gate completion-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
                )
            ]
        });
    }

    return buildResult({
        ...resultBase,
        status: 'BLOCKED',
        nextGate: 'completion-gate',
        title: 'Rerun completion gate for the current task cycle.',
        reason: 'A previous completion gate pass exists, but it is older than the latest task-mode entry. Continue the restarted task cycle before treating the task as DONE.',
        commands: [
            buildCommand(
                'Run completion gate',
                `${cliPrefix} gate completion-gate --task-id "${taskId}" --preflight-path "${preflightCommandPath}" --repo-root "."`
            )
        ]
    });
}

export function formatNextStepText(result: NextStepResult): string {
    const lines = [
        'GARDA_NEXT_STEP',
        `Task: ${result.task_id}`,
        `Navigator: ${result.navigator_command}`,
        'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.',
        `Status: ${result.status}`,
        `NextGate: ${result.next_gate || 'none'}`,
        `Title: ${result.title}`,
        `Reason: ${result.reason}`
    ];
    if (result.warnings.length > 0) {
        lines.push('Warnings:');
        for (const warning of result.warnings) {
            lines.push(`  - ${warning}`);
        }
    }
    if (result.review_cycle_block) {
        const block = result.review_cycle_block;
        lines.push(`OperatorDecisionRequired: ${block.operator_decision_required}`);
        lines.push(`ReviewCycleBlock: reason=${formatNextStepInlineValue(block.reason)}; auto_split_enabled=${block.auto_split_enabled}; wait_for_operator=${block.wait_for_operator}`);
        lines.push(
            `ReviewCycleCounts: total_non_test_reviews=${block.total_non_test_review_count}; ` +
            `failed_non_test_reviews=${block.failed_non_test_review_count}; ` +
            `excluded_review_types=${formatNextStepInlineList(block.excluded_review_types)}`
        );
        const countEntries = Object.entries(block.counts_by_review_type);
        lines.push('ReviewCycleCountsByType:');
        if (countEntries.length === 0) {
            lines.push('  none');
        } else {
            for (const [reviewType, counts] of countEntries) {
                lines.push(`  ${formatNextStepInlineValue(reviewType)}: total=${counts.total}; passed=${counts.passed}; failed=${counts.failed}; pending=${counts.pending}`);
            }
        }
        if (block.latest_failed_review) {
            const latest = block.latest_failed_review;
            const summary = latest.summary ? `; summary=${formatNextStepInlineValue(latest.summary)}` : '';
            const artifactPath = latest.review_artifact_path ? `; artifact=${formatNextStepInlineValue(latest.review_artifact_path)}` : '';
            lines.push(
                `LatestFailedReview: review_type=${formatNextStepInlineValue(latest.review_type)}; event=${formatNextStepInlineValue(latest.event_type)}; ` +
                `outcome=${formatNextStepInlineValue(latest.outcome || 'unknown')}; sequence=${latest.sequence}${artifactPath}${summary}`
            );
        } else {
            lines.push('LatestFailedReview: none');
        }
        lines.push(`TestReviewExcluded: ${block.excluded_review_types.includes('test')}`);
        lines.push(`OperatorChoices: ${block.choices.join(', ')}`);
        if (block.auto_split_prompt) {
            lines.push(
                `AutoSplitPromptArtifact: path=${formatNextStepInlineValue(block.auto_split_prompt.artifact_path)}; ` +
                `sha256=${block.auto_split_prompt.artifact_sha256}; next_action=${block.auto_split_prompt.next_action}`
            );
            lines.push(`AutoSplitInstructions: ${block.auto_split_prompt.instructions.join(', ')}`);
            lines.push(`AutoSplitConstraints: ${block.auto_split_prompt.constraints.join(', ')}`);
        }
    }
    if (result.profile) {
        lines.push(`TaskProfile: ${result.profile.task_selected_profile || 'default'} (${result.profile.profile_selection_source || 'unknown'})`);
        if (result.profile.runtime_active_profile) {
            lines.push(`RuntimeActiveProfile: ${result.profile.runtime_active_profile} (${result.profile.runtime_active_profile_source || 'unknown'})`);
        }
        if (result.profile.effective_profile) {
            lines.push(`EffectiveProfile: ${result.profile.effective_profile} (${result.profile.effective_profile_source || 'unknown'})`);
        }
        if (result.profile.requested_depth != null || result.profile.effective_depth != null) {
            const depthParts = [
                `requested=${result.profile.requested_depth != null ? result.profile.requested_depth : 'unknown'}`,
                `effective=${result.profile.effective_depth != null ? result.profile.effective_depth : 'unknown'}`
            ];
            if (result.profile.depth_escalation_reason) {
                depthParts.push(`escalation=${result.profile.depth_escalation_reason}`);
            }
            lines.push(`Depth: ${depthParts.join('; ')}`);
        }
        if (result.profile.total_forecast_tokens != null) {
            const tokenParts = [`total~${result.profile.total_forecast_tokens}`];
            if (result.profile.effective_forecast_tokens != null) {
                tokenParts.push(`effective~${result.profile.effective_forecast_tokens}`);
            }
            if (result.profile.token_economy_active_for_depth != null) {
                tokenParts.push(`token_economy_active=${result.profile.token_economy_active_for_depth}`);
            }
            lines.push(`TokenBudget: ${tokenParts.join('; ')}`);
        }
    }
    lines.push(`FullSuite: enabled=${result.full_suite_validation.enabled}; command="${result.full_suite_validation.command}"; config=${result.full_suite_validation.config_path}`);
    lines.push(`ReviewPolicy: ${result.review.review_execution_policy_mode} (${result.review.review_execution_policy_source})`);
    if (result.review.required_reviews.length > 0) {
        lines.push(`RequiredReviews: ${result.review.required_reviews.join(', ')}`);
    } else {
        lines.push('RequiredReviews: none');
    }
    if (result.review.ordinary_doc_review_skips.length > 0 && result.review.required_reviews.length === 0) {
        const skipped = result.review.ordinary_doc_review_skips
            .map((entry) => `${entry.path} (matched ${entry.pattern})`)
            .join('; ');
        lines.push(`OrdinaryDocReviewSkips: ${skipped}`);
    }
    if (result.review.next_review_type) {
        lines.push(`NextReview: ${result.review.next_review_type}`);
    }
    if (result.review.blocked_review_dependencies.length > 0) {
        lines.push(`ReviewBlockedBy: ${result.review.blocked_review_dependencies.join(', ')}`);
        lines.push(`BlockedReviewerLaunches: do not prepare or launch '${result.review.next_review_type}' until current-cycle ${result.review.blocked_review_dependencies.join(', ')} review artifacts and receipts pass.`);
    }
    if (result.review.trust_note) {
        lines.push(result.review.trust_note);
    }
    if (result.missing_artifacts.length > 0) {
        lines.push(`MissingArtifacts: ${result.missing_artifacts.map((artifact) => artifact.key).join(', ')}`);
    }
    if (result.final_report) {
        lines.push(`CloseoutArtifact: ${result.final_report.closeout_json_path}`);
        lines.push(`CloseoutMarkdown: ${result.final_report.closeout_markdown_path}`);
        lines.push('FinalReportOrder:');
        for (const [index, entry] of result.final_report.required_order.entries()) {
            lines.push(`  ${index + 1}. ${entry}`);
        }
    }
    if (result.commands.length > 0 || result.final_report) {
        lines.push('');
        lines.push('Commands:');
        if (result.commands.length === 0) {
            lines.push('  none');
        } else {
            for (const command of result.commands) {
                lines.push(`  ${command.label}: ${command.command}`);
            }
        }
    }
    if (result.status !== 'DONE' && result.review_cycle_block?.auto_split_prompt) {
        lines.push('AfterCommand: follow AutoSplitPromptArtifact instructions; do not run parent compile, review, or full-suite gates before split handling.');
    } else if (result.status !== 'DONE' && result.review_cycle_block) {
        lines.push('AfterCommand: inspect diagnostics only if needed, then wait for operator choice; do not run compile, review, or full-suite gates.');
    } else if (result.status !== 'DONE') {
        lines.push(`AfterCommand: rerun ${result.navigator_command} after the command above completes.`);
    }
    return `${lines.join('\n')}\n`;
}

function formatNextStepInlineValue(value: string): string {
    return JSON.stringify(value);
}

function formatNextStepInlineList(values: string[]): string {
    return values.length > 0
        ? values.map((value) => formatNextStepInlineValue(value)).join(',')
        : 'none';
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
