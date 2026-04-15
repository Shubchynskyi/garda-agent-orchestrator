import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    auditReviewArtifactCompaction,
    buildReviewReceipt,
    normalizeReviewerExecutionMode,
    type ReviewReceipt
} from '../gate-runtime/review-context';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { getReviewArtifactFindingsEvidence, isTrivialReview } from './completion';
import { fileSha256, normalizePath, toPlainRecord } from './helpers';
import { getNoOpEvidence, type NoOpEvidenceResult } from './no-op';
import { getReviewContextContractViolations } from './review-context-contract';
import { normalizeSourceOfTruthValue, resolveReviewerRoutingPolicy } from './reviewer-routing';
import { resolveBundleName } from '../core/constants';

export const REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
];

export function resolveExpectedReviewVerdicts(
    requiredReviews: Record<string, boolean>,
    verdicts?: Record<string, string>,
    skipReviews?: string[]
): Record<string, string> {
    const providedVerdicts = verdicts || {};
    const skipSet = new Set((skipReviews || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
    const resolved: Record<string, string> = {};

    for (const [reviewKey, passToken] of REVIEW_CONTRACTS) {
        const explicitVerdict = String(providedVerdicts[reviewKey] || '').trim();
        if (explicitVerdict) {
            resolved[reviewKey] = explicitVerdict;
            continue;
        }
        resolved[reviewKey] = requiredReviews[reviewKey] && !skipSet.has(reviewKey)
            ? passToken
            : 'NOT_REQUIRED';
    }

    return resolved;
}

/**
 * Parse skip-reviews value into a sorted unique array.
 */
export function parseSkipReviews(value: unknown): string[] {
    if (!value || !String(value).trim()) return [];
    const parts = String(value).trim().toLowerCase().split(/[,; ]+/).filter(s => s.trim());
    return [...new Set(parts)].sort();
}

/**
 * Test expected verdict for a review type.
 * Matches Python test_expected_verdict.
 */
export function testExpectedVerdict(errors: string[], label: string, required: boolean, skippedByOverride: boolean, actualVerdict: string, passVerdict: string): void {
    if (required && !skippedByOverride) {
        if (actualVerdict !== passVerdict) {
            errors.push(`${label} is required. Expected '${passVerdict}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (skippedByOverride) {
        const allowed = new Set(['NOT_REQUIRED', 'SKIPPED_BY_OVERRIDE', passVerdict]);
        if (!allowed.has(actualVerdict)) {
            const allowedText = [...allowed].sort().join("', '");
            errors.push(`${label} override is active. Expected one of '${allowedText}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (actualVerdict === 'NOT_REQUIRED' || actualVerdict === passVerdict) return;
    errors.push(`${label} is not required. Expected 'NOT_REQUIRED' or '${passVerdict}', got '${actualVerdict}'.`);
}

/**
 * Validate preflight for required-reviews-check.
 * Validates preflight payload shape for the Node review gate.
 */
export function validatePreflightForReview(preflightPath: string, explicitTaskId: string) {
    let preflight;
    try {
        preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const errors: string[] = [];
    let resolvedTaskId: string | null = null;
    if (explicitTaskId && explicitTaskId.trim()) {
        try {
            resolvedTaskId = assertValidTaskId(explicitTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(String(message));
        }
    }

    let preflightTaskId: string | null = preflight.task_id != null ? String(preflight.task_id).trim() : '';
    if (preflightTaskId) {
        try {
            preflightTaskId = assertValidTaskId(preflightTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(`preflight.task_id: ${message}`);
            preflightTaskId = null;
        }
    } else {
        preflightTaskId = null;
    }

    if (resolvedTaskId && preflightTaskId && resolvedTaskId !== preflightTaskId) {
        errors.push(`TaskId '${resolvedTaskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!resolvedTaskId && preflightTaskId) resolvedTaskId = preflightTaskId;
    if (!resolvedTaskId) {
        errors.push('TaskId is required and must be provided either via --task-id or preflight.task_id.');
    }

    const requiredReviews = preflight.required_reviews;
    const requiredFlags: Record<string, boolean> = {};
    const requiredKeys = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];
    if (!requiredReviews || typeof requiredReviews !== 'object') {
        errors.push('Preflight field `required_reviews` is required and must be an object.');
    }
    for (const key of requiredKeys) {
        const value = requiredReviews ? requiredReviews[key] : undefined;
        if (typeof value !== 'boolean') {
            errors.push(`Preflight field \`required_reviews.${key}\` is required and must be boolean.`);
            requiredFlags[key] = false;
        } else {
            requiredFlags[key] = value;
        }
    }

    return {
        preflight,
        resolved_task_id: resolvedTaskId,
        required_reviews: requiredFlags,
        preflight_path: path.resolve(preflightPath),
        preflight_hash: fileSha256(path.resolve(preflightPath)),
        errors
    };
}

interface ReviewArtifactEntry {
    path: string;
    content: string;
    reviewContext?: Record<string, unknown>;
    reviewContextPath?: string | null;
    reviewContextSha256?: string | null;
    artifactSha256?: string | null;
    receipt?: ReviewReceipt | null;
}

export interface ReviewArtifactGateEligibilityResult {
    compactionAudit: ReturnType<typeof auditReviewArtifactCompaction> | null;
    receiptValid: boolean;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reviewerFallbackReason: string | null;
    trustLevel: string | null;
    reviewerRoutingPolicy: Record<string, unknown> | null;
    trivialReview: boolean;
    findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence> | null;
    violations: string[];
}

export function validateReviewArtifactGateEligibility(options: {
    resolvedTaskId: string | null;
    reviewKey: string;
    required: boolean;
    skippedByOverride: boolean;
    reviewArtifact: ReviewArtifactEntry;
    preflightPath?: string | null;
    preflightSha256?: string | null;
    sourceOfTruth?: string | null;
}): ReviewArtifactGateEligibilityResult {
    const { resolvedTaskId, reviewKey, required, skippedByOverride, reviewArtifact } = options;
    const errors: string[] = [];
    const artifactPath = reviewArtifact.path;
    const artifactContent = reviewArtifact.content;
    const reviewContext = reviewArtifact.reviewContext;
    const routingMetadata = toPlainRecord(reviewContext?.reviewer_routing);
    const contextExecutionMode = normalizeReviewerExecutionMode(routingMetadata?.actual_execution_mode);
    const contextReviewerSessionId = typeof routingMetadata?.reviewer_session_id === 'string'
        ? String(routingMetadata.reviewer_session_id).trim()
        : '';
    const contextFallbackReason = typeof routingMetadata?.fallback_reason === 'string'
        ? String(routingMetadata.fallback_reason).trim()
        : '';
    const canonicalSourceOfTruth = normalizeSourceOfTruthValue(options.sourceOfTruth);
    const routingSourceOfTruth = canonicalSourceOfTruth ?? normalizeSourceOfTruthValue(routingMetadata?.source_of_truth);
    const routingPolicy = resolveReviewerRoutingPolicy(routingSourceOfTruth);
    const routingPolicySummary = {
        source_of_truth: routingPolicy.source_of_truth,
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required
    };
    let compactionAudit: ReturnType<typeof auditReviewArtifactCompaction> | null = null;
    let receiptValid = false;
    let reviewerExecutionMode: string | null = null;
    let reviewerIdentity: string | null = null;
    let reviewerFallbackReason: string | null = null;
    let trustLevel: string | null = null;
    let trivialReview = false;
    let findingsEvidence: ReturnType<typeof getReviewArtifactFindingsEvidence> | null = null;

    if (artifactPath && artifactContent) {
        const canonicalPreferredContextPath = artifactPath.replace(/\.md$/, '-review-context.json');
        const normalizedReviewContextPath = reviewArtifact.reviewContextPath
            ? normalizePath(reviewArtifact.reviewContextPath)
            : null;
        const requireStrictBindingMetadata = normalizedReviewContextPath != null
            && normalizedReviewContextPath !== normalizePath(canonicalPreferredContextPath);
        compactionAudit = auditReviewArtifactCompaction({
            artifactPath,
            content: artifactContent,
            reviewContext
        });
        if (required && !skippedByOverride) {
            trivialReview = isTrivialReview(artifactContent);
            if (trivialReview) {
                errors.push(
                    `Review artifact '${normalizePath(artifactPath)}' is trivial or obviously synthetic. ` +
                    'Meaningful review artifacts must include implementation details and carry at least 100 characters of content.'
                );
            }
            findingsEvidence = getReviewArtifactFindingsEvidence(artifactPath, artifactContent);
            errors.push(...findingsEvidence.violations);
        }
        if (required && !skippedByOverride) {
            if (!reviewContext) {
                errors.push(`Required review '${reviewKey}' is missing a valid review-context artifact.`);
            }
            errors.push(...getReviewContextContractViolations({
                contextPath: reviewArtifact.reviewContextPath || artifactPath.replace(/\.md$/, '-review-context.json'),
                reviewContext: reviewContext || null,
                expectedTaskId: resolvedTaskId,
                expectedReviewType: reviewKey,
                expectedPreflightPath: options.preflightPath,
                expectedPreflightSha256: options.preflightSha256,
                requireReviewType: true,
                requireTaskId: requireStrictBindingMetadata,
                requirePreflightPath: requireStrictBindingMetadata,
                requirePreflightSha256: requireStrictBindingMetadata
            }));
            if (routingMetadata?.actual_execution_mode && !contextExecutionMode) {
                errors.push(
                    `Review '${reviewKey}' review-context has invalid reviewer_routing.actual_execution_mode ` +
                    `('${String(routingMetadata.actual_execution_mode)}').`
                );
            }
            if (canonicalSourceOfTruth && routingMetadata?.source_of_truth) {
                const artifactSourceOfTruth = normalizeSourceOfTruthValue(routingMetadata.source_of_truth);
                if (artifactSourceOfTruth && artifactSourceOfTruth !== canonicalSourceOfTruth) {
                    errors.push(
                        `Review '${reviewKey}' review-context source_of_truth (${artifactSourceOfTruth}) does not match canonical provider (${canonicalSourceOfTruth}).`
                    );
                }
            }
        }

        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        if (reviewArtifact.receipt || fs.existsSync(receiptPath)) {
            try {
                const receipt = reviewArtifact.receipt ?? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
                const currentArtifactHash = reviewArtifact.artifactSha256 ?? fileSha256(artifactPath);
                if (receipt.task_id !== resolvedTaskId) {
                    errors.push(`Review receipt for '${reviewKey}' belongs to a different task: ${receipt.task_id}.`);
                } else if (receipt.review_type !== reviewKey) {
                    errors.push(`Review receipt for '${reviewKey}' has mismatched review type: ${receipt.review_type}.`);
                } else if (receipt.review_artifact_sha256 !== currentArtifactHash) {
                    errors.push(`Review artifact hash mismatch for '${reviewKey}'. Artifact was modified after receipt was issued.`);
                } else if (required && !skippedByOverride && !reviewArtifact.reviewContextSha256) {
                    errors.push(`Required review '${reviewKey}' is missing a verifiable review-context hash.`);
                } else if (required && !skippedByOverride && !receipt.review_context_sha256) {
                    errors.push(`Review receipt for '${reviewKey}' is missing review_context_sha256.`);
                } else if (reviewArtifact.reviewContextSha256 && receipt.review_context_sha256 !== reviewArtifact.reviewContextSha256) {
                    errors.push(`Review context hash mismatch for '${reviewKey}'. Review-context artifact was modified after receipt was issued.`);
                } else {
                    receiptValid = true;
                }
                if (receipt.reviewer_execution_mode) {
                    reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
                    if (!reviewerExecutionMode) {
                        errors.push(
                            `Review receipt for '${reviewKey}' has invalid reviewer_execution_mode ` +
                            `('${String(receipt.reviewer_execution_mode)}').`
                        );
                    }
                }
                if (receipt.reviewer_identity) {
                    reviewerIdentity = String(receipt.reviewer_identity);
                }
                if (receipt.reviewer_fallback_reason) {
                    reviewerFallbackReason = String(receipt.reviewer_fallback_reason);
                }
                if (receipt.trust_level) {
                    trustLevel = String(receipt.trust_level);
                }
            } catch {
                errors.push(`Review receipt for '${reviewKey}' is invalid JSON: ${normalizePath(receiptPath)}.`);
            }
        } else if (required && !skippedByOverride) {
            errors.push(`Verifiable review receipt missing for '${reviewKey}': ${normalizePath(receiptPath)}. Run 'gate record-review-receipt' to fix.`);
        }

        if (required && !skippedByOverride && receiptValid) {
            if (!reviewerExecutionMode) {
                errors.push(`Review receipt for '${reviewKey}' is missing reviewer_execution_mode.`);
            }
            if (!reviewerIdentity) {
                errors.push(`Review receipt for '${reviewKey}' is missing reviewer_identity.`);
            }
            if (!contextExecutionMode) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.actual_execution_mode in review-context.`);
            }
            if (!contextReviewerSessionId) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.reviewer_session_id in review-context.`);
            }
            if (reviewerExecutionMode && contextExecutionMode && reviewerExecutionMode !== contextExecutionMode) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent execution mode between receipt (${reviewerExecutionMode}) ` +
                    `and review-context (${contextExecutionMode}).`
                );
            }
            if (reviewerIdentity && contextReviewerSessionId && reviewerIdentity !== contextReviewerSessionId) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent reviewer identity between receipt (${reviewerIdentity}) ` +
                    `and review-context (${contextReviewerSessionId}).`
                );
            }
            if (reviewerFallbackReason && contextFallbackReason && reviewerFallbackReason !== contextFallbackReason) {
                errors.push(`Review '${reviewKey}' has inconsistent fallback reason between receipt and review-context.`);
            }
            if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && reviewerIdentity.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity is self-scoped (${reviewerIdentity}).`);
            } else if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && !reviewerIdentity.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity must be agent-scoped (expected prefix 'agent:').`);
            }
            if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && contextReviewerSessionId.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id is self-scoped (${contextReviewerSessionId}).`);
            } else if (contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id must be agent-scoped (expected prefix 'agent:').`);
            }
            if (contextExecutionMode === 'same_agent_fallback' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' review-context claims same_agent_fallback but reviewer_session_id must be self-scoped (expected prefix 'self:').`);
            }
            if (routingPolicy.delegation_required && reviewerExecutionMode !== 'delegated_subagent') {
                errors.push(
                    `Review '${reviewKey}' must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Same-agent self-review is invalid on delegation-capable providers.'
                );
            }
            if (routingPolicy.capability_level === 'single_agent_only' && reviewerExecutionMode === 'delegated_subagent') {
                errors.push(
                    `Review '${reviewKey}' cannot use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Explicit same_agent_fallback evidence is required on single-agent providers.'
                );
            }
            if (reviewerExecutionMode === 'same_agent_fallback') {
                if (!routingPolicy.fallback_allowed) {
                    errors.push(`Review '${reviewKey}' used same_agent_fallback on provider '${routingPolicy.source_of_truth || 'unknown'}', but fallback is not allowed.`);
                }
                if (routingPolicy.fallback_reason_required && !String(reviewerFallbackReason || '').trim()) {
                    errors.push(`Review '${reviewKey}' used same_agent_fallback without reviewer_fallback_reason.`);
                }
            }
        }
    } else if (required && !skippedByOverride) {
        errors.push(`Review artifact missing for '${reviewKey}'.`);
    }

    return {
        compactionAudit,
        receiptValid,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        trustLevel,
        reviewerRoutingPolicy: routingPolicySummary,
        trivialReview,
        findingsEvidence,
        violations: errors
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
    sourceOfTruth?: string | null;
}

