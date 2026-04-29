import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    auditReviewArtifactCompaction,
    buildReviewVerdictTokenSet,
    normalizeCompatibilityReviewerExecutionMode,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../gate-runtime/review-context';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { getReviewArtifactFindingsEvidence, isTrivialReview } from './completion';
import { fileSha256, normalizePath, toPlainRecord } from './helpers';
import { getNoOpEvidence } from './no-op';
import { getReviewContextContractViolations } from './review-context-contract';
import { resolveReviewContextRoutingIdentity } from './review-context-routing';
import { type ReviewDependencyTimelineEvent } from './review-dependencies';
import {
    findMatchingHistoricalReviewRecordedTelemetryEvent,
    findMatchingReviewReuseRecordedTelemetryEvent
} from './review-reuse-telemetry';
import { getMandatoryDelegatedReviewTrustViolation } from './review-trust-policy';
import { normalizeRuntimeIdentitySource, normalizeSourceOfTruthValue, resolveReviewerRoutingPolicy } from './reviewer-routing';
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
            resolved[reviewKey] = normalizeExplicitReviewVerdict(reviewKey, explicitVerdict, passToken);
            continue;
        }
        resolved[reviewKey] = requiredReviews[reviewKey] && !skipSet.has(reviewKey)
            ? passToken
            : 'NOT_REQUIRED';
    }

    return resolved;
}

function normalizeExplicitReviewVerdict(
    reviewKey: string,
    explicitVerdict: string,
    passToken: string
): string {
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const tokenSet = buildReviewVerdictTokenSet(reviewKey, passToken, failToken);
    if (tokenSet.passTokens.includes(explicitVerdict)) {
        return passToken;
    }
    if (tokenSet.failTokens.includes(explicitVerdict)) {
        return failToken;
    }
    return explicitVerdict;
}

export function parseSkipReviews(value: unknown): string[] {
    if (!value || !String(value).trim()) return [];
    const parts = String(value).trim().toLowerCase().split(/[,; ]+/).filter(s => s.trim());
    return [...new Set(parts)].sort();
}

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

function readReviewDependencyTimelineEvents(timelinePath: string): ReviewDependencyTimelineEvent[] {
    if (!timelinePath || !fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    return fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line, sequence) => {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                    ? parsed.integrity as Record<string, unknown>
                    : null;
                const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                    ? rawIntegrity.task_sequence
                    : Number(rawIntegrity?.task_sequence);
                const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
                const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
                const prevEventSha256 = prevEventSha256Raw == null
                    ? null
                    : String(prevEventSha256Raw).trim().toLowerCase() || null;
                return [{
                    event_type: String(parsed.event_type || '').trim().toUpperCase(),
                    sequence,
                    details,
                    integrity: rawIntegrity
                        && Number.isInteger(taskSequence)
                        && taskSequence > 0
                        && /^[0-9a-f]{64}$/.test(eventSha256)
                        && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                        ? {
                            schema_version: typeof rawIntegrity.schema_version === 'number'
                                ? rawIntegrity.schema_version
                                : Number(rawIntegrity.schema_version) || 1,
                            task_sequence: taskSequence,
                            prev_event_sha256: prevEventSha256,
                            event_sha256: eventSha256
                        }
                        : null
                }];
            } catch {
                return [];
            }
        });
}

function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

function findMatchingRoutingEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    reviewType: string,
    reviewerExecutionMode: string,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null,
    reviewerProvenance?: ReturnType<typeof normalizeReviewReceiptReviewerProvenance>
): ReviewDependencyTimelineEvent | null {
    const normalizedReviewType = String(reviewType || '').trim().toLowerCase();
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    const latestReviewPhaseSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => (
            entry.event_type === 'REVIEW_PHASE_STARTED'
            && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
        )
    );
    const cycleFloorSequence = latestCompilePassSequence == null
        ? latestReviewPhaseSequence
        : latestReviewPhaseSequence == null
            ? latestCompilePassSequence
            : Math.max(latestCompilePassSequence, latestReviewPhaseSequence);
    if (cycleFloorSequence == null) {
        return null;
    }
    if (reviewerProvenance?.attestation_type === 'controller_event_integrity') {
        for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
            const entry = timelineEvents[index];
            const details = entry.details;
            const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
            if (entry.sequence <= cycleFloorSequence) {
                break;
            }
            if (
                entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
                && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
                && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
                && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''))
                && entry.integrity
                && entry.integrity.task_sequence === reviewerProvenance.task_sequence
                && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === reviewerProvenance.event_sha256
                && (entry.integrity.prev_event_sha256 == null
                    ? null
                    : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === reviewerProvenance.prev_event_sha256
            ) {
                return entry;
            }
        }
    }
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        if (entry.sequence <= cycleFloorSequence) {
            break;
        }
        const details = entry.details;
        const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
        if (
            entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
            && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
            && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''))
        ) {
            return entry;
        }
    }
    return null;
}

function findMatchingInvocationAttestationEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: string;
        reviewerIdentity: string;
        reviewContextSha256: string | null;
        routingEventSha256: string | null;
        reviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    }
): ReviewDependencyTimelineEvent | null {
    if (options.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
        return null;
    }
    const normalizedReviewType = String(options.reviewType || '').trim().toLowerCase();
    const normalizedTaskId = String(options.taskId || '').trim();
    const normalizedReviewContextSha256 = String(options.reviewContextSha256 || '').trim().toLowerCase();
    const normalizedRoutingEventSha256 = String(options.routingEventSha256 || '').trim().toLowerCase();
    if (
        options.reviewerProvenance.task_id !== normalizedTaskId
        || options.reviewerProvenance.review_type !== normalizedReviewType
        || options.reviewerProvenance.reviewer_execution_mode !== options.reviewerExecutionMode
        || options.reviewerProvenance.reviewer_identity !== options.reviewerIdentity
        || options.reviewerProvenance.review_context_sha256 !== normalizedReviewContextSha256
        || options.reviewerProvenance.routing_event_sha256 !== normalizedRoutingEventSha256
    ) {
        return null;
    }

    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = timelineEvents[index];
        const details = entry.details;
        const detailsTaskId = String(details?.task_id || details?.taskId || '').trim();
        const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
            .trim()
            .toLowerCase();
        const detailsRoutingEventSha256 = String(details?.routing_event_sha256 || details?.routingEventSha256 || '')
            .trim()
            .toLowerCase();
        if (
            entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
            && (!detailsTaskId || detailsTaskId === normalizedTaskId)
            && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === normalizedReviewType
            && normalizeCompatibilityReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === options.reviewerExecutionMode
            && String((details?.reviewer_session_id ?? details?.reviewerSessionId ?? details?.reviewer_identity ?? details?.reviewerIdentity) || '').trim() === options.reviewerIdentity
            && detailsReviewContextSha256 === normalizedReviewContextSha256
            && detailsRoutingEventSha256 === normalizedRoutingEventSha256
            && entry.integrity
            && entry.integrity.task_sequence === options.reviewerProvenance.task_sequence
            && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === options.reviewerProvenance.event_sha256
            && (entry.integrity.prev_event_sha256 == null
                ? null
                : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === options.reviewerProvenance.prev_event_sha256
        ) {
            return entry;
        }
    }
    return null;
}

function findMatchingReviewReuseRecordedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        reviewType: string;
        receiptPath: string;
        reviewContextSha256: string | null;
        reviewContextReuseSha256?: string | null;
        reviewScopeSha256?: string | null;
        codeScopeSha256?: string | null;
        reviewArtifactSha256: string | null;
        reusedFromReceiptPath: string | null;
        reusedFromReviewContextSha256: string | null;
        reusedFromReviewContextReuseSha256: string | null;
        reusedFromReviewScopeSha256?: string | null;
        reusedFromCodeScopeSha256?: string | null;
    }
): ReviewDependencyTimelineEvent | null {
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return null;
    }
    return findMatchingReviewReuseRecordedTelemetryEvent(timelineEvents, {
        reviewType: options.reviewType,
        receiptPath: options.receiptPath,
        reviewContextSha256: options.reviewContextSha256,
        reviewContextReuseSha256: options.reviewContextReuseSha256,
        reviewScopeSha256: options.reviewScopeSha256,
        codeScopeSha256: options.codeScopeSha256,
        reviewArtifactSha256: options.reviewArtifactSha256,
        reusedFromReceiptPath: options.reusedFromReceiptPath,
        reusedFromReviewContextSha256: options.reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256: options.reusedFromReviewContextReuseSha256,
        reusedFromReviewScopeSha256: options.reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256: options.reusedFromCodeScopeSha256,
        minEventSequenceExclusive: latestCompilePassSequence
    });
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
    canonicalSourceOfTruth?: string | null;
    executionProvider?: string | null;
    executionProviderSource?: string | null;
    allowLegacyReviewContextIdentityFallback?: boolean;
    timelineEvents?: readonly ReviewDependencyTimelineEvent[];
}): ReviewArtifactGateEligibilityResult {
    const { resolvedTaskId, reviewKey, required, skippedByOverride, reviewArtifact } = options;
    const errors: string[] = [];
    const artifactPath = reviewArtifact.path;
    const artifactContent = reviewArtifact.content;
    const reviewContext = reviewArtifact.reviewContext;
    const routingMetadata = toPlainRecord(reviewContext?.reviewer_routing);
    const contextExecutionMode = normalizeCompatibilityReviewerExecutionMode(routingMetadata?.actual_execution_mode);
    const contextReviewerSessionId = typeof routingMetadata?.reviewer_session_id === 'string'
        ? String(routingMetadata.reviewer_session_id).trim()
        : '';
    const contextFallbackReason = typeof routingMetadata?.fallback_reason === 'string'
        ? String(routingMetadata.fallback_reason).trim()
        : '';
    const canonicalSourceOfTruth = normalizeSourceOfTruthValue(options.canonicalSourceOfTruth);
    const currentExecutionProvider = normalizeSourceOfTruthValue(options.executionProvider);
    const resolvedRoutingIdentity = resolveReviewContextRoutingIdentity({
        reviewerRouting: routingMetadata,
        canonicalSourceOfTruth,
        executionProvider: currentExecutionProvider,
        allowLegacyCompatibility: options.allowLegacyReviewContextIdentityFallback === true
    });
    const legacySourceOfTruth = resolvedRoutingIdentity.legacy_source_of_truth;
    const routingCanonicalSourceOfTruth = resolvedRoutingIdentity.canonical_source_of_truth;
    const routingExecutionProvider = resolvedRoutingIdentity.execution_provider;
    const routingExecutionProviderSource = normalizeRuntimeIdentitySource(routingMetadata?.execution_provider_source);
    const routingIdentityStatus = resolvedRoutingIdentity.identity_status;
    const currentExecutionProviderSource = normalizeRuntimeIdentitySource(options.executionProviderSource);
    const routingPolicy = resolveReviewerRoutingPolicy(
        routingExecutionProvider ?? legacySourceOfTruth,
        routingExecutionProviderSource
    );
    const routingPolicySummary = {
        source_of_truth: legacySourceOfTruth,
        canonical_source_of_truth: routingCanonicalSourceOfTruth,
        execution_provider: routingExecutionProvider,
        execution_provider_source: routingExecutionProviderSource,
        identity_status: routingIdentityStatus,
        explicit_split_identity_present: resolvedRoutingIdentity.explicit_split_identity_present,
        legacy_identity_compatibility_applied: resolvedRoutingIdentity.legacy_identity_compatibility_applied,
        routed_to: typeof routingMetadata?.routed_to === 'string' ? String(routingMetadata.routed_to).trim() || null : null,
        provider_bridge: typeof routingMetadata?.provider_bridge === 'string' ? String(routingMetadata.provider_bridge).trim() || null : null,
        routing_provider: routingPolicy.source_of_truth,
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
    let reviewerProvenance: ReturnType<typeof normalizeReviewReceiptReviewerProvenance> = null;
    let trustLevel: string | null = null;
    let receiptReviewContextSha256: string | null = null;
    let validatedReceipt: ReviewReceipt | null = null;
    let currentArtifactSha256: string | null = null;
    let reusedExistingReview = false;
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
            if (!canonicalSourceOfTruth) {
                errors.push(
                    `Review '${reviewKey}' cannot be validated because the active workspace is missing canonical SourceOfTruth.`
                );
            } else if (!routingCanonicalSourceOfTruth) {
                errors.push(`Review '${reviewKey}' review-context is missing canonical_source_of_truth.`);
            } else if (routingCanonicalSourceOfTruth !== canonicalSourceOfTruth) {
                errors.push(
                    `Review '${reviewKey}' review-context canonical_source_of_truth (${routingCanonicalSourceOfTruth}) does not match canonical provider (${canonicalSourceOfTruth}).`
                );
            }
            if (!currentExecutionProvider) {
                errors.push(
                    `Review '${reviewKey}' cannot be validated because the active task is missing execution provider identity.`
                );
            } else if (!routingExecutionProvider) {
                errors.push(`Review '${reviewKey}' review-context is missing execution_provider.`);
            } else if (routingExecutionProvider !== currentExecutionProvider) {
                errors.push(
                    `Review '${reviewKey}' review-context execution_provider (${routingExecutionProvider}) does not match active runtime provider (${currentExecutionProvider}).`
                );
            }
            if (resolvedRoutingIdentity.explicit_split_identity_present && !routingExecutionProviderSource) {
                errors.push(`Review '${reviewKey}' review-context is missing execution_provider_source.`);
            } else if (
                resolvedRoutingIdentity.explicit_split_identity_present
                && currentExecutionProviderSource
                && routingExecutionProviderSource !== currentExecutionProviderSource
            ) {
                errors.push(
                    `Review '${reviewKey}' review-context execution_provider_source (${routingExecutionProviderSource}) ` +
                    `does not match active runtime source (${currentExecutionProviderSource}).`
                );
            }
            if (!routingIdentityStatus) {
                errors.push(`Review '${reviewKey}' review-context is missing identity_status.`);
            } else if (routingIdentityStatus !== 'resolved') {
                errors.push(
                    `Review '${reviewKey}' review-context runtime identity status must be 'resolved', got '${routingIdentityStatus}'.`
                );
            }
        }

        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        if (reviewArtifact.receipt || fs.existsSync(receiptPath)) {
            try {
                const receipt = reviewArtifact.receipt ?? JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
                validatedReceipt = receipt;
                const currentArtifactHash = reviewArtifact.artifactSha256 ?? fileSha256(artifactPath);
                currentArtifactSha256 = currentArtifactHash;
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
                    reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(receipt.reviewer_execution_mode);
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
                if (receipt.reviewer_provenance != null) {
                    reviewerProvenance = normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
                    if (!reviewerProvenance) {
                        errors.push(`Review receipt for '${reviewKey}' has invalid reviewer_provenance.`);
                    }
                }
                if (receipt.trust_level) {
                    trustLevel = String(receipt.trust_level).trim().toUpperCase();
                }
                reusedExistingReview = receipt.reused_existing_review === true;
                receiptReviewContextSha256 = String(receipt.review_context_sha256 || '').trim().toLowerCase() || null;
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
            if (!reusedExistingReview && !contextExecutionMode) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.actual_execution_mode in review-context.`);
            }
            if (!reusedExistingReview && !contextReviewerSessionId) {
                errors.push(`Review '${reviewKey}' is missing reviewer_routing.reviewer_session_id in review-context.`);
            }
            if (!reusedExistingReview && reviewerExecutionMode && contextExecutionMode && reviewerExecutionMode !== contextExecutionMode) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent execution mode between receipt (${reviewerExecutionMode}) ` +
                    `and review-context (${contextExecutionMode}).`
                );
            }
            if (!reusedExistingReview && reviewerIdentity && contextReviewerSessionId && reviewerIdentity !== contextReviewerSessionId) {
                errors.push(
                    `Review '${reviewKey}' has inconsistent reviewer identity between receipt (${reviewerIdentity}) ` +
                    `and review-context (${contextReviewerSessionId}).`
                );
            }
            if (reviewerFallbackReason && contextFallbackReason && reviewerFallbackReason !== contextFallbackReason) {
                errors.push(`Review '${reviewKey}' has inconsistent fallback reason between receipt and review-context.`);
            }
            if (reviewerExecutionMode === 'same_agent_fallback') {
                errors.push(
                    `Review '${reviewKey}' used deprecated same_agent_fallback evidence. ` +
                    'Record a fresh delegated_subagent review for the current cycle.'
                );
            }
            if (!reusedExistingReview && contextExecutionMode === 'same_agent_fallback') {
                errors.push(
                    `Review '${reviewKey}' review-context records deprecated same_agent_fallback routing. ` +
                    'Record fresh delegated reviewer routing for the current cycle.'
                );
            }
            if (reviewerFallbackReason) {
                errors.push(
                    `Review '${reviewKey}' receipt includes reviewer_fallback_reason, but mandatory reviews now require delegated_subagent only.`
                );
            }
            if (!reusedExistingReview && contextFallbackReason) {
                errors.push(
                    `Review '${reviewKey}' review-context includes reviewer_routing.fallback_reason, but mandatory reviews now require delegated_subagent only.`
                );
            }
            if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && reviewerIdentity.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity is self-scoped (${reviewerIdentity}).`);
            } else if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && !reviewerIdentity.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' claims delegated_subagent execution but reviewer_identity must be agent-scoped (expected prefix 'agent:').`);
            }
            if (!reusedExistingReview && contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && contextReviewerSessionId.startsWith('self:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id is self-scoped (${contextReviewerSessionId}).`);
            } else if (!reusedExistingReview && contextExecutionMode === 'delegated_subagent' && contextReviewerSessionId && !contextReviewerSessionId.startsWith('agent:')) {
                errors.push(`Review '${reviewKey}' review-context claims delegated_subagent execution but reviewer_session_id must be agent-scoped (expected prefix 'agent:').`);
            }
            if (routingPolicy.delegation_required && reviewerExecutionMode !== 'delegated_subagent') {
                errors.push(
                    `Review '${reviewKey}' must use delegated_subagent for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Same-agent self-review is invalid for the mandatory review workflow.'
                );
            }
            if (routingPolicy.expected_execution_mode !== 'delegated_subagent' || !routingPolicy.delegation_required) {
                errors.push(
                    `Review '${reviewKey}' resolved non-delegated reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'. ` +
                    'Mandatory reviews require delegated_subagent routing.'
                );
            }
            if (routingPolicy.fallback_allowed || routingPolicy.fallback_reason_required) {
                errors.push(
                    `Review '${reviewKey}' resolved stale fallback-capable reviewer policy metadata for provider '${routingPolicy.source_of_truth || 'unknown'}'.`
                );
            }
            if (trustLevel === 'LOCAL_AUDITED' && reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
                errors.push(
                    `Review receipt for '${reviewKey}' is missing reviewer_provenance for LOCAL_AUDITED delegated_subagent execution.`
                );
            }
            if (reviewerExecutionMode === 'delegated_subagent') {
                const trustViolation = getMandatoryDelegatedReviewTrustViolation({
                    reviewKey,
                    trustLevel,
                    provenanceAttestationType: reviewerProvenance?.attestation_type
                });
                if (trustViolation) {
                    errors.push(trustViolation);
                }
            }
            if (reviewerExecutionMode === 'delegated_subagent' && reviewerIdentity && options.timelineEvents && options.timelineEvents.length > 0) {
                if (reusedExistingReview) {
                    const latestCompilePassSequence = findLatestTimelineSequence(
                        options.timelineEvents,
                        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
                    );
                    const reuseRecordedEvent = findMatchingReviewReuseRecordedEvent(
                        options.timelineEvents,
                        {
                            reviewType: reviewKey,
                            receiptPath,
                            reviewContextSha256: receiptReviewContextSha256,
                            reviewContextReuseSha256: validatedReceipt?.review_context_reuse_sha256,
                            reviewScopeSha256: validatedReceipt?.review_scope_sha256,
                            codeScopeSha256: validatedReceipt?.code_scope_sha256,
                            reviewArtifactSha256: currentArtifactSha256 ?? reviewArtifact.artifactSha256 ?? fileSha256(artifactPath),
                            reusedFromReceiptPath: typeof validatedReceipt?.reused_from_receipt_path === 'string'
                                ? validatedReceipt.reused_from_receipt_path
                                : null,
                            reusedFromReviewContextSha256: typeof validatedReceipt?.reused_from_review_context_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_context_sha256
                                : null,
                            reusedFromReviewContextReuseSha256: typeof validatedReceipt?.reused_from_review_context_reuse_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_context_reuse_sha256
                                : null,
                            reusedFromReviewScopeSha256: typeof validatedReceipt?.reused_from_review_scope_sha256 === 'string'
                                ? validatedReceipt.reused_from_review_scope_sha256
                                : null,
                            reusedFromCodeScopeSha256: typeof validatedReceipt?.reused_from_code_scope_sha256 === 'string'
                                ? validatedReceipt.reused_from_code_scope_sha256
                                : null
                        }
                    );
                    if (!reuseRecordedEvent) {
                        errors.push(
                            `Review '${reviewKey}' is missing current-cycle REVIEW_RECORDED reuse telemetry.`
                        );
                    }
                    if (!reviewerProvenance) {
                        errors.push(
                            `Review receipt for '${reviewKey}' is missing historical reviewer_provenance for delegated_subagent reuse.`
                        );
                    } else if (reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
                        errors.push(
                            `Review receipt for '${reviewKey}' reuse must preserve historical REVIEWER_INVOCATION_ATTESTED provenance.`
                        );
                    } else {
                        const historicalInvocationEvent = findMatchingInvocationAttestationEvent(
                            options.timelineEvents,
                            {
                                taskId: resolvedTaskId || '',
                                reviewType: reviewKey,
                                reviewerExecutionMode,
                                reviewerIdentity,
                                reviewContextSha256: reviewerProvenance.review_context_sha256,
                                routingEventSha256: reviewerProvenance.routing_event_sha256,
                                reviewerProvenance
                            }
                        );
                        if (!historicalInvocationEvent) {
                            errors.push(
                                `Review receipt for '${reviewKey}' reused historical reviewer_provenance that does not match REVIEWER_INVOCATION_ATTESTED telemetry.`
                            );
                        } else if (!findMatchingHistoricalReviewRecordedTelemetryEvent(options.timelineEvents, {
                            taskId: resolvedTaskId || '',
                            reviewType: reviewKey,
                            receiptPath: typeof validatedReceipt?.reused_from_receipt_path === 'string'
                                ? validatedReceipt.reused_from_receipt_path
                                : receiptPath,
                            reviewContextSha256: validatedReceipt?.reused_from_review_context_sha256 || reviewerProvenance.review_context_sha256,
                            reviewContextReuseSha256: validatedReceipt?.reused_from_review_context_reuse_sha256,
                            reviewScopeSha256: validatedReceipt?.reused_from_review_scope_sha256,
                            codeScopeSha256: validatedReceipt?.reused_from_code_scope_sha256,
                            reviewArtifactSha256: currentArtifactSha256 ?? reviewArtifact.artifactSha256 ?? fileSha256(artifactPath),
                            reviewerExecutionMode,
                            reviewerIdentity,
                            reviewerProvenance: reviewerProvenance as unknown as Record<string, unknown>,
                            maxEventSequenceExclusive: latestCompilePassSequence
                        })) {
                            errors.push(
                                `Review receipt for '${reviewKey}' reused historical reviewer_provenance that does not match historical REVIEW_RECORDED telemetry.`
                            );
                        }
                    }
                } else {
                    const routingEvent = findMatchingRoutingEvent(
                        options.timelineEvents,
                        reviewKey,
                        reviewerExecutionMode,
                        reviewerIdentity,
                        reviewerFallbackReason,
                        reviewerProvenance
                    );
                    if (!routingEvent) {
                        errors.push(
                            `Review '${reviewKey}' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle for reviewer '${reviewerIdentity}'.`
                        );
                    } else if (!routingEvent.integrity) {
                        errors.push(
                            `Review '${reviewKey}' cannot validate reviewer_provenance because matching REVIEWER_DELEGATION_ROUTED telemetry is missing integrity.`
                        );
                    } else {
                        if (trustLevel === 'LOCAL_AUDITED') {
                            errors.push(
                                `Review receipt for '${reviewKey}' cannot claim LOCAL_AUDITED trust for delegated_subagent execution. ` +
                                'Current local routing telemetry is asserted-only until a separate launch-attestation contract exists.'
                            );
                        }
                        if (!reviewerProvenance) {
                            errors.push(
                                `Review receipt for '${reviewKey}' is missing reviewer_provenance for delegated_subagent execution.`
                            );
                        } else if (reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation') {
                            errors.push(
                                `Review receipt for '${reviewKey}' reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry.`
                            );
                        } else {
                            const invocationAttestationEvent = findMatchingInvocationAttestationEvent(
                                options.timelineEvents,
                                {
                                    taskId: resolvedTaskId || '',
                                    reviewType: reviewKey,
                                    reviewerExecutionMode,
                                    reviewerIdentity,
                                    reviewContextSha256: receiptReviewContextSha256,
                                    routingEventSha256: String(routingEvent.integrity.event_sha256 || '').trim().toLowerCase(),
                                    reviewerProvenance
                                }
                            );
                            if (!invocationAttestationEvent) {
                                errors.push(
                                    `Review receipt for '${reviewKey}' reviewer_provenance does not match REVIEWER_INVOCATION_ATTESTED launch telemetry.`
                                );
                            }
                        }
                    }
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
    canonicalSourceOfTruth?: string | null;
    executionProvider?: string | null;
    executionProviderSource?: string | null;
    allowLegacyReviewContextIdentityFallback?: boolean;
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
                sourceOfTruth: options.sourceOfTruth,
                canonicalSourceOfTruth,
                executionProvider,
                executionProviderSource: options.executionProviderSource,
                allowLegacyReviewContextIdentityFallback,
                timelineEvents
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
