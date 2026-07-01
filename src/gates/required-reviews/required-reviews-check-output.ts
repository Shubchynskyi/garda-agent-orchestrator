// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import * as path from 'node:path';
import { getReviewArtifactFindingsEvidence } from '../completion';
import { normalizePath } from '../shared/helpers';
import { getNoOpEvidence } from '../task-mode/no-op';
import { createReviewTreeStateFreshnessCache } from '../review/review-tree-state';
import { normalizeSourceOfTruthValue } from '../review/reviewer-routing';
import { reviewContextLaneScopeMatchesCurrentPreflight } from '../scope/domain-scope-fingerprints';
import { resolveBundleName } from '../../core/constants';
import { REVIEW_CONTRACTS, resolveExpectedReviewVerdicts, testExpectedVerdict } from './required-reviews-check-contracts';
import { readReviewDependencyTimelineEvents } from './required-reviews-check-dependencies';
import {
    resolvePreflightPayloadForReviewValidation,
    type ReviewArtifactEntry
} from './required-reviews-check-evidence';
import { validateReviewArtifactGateEligibility } from './required-reviews-check-trust';

export const REVIEW_AUTHORSHIP_ATTESTATION_PROMPT = [
    'Answer true only if this review output and receipt came from a real delegated subagent.',
    'Answer false if the reviewer was not launched, the main agent authored/substituted/fabricated the review output or receipt, or authorship is uncertain.',
    'False is allowed and protects the user; true after self-authored or fabricated review evidence is a critical workflow violation.',
    'Answer only booleans keyed by required review type; do not include explanations or unknown review types.'
] as const;

export interface ReviewAuthorshipAttestation {
    schema_version: 1;
    status: 'NOT_REQUIRED' | 'MISSING' | 'PASSED' | 'FAILED';
    required_review_types: string[];
    attested_review_types: string[];
    skipped_review_types: string[];
    attestations: Record<string, boolean>;
    false_review_types: string[];
    missing_review_types: string[];
    unknown_review_types: string[];
    non_boolean_review_types: string[];
    violations: string[];
    honesty_prompt: readonly string[];
    visible_summary_line: string;
}

function getRequiredReviewTypesForAuthorshipAttestation(
    requiredReviews: Record<string, boolean>,
    skipReviews: string[]
): { requiredTypes: string[]; skippedTypes: string[] } {
    const skipSet = new Set(skipReviews.map((entry) => String(entry || '').trim().toLowerCase()).filter(Boolean));
    const requiredTypes: string[] = [];
    const skippedTypes: string[] = [];
    for (const [reviewType] of REVIEW_CONTRACTS) {
        if (requiredReviews[reviewType] !== true) {
            continue;
        }
        requiredTypes.push(reviewType);
        if (skipSet.has(reviewType)) {
            skippedTypes.push(reviewType);
        }
    }
    return { requiredTypes, skippedTypes };
}

function parseReviewAuthorshipAttestationJson(
    value: unknown,
    violations: string[]
): Record<string, unknown> | null {
    if (value == null || (typeof value === 'string' && !value.trim())) {
        return null;
    }
    let parsed = value;
    if (typeof value === 'string') {
        try {
            parsed = JSON.parse(value);
        } catch {
            violations.push('Review authorship attestation JSON is invalid; provide an object like {"code":true}.');
            return {};
        }
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        violations.push('Review authorship attestation must be a strict JSON object keyed by required review type.');
        return {};
    }
    return parsed as Record<string, unknown>;
}