/**
 * Check required reviews validation.
 * Pure-logic core for the required reviews gate.
 */
export function checkRequiredReviews(options: CheckRequiredReviewsOptions) {
    const validatedPreflight = options.validatedPreflight;
    const skipReviews = options.skipReviews || [];
    const compileGateEvidence = options.compileGateEvidence || null;
    const reviewArtifacts = options.reviewArtifacts || {};

    const errors = [...validatedPreflight.errors];
    const resolvedTaskId = validatedPreflight.resolved_task_id;
    const requiredReviews = validatedPreflight.required_reviews;
    const verdicts = resolveExpectedReviewVerdicts(requiredReviews, options.verdicts, skipReviews);

    // Validate compile gate
    if (compileGateEvidence) {
        if (compileGateEvidence.status !== 'PASSED') {
            errors.push(`Compile gate did not pass. Status: '${compileGateEvidence.status || 'UNKNOWN'}'.`);
        }
    }

    // Validate each review type
    const reviewChecks: Record<string, unknown> = {};
    for (const [reviewKey, passToken] of REVIEW_CONTRACTS) {
        const required = !!requiredReviews[reviewKey];
        const skippedByOverride = skipReviews.includes(reviewKey);
        const actualVerdict = verdicts[reviewKey] || 'NOT_REQUIRED';
        testExpectedVerdict(errors, `Review '${reviewKey}'`, required, skippedByOverride, actualVerdict, passToken);

        let compactionAudit = null;
        let receiptValid = false;
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
                sourceOfTruth: options.sourceOfTruth
            });
            compactionAudit = validation.compactionAudit;
            receiptValid = validation.receiptValid;
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

