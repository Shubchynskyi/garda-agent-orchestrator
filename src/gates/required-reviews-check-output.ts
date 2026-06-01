// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import * as path from 'node:path';
import { getReviewArtifactFindingsEvidence } from './completion';
import { normalizePath } from './helpers';
import { getNoOpEvidence } from './no-op';
import { createReviewTreeStateFreshnessCache } from './review-tree-state';
import { normalizeSourceOfTruthValue } from './reviewer-routing';
import { resolveBundleName } from '../core/constants';
import { REVIEW_CONTRACTS, resolveExpectedReviewVerdicts, testExpectedVerdict } from './required-reviews-check-contracts';
import { readReviewDependencyTimelineEvents } from './required-reviews-check-dependencies';
import {
    resolvePreflightPayloadForReviewValidation,
    type ReviewArtifactEntry
} from './required-reviews-check-evidence';
import { validateReviewArtifactGateEligibility } from './required-reviews-check-trust';

export interface CheckRequiredReviewsOptions {
    validatedPreflight: {
        errors: string[];
        resolved_task_id: string | null;
        required_reviews: Record<string, boolean>;
        preflight_path: string;
        preflight_hash: string | null;
    };
    verdicts?: Record<string, string>;
    skipReviews?: string[];
    compileGateEvidence?: Record<string, unknown> | null;
    reviewArtifacts?: Record<string, ReviewArtifactEntry>;
    preflightPayload?: Record<string, unknown> | null;
    sourceOfTruth?: string | null;
    canonicalSourceOfTruth?: string | null;
    executionProvider?: string | null;
    executionProviderSource?: string | null;
    allowLegacyReviewContextIdentityFallback?: boolean;
    repoRoot?: string | null;
}

export function checkRequiredReviews(options: CheckRequiredReviewsOptions) {
    const validatedPreflight = options.validatedPreflight;
    const skipReviews = options.skipReviews || [];
    const compileGateEvidence = options.compileGateEvidence || null;
    const reviewArtifacts = options.reviewArtifacts || {};
    const legacySourceOfTruth = normalizeSourceOfTruthValue(options.sourceOfTruth);
    const canonicalSourceOfTruth = options.canonicalSourceOfTruth ?? legacySourceOfTruth;
    const executionProvider = options.executionProvider ?? legacySourceOfTruth;
    const allowLegacyReviewContextIdentityFallback = options.allowLegacyReviewContextIdentityFallback ?? (
        !!legacySourceOfTruth
        && !options.canonicalSourceOfTruth
        && !options.executionProvider
    );

    const errors = [...validatedPreflight.errors];
    const resolvedTaskId = validatedPreflight.resolved_task_id;
    const requiredReviews = validatedPreflight.required_reviews;
    const verdicts = resolveExpectedReviewVerdicts(requiredReviews, options.verdicts, skipReviews);
    const preflightPayload = resolvePreflightPayloadForReviewValidation({
        preflightPayload: options.preflightPayload,
        preflightPath: validatedPreflight.preflight_path
    });
    const timelinePath = resolvedTaskId
        ? path.join(
            path.dirname(path.dirname(validatedPreflight.preflight_path)),
            'task-events',
            `${resolvedTaskId}.jsonl`
        )
        : null;
    const timelineEvents = resolvedTaskId
        ? readReviewDependencyTimelineEvents(String(timelinePath || ''))
        : [];
    if (resolvedTaskId && timelineEvents.length === 0) {
        errors.push(
            `Task timeline missing or unreadable for '${resolvedTaskId}': ${normalizePath(String(timelinePath || ''))}.`
        );
    }

    if (compileGateEvidence) {
        if (compileGateEvidence.status !== 'PASSED') {
            errors.push(`Compile gate did not pass. Status: '${compileGateEvidence.status || 'UNKNOWN'}'.`);
        }
    }

    const reviewChecks: Record<string, unknown> = {};
    const treeStateFreshnessCache = options.repoRoot
        ? createReviewTreeStateFreshnessCache()
        : null;
    for (const [reviewKey, passToken] of REVIEW_CONTRACTS) {
        const required = !!requiredReviews[reviewKey];
        const skippedByOverride = skipReviews.includes(reviewKey);
        const actualVerdict = verdicts[reviewKey] || 'NOT_REQUIRED';
        testExpectedVerdict(errors, `Review '${reviewKey}'`, required, skippedByOverride, actualVerdict, passToken);

        let compactionAudit = null;
        let receiptValid = false;
        let reusedExistingReview = false;
        let reviewerExecutionMode: string | null = null;
        let reviewerIdentity: string | null = null;
        let reviewerFallbackReason: string | null = null;
        let trustLevel: string | null = null;
        let routingPolicySummary: Record<string, unknown> | null = null;
        let trivialReview = false;
        let findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence> | null = null;
        if (reviewArtifacts[reviewKey]) {
            const validation = validateReviewArtifactGateEligibility({
                resolvedTaskId,
                reviewKey,
                required,
                skippedByOverride,
                reviewArtifact: reviewArtifacts[reviewKey],
                preflightPath: validatedPreflight.preflight_path,
                preflightSha256: validatedPreflight.preflight_hash,
                preflightPayload,
                sourceOfTruth: options.sourceOfTruth,
                canonicalSourceOfTruth,
                executionProvider,
                executionProviderSource: options.executionProviderSource,
                allowLegacyReviewContextIdentityFallback,
                timelineEvents,
                repoRoot: options.repoRoot || null,
                treeStateFreshnessCache
            });
            compactionAudit = validation.compactionAudit;
            receiptValid = validation.receiptValid;
            reusedExistingReview = validation.reusedExistingReview;
            reviewerExecutionMode = validation.reviewerExecutionMode;
            reviewerIdentity = validation.reviewerIdentity;
            reviewerFallbackReason = validation.reviewerFallbackReason;
            trustLevel = validation.trustLevel;
            routingPolicySummary = validation.reviewerRoutingPolicy;
            trivialReview = validation.trivialReview;
            findingsEvidence = validation.findingsEvidence;
            errors.push(...validation.violations);
        }

        reviewChecks[reviewKey] = {
            required,
            skipped_by_override: skippedByOverride,
            verdict: actualVerdict,
            pass_token: passToken,
            compaction_audit: compactionAudit,
            receipt_valid: receiptValid,
            reused_existing_review: reusedExistingReview,
            reviewer_execution_mode: reviewerExecutionMode,
            reviewer_identity: reviewerIdentity,
            reviewer_fallback_reason: reviewerFallbackReason,
            trust_level: trustLevel,
            reviewer_routing_policy: routingPolicySummary,
            trivial_review: trivialReview,
            findings_evidence: findingsEvidence
        };
    }

    const status = errors.length > 0 ? 'FAILED' : 'PASSED';
    const outcome = errors.length > 0 ? 'FAIL' : 'PASS';

    return {
        status,
        outcome,
        task_id: resolvedTaskId,
        preflight_path: normalizePath(validatedPreflight.preflight_path),
        preflight_hash_sha256: validatedPreflight.preflight_hash,
        required_reviews: requiredReviews,
        skip_reviews: skipReviews,
        verdicts,
        review_checks: reviewChecks,
        violations: errors
    };
}

