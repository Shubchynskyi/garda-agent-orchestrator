import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatReviewVerdictTokenList,
    normalizeReviewReceiptReviewerProvenance
} from '../../gate-runtime/review-context';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    buildReviewContextPreflightDiffExpectations,
    getReviewContextContractViolations
} from '../review-context/review-context-contract';
import {
    reviewContextLaneScopeMatchesCurrentPreflight
} from '../scope/domain-scope-fingerprints';
import {
    buildReviewTrustSummary,
    type ReviewTrustSummary
} from '../review/review-trust-summary';

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(
    Object.fromEntries(Object.entries(REVIEW_VERDICT_PASS_TOKENS).map(([reviewType, passToken]) => {
        if (reviewType === 'code') {
            return [reviewType, 'CODE REVIEW FAILED'];
        }
        return [reviewType, passToken.replace(/\bPASSED\b/u, 'FAILED')];
    }))
);

export interface ReviewArtifactState {
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
    failureKind: 'launch-package' | null;
    failureReason: string | null;
    domainScopeCurrent: boolean;
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
        launch_prepared_at_utc?: string | null;
        launched_at_utc?: string | null;
        launch_completed_at_utc?: string | null;
        invocation_attested_at_utc?: string | null;
    } | null;
    reviewResultRecordedAtUtc: string | null;
    recordedAtUtc: string | null;
    reviewOutputSourceMtimeUtc: string | null;
}

const REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
    { pattern: /\breviewer_prompt_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breviewer_prompt_sha256\b/i, reason: 'reviewer_prompt_sha256 mismatch' },
    { pattern: /\breview_context_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_context_sha256\b/i, reason: 'review_context_sha256 mismatch' },
    { pattern: /\breview_tree_state_sha256\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\breview_tree_state_sha256\b/i, reason: 'review_tree_state_sha256 mismatch' },
    { pattern: /\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b[\s\S]{0,160}\b(?:launch_binding_sha256|prepared_launch_event_sha256|reviewer_launch_artifact_sha256)\b/i, reason: 'reviewer launch binding mismatch' },
    { pattern: /\b(?:launch package|launch artifact|prepared launch|reviewer launch|invocation attestation|launch binding)\b[\s\S]{0,160}\b(?:must match|does not match|did not match|mismatch|wrong|stale|invalid|not eligible)\b/i, reason: 'reviewer launch package mismatch' },
    { pattern: /\b(?:wrong|stale|invalid)\s+(?:prompt|context|tree-state|tree state)\s+hash\b/i, reason: 'reviewer launch hash mismatch' }
];
const REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN =
    /\b(?:reviewer\s+failed\s+before\s+\w+\s+review|reviewer\s+launch\s+artifact\s+is\s+not\s+eligible\s+for\s+invocation\s+attestation|reviewer\s+launch\s+package\s+failure|launch\s+package\s+failure|launch\s+metadata\s+failure|invocation\s+attestation\s+failed)\b/i;

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function detectReviewLaunchPackageFailureReason(content: string): string | null {
    if (!REVIEW_LAUNCH_PACKAGE_FAILURE_MARKER_PATTERN.test(content)) {
        return null;
    }
    const match = REVIEW_LAUNCH_PACKAGE_FAILURE_PATTERNS.find(({ pattern }) => pattern.test(content));
    return match?.reason || null;
}

export function readReviewArtifactState(
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
    let contextPreflightBindingViolationIndex: number | null = null;
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
    let failureKind: ReviewArtifactState['failureKind'] = null;
    let failureReason: string | null = null;
    let domainScopeCurrent = false;
    let reviewResultRecordedAtUtc: string | null = null;
    let recordedAtUtc: string | null = null;
    let reviewOutputSourceMtimeUtc: string | null = null;

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
                contextPreflightBindingViolationIndex = violations.length;
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
            failureReason = detectReviewLaunchPackageFailureReason(content);
            if (failureReason) {
                failureKind = 'launch-package';
                violations.push(
                    `review artifact contains fail token '${failToken}' for reviewer launch package failure (${failureReason}); preserve the failed artifact and restart the review cycle without implementation changes`
                );
            } else {
                violations.push(
                    `review artifact contains fail token '${failToken}'; fix implementation and rerun compile plus '${reviewType}' review before launching dependent reviews`
                );
            }
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
        domainScopeCurrent = reviewReceiptDomainScopeMatchesCurrentPreflight(receipt, context, preflightPayload);
        reviewResultRecordedAtUtc = typeof receipt.review_result_recorded_at_utc === 'string'
            ? receipt.review_result_recorded_at_utc.trim() || null
            : null;
        recordedAtUtc = typeof receipt.recorded_at_utc === 'string'
            ? receipt.recorded_at_utc.trim() || null
            : null;
        reviewOutputSourceMtimeUtc = typeof receipt.review_output_source_mtime_utc === 'string'
            ? receipt.review_output_source_mtime_utc.trim() || null
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
                routing_event_sha256: 'routing_event_sha256' in normalizedProvenance ? normalizedProvenance.routing_event_sha256 : undefined,
                launch_prepared_at_utc: 'launch_prepared_at_utc' in normalizedProvenance ? normalizedProvenance.launch_prepared_at_utc : undefined,
                launched_at_utc: 'launched_at_utc' in normalizedProvenance ? normalizedProvenance.launched_at_utc : undefined,
                launch_completed_at_utc: 'launch_completed_at_utc' in normalizedProvenance ? normalizedProvenance.launch_completed_at_utc : undefined,
                invocation_attested_at_utc: 'invocation_attested_at_utc' in normalizedProvenance ? normalizedProvenance.invocation_attested_at_utc : undefined
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

    const effectiveViolations = domainScopeCurrent
        ? violations.filter((_, index) => index !== contextPreflightBindingViolationIndex)
        : violations;

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
        failureKind,
        failureReason,
        domainScopeCurrent,
        ready: effectiveViolations.length === 0,
        violations: effectiveViolations,
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
        reviewerProvenance,
        reviewResultRecordedAtUtc,
        recordedAtUtc,
        reviewOutputSourceMtimeUtc
    };
}

export function reviewReceiptDomainScopeMatchesCurrentPreflight(
    receipt: Record<string, unknown>,
    reviewContext: Record<string, unknown> | null,
    currentPreflight: Record<string, unknown> | null
): boolean {
    if (!reviewContext || !currentPreflight) {
        return false;
    }
    const reviewType = String(receipt.review_type || '').trim().toLowerCase();
    if (reviewType !== String(reviewContext.review_type || '').trim().toLowerCase()) {
        return false;
    }
    return reviewContextLaneScopeMatchesCurrentPreflight(reviewType, reviewContext, currentPreflight);
}

export function scopedDiffExpectedForReview(options: {
    preflight: Record<string, unknown> | null;
    reviewType: string;
}): boolean {
    return buildReviewContextPreflightDiffExpectations(options.preflight, options.reviewType).expectedScopedDiff;
}

export function getScopedDiffMetadataReadiness(options: {
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

export function readReviewTrust(
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
            reviewer_provenance: receipt.reviewer_provenance ?? null,
            reused_existing_review: receipt.reused_existing_review === true
        }];
    });
    return buildReviewTrustSummary(entries, scopeCategory, requiredReviewTypes.length);
}
