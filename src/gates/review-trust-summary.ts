import { normalizeReviewReceiptReviewerProvenance } from '../gate-runtime/review-context';

type ReviewerExecutionMode = 'DELEGATED_SUBAGENT' | 'SAME_AGENT_FALLBACK';

export interface ReviewTrustEvidenceEntry {
    review_type: string;
    trust_level?: string | null;
    reviewer_execution_mode?: string | null;
    reviewer_identity?: string | null;
    reviewer_fallback_reason?: string | null;
    reviewer_fallback_reason_required?: boolean | null;
    reviewer_provenance?: unknown;
}

export interface ReviewTrustSummary {
    status:
        | 'UNAVAILABLE'
        | 'ASSERTED_LOCAL_ONLY'
        | 'LEGACY_LOCAL_AUDITED_CLAIM'
        | 'MIXED_LOCAL_TRUST'
        | 'INDEPENDENT_AUDITED';
    trust_levels: string[];
    execution_modes: string[];
    independent_review_attested: boolean;
    completion_policy: 'ASSERTED_LOCAL_ALLOWED' | 'INDEPENDENT_REVIEW_ATTESTED';
    visible_summary_line: string;
    policy_summary_line: string;
}

export interface ReviewTrustCompatibilityArtifact {
    content?: string | null;
    receipt?: Record<string, unknown> | null;
    reviewContext?: Record<string, unknown> | null;
}

function normalizeToken(value: unknown): string | null {
    const normalized = String(value || '').trim().toUpperCase();
    return normalized ? normalized : null;
}

function normalizeLocalTrustLevel(value: unknown): 'LOCAL_ASSERTED' | 'LOCAL_AUDITED' | null {
    const normalized = normalizeToken(value);
    if (normalized === 'LOCAL_ASSERTED' || normalized === 'LOCAL_AUDITED') {
        return normalized;
    }
    return null;
}

function normalizeReviewerExecutionMode(value: unknown): ReviewerExecutionMode | null {
    const normalized = normalizeToken(value);
    if (normalized === 'DELEGATED_SUBAGENT' || normalized === 'SAME_AGENT_FALLBACK') {
        return normalized;
    }
    return null;
}

function formatModes(executionModes: ReviewerExecutionMode[]): string {
    return executionModes.length > 0 ? executionModes.join(', ') : 'unknown execution mode';
}

function formatScopeLabel(scopeCategory: string | null | undefined): string {
    const normalized = String(scopeCategory || '').trim();
    return normalized ? `${normalized} task` : 'task';
}

function getReviewTrustFallbackReasonRequired(reviewContext: Record<string, unknown> | null): boolean | null {
    if (!reviewContext) {
        return null;
    }
    const reviewerRouting = reviewContext.reviewer_routing
        && typeof reviewContext.reviewer_routing === 'object'
        && !Array.isArray(reviewContext.reviewer_routing)
        ? reviewContext.reviewer_routing as Record<string, unknown>
        : null;
    return reviewerRouting && typeof reviewerRouting.fallback_reason_required === 'boolean'
        ? reviewerRouting.fallback_reason_required
        : null;
}

function hasReviewTrustCompatibilityArtifact(artifact: ReviewTrustCompatibilityArtifact | null | undefined): boolean {
    if (!artifact || typeof artifact !== 'object') {
        return false;
    }
    if (typeof artifact.content === 'string' && artifact.content.trim()) {
        return true;
    }
    if (artifact.receipt && typeof artifact.receipt === 'object' && !Array.isArray(artifact.receipt)) {
        return true;
    }
    return !!(
        artifact.reviewContext
        && typeof artifact.reviewContext === 'object'
        && !Array.isArray(artifact.reviewContext)
    );
}

export function buildReviewTrustSummaryFromCompatibilityArtifacts(
    artifacts: Record<string, ReviewTrustCompatibilityArtifact>,
    scopeCategory: string | null | undefined
): ReviewTrustSummary | null {
    const artifactEntries = Object.entries(artifacts);
    const discoveredArtifacts = artifactEntries.filter(([, artifact]) => hasReviewTrustCompatibilityArtifact(artifact)).length;
    if (discoveredArtifacts <= 0) {
        return null;
    }

    const entries = artifactEntries.flatMap(([reviewType, artifact]) => {
        if (!artifact || typeof artifact !== 'object') {
            return [];
        }
        const receipt = artifact.receipt
            && typeof artifact.receipt === 'object'
            && !Array.isArray(artifact.receipt)
            ? artifact.receipt
            : null;
        const reviewContext = artifact.reviewContext
            && typeof artifact.reviewContext === 'object'
            && !Array.isArray(artifact.reviewContext)
            ? artifact.reviewContext
            : null;
        const artifactContent = typeof artifact.content === 'string' ? artifact.content.trim() : '';
        if (!receipt || !artifactContent) {
            return [];
        }
        return [{
            review_type: reviewType,
            trust_level: typeof receipt.trust_level === 'string' ? receipt.trust_level : null,
            reviewer_execution_mode: typeof receipt.reviewer_execution_mode === 'string'
                ? receipt.reviewer_execution_mode
                : null,
            reviewer_identity: typeof receipt.reviewer_identity === 'string' ? receipt.reviewer_identity : null,
            reviewer_fallback_reason: typeof receipt.reviewer_fallback_reason === 'string'
                ? receipt.reviewer_fallback_reason
                : null,
            reviewer_fallback_reason_required: getReviewTrustFallbackReasonRequired(reviewContext),
            reviewer_provenance: receipt.reviewer_provenance ?? null
        }];
    });

    return buildReviewTrustSummary(entries, scopeCategory, discoveredArtifacts);
}

