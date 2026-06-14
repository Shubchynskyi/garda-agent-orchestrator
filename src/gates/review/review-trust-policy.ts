import {
    REVIEW_EVIDENCE_REQUIRED_PROVENANCE_ATTESTATION_TYPE,
    REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL,
    normalizeReviewEvidenceTrustLevel
} from './review-evidence-contract';

export const INDEPENDENT_REVIEW_TRUST_LEVEL = REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL;

export function normalizeReviewTrustLevel(value: unknown): string | null {
    return normalizeReviewEvidenceTrustLevel(value);
}

export function getMandatoryDelegatedReviewTrustViolation(options: {
    reviewKey: string;
    trustLevel: unknown;
    provenanceAttestationType?: unknown;
}): string | null {
    const trustLevel = normalizeReviewTrustLevel(options.trustLevel);
    if (trustLevel !== INDEPENDENT_REVIEW_TRUST_LEVEL) {
        return (
            `Review receipt for '${options.reviewKey}' has trust_level '${trustLevel || 'missing'}'. ` +
            'Mandatory delegated reviews require independent reviewer launch attestation; ' +
            'LOCAL_ASSERTED routing telemetry is not enough.'
        );
    }

    const attestationType = String(options.provenanceAttestationType || '').trim();
    if (attestationType !== REVIEW_EVIDENCE_REQUIRED_PROVENANCE_ATTESTATION_TYPE) {
        return (
            `Review receipt for '${options.reviewKey}' uses '${attestationType || 'missing'}' reviewer_provenance. ` +
            'Mandatory delegated reviews require reviewer_invocation_attestation launch provenance.'
        );
    }

    return null;
}