// --- Zero-diff no-op guard for review gate ---

export interface ZeroDiffReviewGuardResult {
    zero_diff_detected: boolean;
    status: 'NOT_APPLICABLE' | 'REQUIRES_DIFF_OR_NO_OP' | 'SATISFIED_BY_AUDITED_NO_OP';
    no_op_evidence_status: string | null;
    violations: string[];
}

/**
 * Detect whether a preflight artifact represents a zero-diff (clean tree) classification.
 * Reads the preflight's zero_diff_guard block or falls back to metrics/changed_files.
 */
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
    noOpArtifactPath?: string
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

    const noOpEvidence = getNoOpEvidence(repoRoot, taskId, noOpArtifactPath || '');

    if (noOpEvidence.evidence_status === 'PASS') {
        return {
            zero_diff_detected: true,
            status: 'SATISFIED_BY_AUDITED_NO_OP',
            no_op_evidence_status: noOpEvidence.evidence_status,
            violations: []
        };
    }

    return {
        zero_diff_detected: true,
        status: 'REQUIRES_DIFF_OR_NO_OP',
        no_op_evidence_status: noOpEvidence.evidence_status,
        violations: [
            `Task '${taskId}' has zero-diff preflight (clean tree). ` +
            'Review gate cannot pass without produced changes. ' +
            'Either implement changes and re-run preflight, record an audited no-op artifact ' +
            `('node ${resolveBundleName()}/bin/garda.js gate record-no-op --task-id "${taskId}" --reason "..."'), ` +
            'or set the task to BLOCKED.'
        ]
    };
}
