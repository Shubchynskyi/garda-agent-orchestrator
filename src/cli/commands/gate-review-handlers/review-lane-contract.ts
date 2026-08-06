import { stringSha256 } from '../../../gate-runtime/hash';
import {
    resolveReviewContextLaneBinding,
    type ReviewContextLaneBinding
} from '../../../gates/review-context/review-context-lane';

const REVIEW_TYPE_ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u;
const MAX_REVIEW_TYPE_ID_LENGTH = 48;
const REVIEW_LANE_ARTIFACT_EVIDENCE_FIELDS = [
    'review_lane_binding_sha256',
    'review_lane_definition_sha256',
    'effective_review_snapshot_sha256',
    'review_catalog_sha256',
    'review_verdict_contract_sha256'
] as const;

export interface ReviewLaneArtifactEvidence extends Record<string, string> {
    review_lane_binding_sha256: string;
    review_lane_definition_sha256: string;
    effective_review_snapshot_sha256: string;
    review_catalog_sha256: string;
    review_verdict_contract_sha256: string;
}

export interface AuthenticatedReviewLaneContract {
    reviewType: string;
    builtIn: boolean;
    passVerdict: string;
    failVerdict: string;
    verdictTokensSha256: string;
    binding: ReviewContextLaneBinding;
    artifactEvidence: ReviewLaneArtifactEvidence | Record<string, never>;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function assertCanonicalReviewTypeId(value: unknown): string {
    const rawValue = typeof value === 'string' ? value : '';
    const normalized = rawValue.trim().toLowerCase();
    if (
        rawValue !== normalized
        || normalized.length > MAX_REVIEW_TYPE_ID_LENGTH
        || !REVIEW_TYPE_ID_PATTERN.test(normalized)
    ) {
        throw new Error(
            `ReviewType must be a lowercase canonical stable id up to ${MAX_REVIEW_TYPE_ID_LENGTH} characters; ` +
            `got '${rawValue || 'missing'}'.`
        );
    }
    return normalized;
}

function buildCustomArtifactEvidence(
    binding: ReviewContextLaneBinding,
    verdictTokensSha256: string
): ReviewLaneArtifactEvidence {
    return {
        review_lane_binding_sha256: binding.binding_sha256,
        review_lane_definition_sha256: binding.lane_definition_sha256,
        effective_review_snapshot_sha256: binding.effective_review_snapshot_sha256,
        review_catalog_sha256: binding.catalog_sha256,
        review_verdict_contract_sha256: verdictTokensSha256
    };
}

export function resolveAuthenticatedReviewLaneContract(options: {
    preflight: Record<string, unknown>;
    reviewContext: Record<string, unknown>;
    reviewType: unknown;
}): AuthenticatedReviewLaneContract {
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);
    const binding = resolveReviewContextLaneBinding(options.preflight, reviewType);
    if (!binding.built_in) {
        const contextBinding = isPlainRecord(options.reviewContext.review_lane)
            ? options.reviewContext.review_lane
            : null;
        if (!contextBinding || JSON.stringify(contextBinding) !== JSON.stringify(binding)) {
            throw new Error(
                `Review context custom review_lane for '${reviewType}' does not match the immutable effective review snapshot.`
            );
        }
    }
    const verdictTokensSha256 = stringSha256(JSON.stringify(binding.verdict_tokens)) || '';
    return {
        reviewType,
        builtIn: binding.built_in,
        passVerdict: binding.verdict_tokens.pass,
        failVerdict: binding.verdict_tokens.fail,
        verdictTokensSha256,
        binding,
        artifactEvidence: binding.built_in
            ? {}
            : buildCustomArtifactEvidence(binding, verdictTokensSha256)
    };
}

export function assertArtifactReviewLaneEvidence(
    artifact: Record<string, unknown>,
    contract: AuthenticatedReviewLaneContract,
    label: string
): void {
    if (contract.builtIn) {
        return;
    }
    const violations: string[] = [];
    for (const [field, expectedValue] of Object.entries(contract.artifactEvidence)) {
        const actualValue = typeof artifact[field] === 'string'
            ? String(artifact[field])
            : '';
        if (actualValue !== expectedValue) {
            violations.push(`${field} must match the immutable custom review lane binding`);
        }
    }
    if (violations.length > 0) {
        throw new Error(`${label} review lane evidence is invalid: ${violations.join('; ')}.`);
    }
}

export function assertArtifactReviewLaneEvidenceMatchesAuthority(
    authorityArtifact: Record<string, unknown>,
    artifact: Record<string, unknown>,
    label: string
): void {
    const hasCustomEvidence = REVIEW_LANE_ARTIFACT_EVIDENCE_FIELDS.some((field) => (
        typeof authorityArtifact[field] === 'string'
        && String(authorityArtifact[field]).length > 0
    ));
    if (!hasCustomEvidence) {
        return;
    }
    const violations = REVIEW_LANE_ARTIFACT_EVIDENCE_FIELDS.flatMap((field) => {
        const expectedValue = typeof authorityArtifact[field] === 'string'
            ? String(authorityArtifact[field])
            : '';
        const actualValue = typeof artifact[field] === 'string'
            ? String(artifact[field])
            : '';
        return actualValue === expectedValue
            ? []
            : [`${field} must match the immutable started custom review lane binding`];
    });
    if (violations.length > 0) {
        throw new Error(`${label} review lane evidence is invalid: ${violations.join('; ')}.`);
    }
}