export function buildReviewAuthorshipAttestation(
    requiredReviews: Record<string, boolean>,
    value: unknown,
    skipReviews: string[] = []
): ReviewAuthorshipAttestation {
    const { requiredTypes, skippedTypes } = getRequiredReviewTypesForAuthorshipAttestation(requiredReviews, skipReviews);
    const base = {
        schema_version: 1 as const,
        required_review_types: requiredTypes,
        skipped_review_types: skippedTypes,
        honesty_prompt: REVIEW_AUTHORSHIP_ATTESTATION_PROMPT
    };
    if (requiredTypes.length === 0) {
        return {
            ...base,
            status: 'NOT_REQUIRED',
            attested_review_types: [],
            attestations: {},
            false_review_types: [],
            missing_review_types: [],
            unknown_review_types: [],
            non_boolean_review_types: [],
            violations: [],
            visible_summary_line: 'Review authorship attestation: not required.'
        };
    }

    const violations: string[] = [];
    if (skippedTypes.length > 0) {
        violations.push(
            `Review authorship attestation cannot be skipped for required review types: ${skippedTypes.join(', ')}. ` +
            'Answer false when a delegated reviewer was not launched; false or missing mandatory lanes fail this gate.'
        );
    }
    const parsed = parseReviewAuthorshipAttestationJson(value, violations);
    if (parsed == null) {
        violations.push(
            `Review authorship attestation is missing for required review types: ${requiredTypes.join(', ')}.`
        );
        return {
            ...base,
            status: 'MISSING',
            attested_review_types: [],
            attestations: {},
            false_review_types: [],
            missing_review_types: requiredTypes,
            unknown_review_types: [],
            non_boolean_review_types: [],
            violations,
            visible_summary_line:
                `Review authorship attestation: missing for required review types ${requiredTypes.join(', ')}.`
        };
    }

    const requiredTypeSet = new Set(requiredTypes);
    const attestations: Record<string, boolean> = {};
    const unknownTypes: string[] = [];
    const nonBooleanTypes: string[] = [];
    for (const [rawReviewType, rawAttestation] of Object.entries(parsed)) {
        const reviewType = rawReviewType.trim().toLowerCase();
        if (!requiredTypeSet.has(reviewType)) {
            unknownTypes.push(rawReviewType);
            continue;
        }
        if (typeof rawAttestation !== 'boolean') {
            nonBooleanTypes.push(reviewType);
            continue;
        }
        attestations[reviewType] = rawAttestation;
    }

    const missingTypes = requiredTypes.filter((reviewType) => !(reviewType in attestations));
    const falseTypes = requiredTypes.filter((reviewType) => attestations[reviewType] === false);
    if (unknownTypes.length > 0) {
        violations.push(`Review authorship attestation contains unknown review types: ${unknownTypes.sort().join(', ')}.`);
    }
    if (nonBooleanTypes.length > 0) {
        violations.push(`Review authorship attestation values must be booleans for: ${nonBooleanTypes.sort().join(', ')}.`);
    }
    if (missingTypes.length > 0) {
        violations.push(`Review authorship attestation is missing required review types: ${missingTypes.join(', ')}.`);
    }
    if (falseTypes.length > 0) {
        violations.push(
            `Review authorship attestation is false for mandatory review types: ${falseTypes.join(', ')}. ` +
            'Fresh delegated reviewer output/receipt is not honestly attested for those lanes.'
        );
    }

    const status = violations.length > 0 ? 'FAILED' : 'PASSED';
    return {
        ...base,
        status,
        attested_review_types: Object.keys(attestations).sort(),
        attestations,
        false_review_types: falseTypes,
        missing_review_types: missingTypes,
        unknown_review_types: unknownTypes.sort(),
        non_boolean_review_types: nonBooleanTypes.sort(),
        violations,
        visible_summary_line: status === 'PASSED'
            ? `Review authorship attestation: passed for ${requiredTypes.join(', ')}.`
            : `Review authorship attestation: failed for ${requiredTypes.join(', ')}.`
    };
}

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
        const reviewArtifact = reviewArtifacts[reviewKey];
        if (reviewArtifact) {
            const allowLaneDomainPreflightBinding = reviewContextLaneScopeMatchesCurrentPreflight(
                reviewKey,
                reviewArtifact.reviewContext || null,
                preflightPayload
            );
            const validation = validateReviewArtifactGateEligibility({
                resolvedTaskId,
                reviewKey,
                required,
                skippedByOverride,
                reviewArtifact,
                preflightPath: validatedPreflight.preflight_path,
                preflightSha256: validatedPreflight.preflight_hash,
                preflightPayload,
                sourceOfTruth: options.sourceOfTruth,
                canonicalSourceOfTruth,
                executionProvider,
                executionProviderSource: options.executionProviderSource,
                allowLegacyReviewContextIdentityFallback,
                allowLaneDomainPreflightBinding,
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