export interface ZeroDiffReviewGuardResult {
    zero_diff_detected: boolean;
    status: 'NOT_APPLICABLE' | 'REQUIRES_DIFF_OR_NO_OP' | 'SATISFIED_BY_AUDITED_NO_OP';
    no_op_evidence_status: string | null;
    violations: string[];
}

export function detectZeroDiffFromPreflight(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) return false;

    const guard = preflight.zero_diff_guard;
    if (guard && typeof guard === 'object' && !Array.isArray(guard)) {
        const guardObj = guard as Record<string, unknown>;
        if (guardObj.zero_diff_detected === true) return true;
        if (guardObj.zero_diff_detected === false) return false;
    }

    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    const changedLinesTotal = metrics && typeof metrics.changed_lines_total === 'number'
        ? metrics.changed_lines_total
        : 0;
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    return changedLinesTotal === 0 && changedFilesCount === 0;
}

/**
 * Validate zero-diff guard for the review gate.
 * When the preflight shows zero-diff, the review gate blocks unless an audited no-op
 * artifact exists. This prevents clean-tree preflights from drifting toward task
 * completion without any produced diff.
 */
export function validateZeroDiffForReviewGate(
    preflight: Record<string, unknown> | null,
    taskId: string,
    repoRoot: string,
    noOpArtifactPath?: string,
    preflightPath?: string
): ZeroDiffReviewGuardResult {
    const zeroDiffDetected = detectZeroDiffFromPreflight(preflight);

    if (!zeroDiffDetected) {
        return {
            zero_diff_detected: false,
            status: 'NOT_APPLICABLE',
            no_op_evidence_status: null,
            violations: []
        };
    }

    const noOpEvidence = getNoOpEvidence(repoRoot, taskId, noOpArtifactPath || '', preflightPath || '');

    if (noOpEvidence.evidence_status === 'PASS') {
        return {
            zero_diff_detected: true,
            status: 'SATISFIED_BY_AUDITED_NO_OP',
            no_op_evidence_status: noOpEvidence.evidence_status,
            violations: []
        };
    }

    const noOpPreflightArg = preflightPath
        ? ` --preflight-path "${normalizePath(preflightPath)}"`
        : '';

    return {
        zero_diff_detected: true,
        status: 'REQUIRES_DIFF_OR_NO_OP',
        no_op_evidence_status: noOpEvidence.evidence_status,
        violations: [
            `Task '${taskId}' has zero-diff preflight (clean tree). ` +
            'Review gate cannot pass without produced changes. ' +
            'Either implement changes and re-run preflight, record an audited no-op artifact ' +
            `('node ${resolveBundleName()}/bin/garda.js gate record-no-op --task-id "${taskId}"` +
            `${noOpPreflightArg} --reason "..."'), ` +
            `or set the task to BLOCKED. No-op evidence status: ${noOpEvidence.evidence_status}.`
        ]
    };
}