export function buildReviewTrustSummary(
    entries: ReviewTrustEvidenceEntry[],
    scopeCategory: string | null | undefined,
    requiredReviewCount = entries.length
): ReviewTrustSummary | null {
    if (requiredReviewCount <= 0) {
        return null;
    }

    const normalizedEntries = entries.map((entry) => {
        const normalizedTrustLevel = normalizeLocalTrustLevel(entry.trust_level);
        const normalizedExecutionMode = normalizeReviewerExecutionMode(entry.reviewer_execution_mode);
        const normalizedReviewerIdentity = String(entry.reviewer_identity || '').trim();
        const normalizedFallbackReason = String(entry.reviewer_fallback_reason || '').trim();
        const fallbackReasonRequired = typeof entry.reviewer_fallback_reason_required === 'boolean'
            ? entry.reviewer_fallback_reason_required
            : null;
        const provenanceProvided = entry.reviewer_provenance != null;
        const normalizedProvenance = provenanceProvided
            ? normalizeReviewReceiptReviewerProvenance(entry.reviewer_provenance)
            : null;
        const missingDelegatedProvenance =
            normalizedExecutionMode === 'DELEGATED_SUBAGENT'
            && normalizedProvenance == null;
        const missingFallbackReason =
            normalizedExecutionMode === 'SAME_AGENT_FALLBACK'
            && fallbackReasonRequired !== false
            && !normalizedFallbackReason;
        const invalidDelegatedIdentity =
            normalizedExecutionMode === 'DELEGATED_SUBAGENT'
            && (!normalizedReviewerIdentity || !normalizedReviewerIdentity.startsWith('agent:'));
        const invalidFallbackIdentity =
            normalizedExecutionMode === 'SAME_AGENT_FALLBACK'
            && (!normalizedReviewerIdentity || !normalizedReviewerIdentity.startsWith('self:'));
        return {
            trust_level: normalizedTrustLevel,
            execution_mode: normalizedExecutionMode,
            invalid_identity: !normalizedReviewerIdentity || invalidDelegatedIdentity || invalidFallbackIdentity,
            invalid_fallback_reason: missingFallbackReason,
            invalid_provenance: (provenanceProvided && normalizedProvenance == null) || missingDelegatedProvenance
        };
    });
    const usableEntries = normalizedEntries.filter(
        (entry) => entry.trust_level != null
            && entry.execution_mode != null
            && !entry.invalid_identity
            && !entry.invalid_fallback_reason
            && !entry.invalid_provenance
    );
    const trustLevels = [...new Set(
        usableEntries
            .map((entry) => entry.trust_level)
            .filter((entry): entry is 'LOCAL_ASSERTED' | 'LOCAL_AUDITED' => entry != null)
    )].sort();
    const executionModes = [...new Set(
        usableEntries
            .map((entry) => entry.execution_mode)
            .filter((entry): entry is ReviewerExecutionMode => entry != null)
    )].sort();
    const scopeLabel = formatScopeLabel(scopeCategory);

    if (
        entries.length === 0
        || trustLevels.length === 0
        || entries.length < requiredReviewCount
        || usableEntries.length < requiredReviewCount
    ) {
        return {
            status: 'UNAVAILABLE',
            trust_levels: [],
            execution_modes: executionModes,
            independent_review_attested: false,
            completion_policy: 'ASSERTED_LOCAL_ALLOWED',
            visible_summary_line: 'Review trust: unavailable (required review trust evidence incomplete or invalid).',
            policy_summary_line:
                `Review policy: asserted local review may finish this ${scopeLabel}; ` +
                'independent audited review requires separate attestation or human sign-off.'
        };
    }

    let status: ReviewTrustSummary['status'];
    let visibleSummaryLine: string;
    if (trustLevels.length === 1 && trustLevels[0] === 'LOCAL_ASSERTED') {
        status = 'ASSERTED_LOCAL_ONLY';
        visibleSummaryLine =
            `Review trust: LOCAL_ASSERTED via ${formatModes(executionModes)}; ` +
            'not independent audited review.';
    } else if (trustLevels.length === 1 && trustLevels[0] === 'LOCAL_AUDITED') {
        status = 'LEGACY_LOCAL_AUDITED_CLAIM';
        visibleSummaryLine =
            `Review trust: legacy LOCAL_AUDITED claim via ${formatModes(executionModes)}; ` +
            'treat as local historical evidence, not independent audited review.';
    } else {
        status = 'MIXED_LOCAL_TRUST';
        visibleSummaryLine =
            `Review trust: mixed local trust receipts (${trustLevels.join(', ')}) via ${formatModes(executionModes)}; ` +
            'not independent audited review.';
    }

    return {
        status,
        trust_levels: trustLevels,
        execution_modes: executionModes,
        independent_review_attested: false,
        completion_policy: 'ASSERTED_LOCAL_ALLOWED',
        visible_summary_line: visibleSummaryLine,
        policy_summary_line:
            `Review policy: asserted local review may finish this ${scopeLabel}; ` +
            'independent audited review requires separate attestation or human sign-off.'
    };
}
