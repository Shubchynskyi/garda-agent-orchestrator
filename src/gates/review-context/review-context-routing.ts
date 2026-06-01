import { normalizeRuntimeIdentitySource, normalizeSourceOfTruthValue } from '../review/reviewer-routing';

function hasOwn(record: Record<string, unknown> | null, key: string): boolean {
    return !!record && Object.prototype.hasOwnProperty.call(record, key);
}

export interface ResolvedReviewContextRoutingIdentity {
    legacy_source_of_truth: string | null;
    canonical_source_of_truth: string | null;
    execution_provider: string | null;
    execution_provider_source: string | null;
    identity_status: string | null;
    explicit_split_identity_present: boolean;
    legacy_identity_compatibility_applied: boolean;
}

export function resolveReviewContextRoutingIdentity(options: {
    reviewerRouting: Record<string, unknown> | null | undefined;
    canonicalSourceOfTruth?: unknown;
    executionProvider?: unknown;
    allowLegacyCompatibility?: boolean;
}): ResolvedReviewContextRoutingIdentity {
    const reviewerRouting = options.reviewerRouting && typeof options.reviewerRouting === 'object' && !Array.isArray(options.reviewerRouting)
        ? options.reviewerRouting
        : null;
    const legacySourceOfTruth = normalizeSourceOfTruthValue(reviewerRouting?.source_of_truth);
    const canonicalSourceOfTruth = normalizeSourceOfTruthValue(reviewerRouting?.canonical_source_of_truth);
    const explicitExecutionProvider = normalizeSourceOfTruthValue(reviewerRouting?.execution_provider);
    const explicitExecutionProviderSource = normalizeRuntimeIdentitySource(reviewerRouting?.execution_provider_source);
    const runtimeExecutionProvider = normalizeSourceOfTruthValue(options.executionProvider);
    const identityStatus = String(reviewerRouting?.identity_status || '').trim().toLowerCase() || null;
    const explicitSplitIdentityPresent = [
        'canonical_source_of_truth',
        'execution_provider',
        'execution_provider_source',
        'identity_status'
    ].some((key) => hasOwn(reviewerRouting, key));
    const legacyIdentityCompatibilityApplied = options.allowLegacyCompatibility === true
        && !explicitSplitIdentityPresent
        && !!legacySourceOfTruth;
    return {
        legacy_source_of_truth: legacySourceOfTruth,
        canonical_source_of_truth: canonicalSourceOfTruth
            ?? (legacyIdentityCompatibilityApplied ? normalizeSourceOfTruthValue(options.canonicalSourceOfTruth) : null),
        execution_provider: explicitExecutionProvider
            ?? (legacyIdentityCompatibilityApplied ? (runtimeExecutionProvider ?? legacySourceOfTruth) : null),
        execution_provider_source: explicitExecutionProviderSource,
        identity_status: identityStatus
            ?? (legacyIdentityCompatibilityApplied ? 'resolved' : null),
        explicit_split_identity_present: explicitSplitIdentityPresent,
        legacy_identity_compatibility_applied: legacyIdentityCompatibilityApplied
    };
}
