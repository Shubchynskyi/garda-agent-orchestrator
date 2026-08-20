import {
    normalizeCompatibilityReviewerExecutionMode,
    normalizeReviewReceiptReviewerProvenance
} from '../../gate-runtime/review-context';
import { sha256RedactedJsonPayload } from '../../core/redaction';
import { isPlainRecord } from '../../core/records';
import {
    buildPlannedReviewerIdentity,
    isResolvedReviewerIdentity
} from '../../gate-runtime/review/reviewer-identity-contract';

export const REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE = 'delegated_subagent' as const;
export const REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL = 'INDEPENDENT_AUDITED';
export const REVIEW_EVIDENCE_REQUIRED_PROVENANCE_ATTESTATION_TYPE = 'reviewer_invocation_attestation';
export const REVIEW_EVIDENCE_REQUIRED_PROVENANCE_EVENT_TYPE = 'REVIEWER_INVOCATION_ATTESTED';
export const REVIEW_EVIDENCE_AGENT_IDENTITY_PREFIX = 'agent:';

export type ReviewEvidenceReviewerProvenance = ReturnType<typeof normalizeReviewReceiptReviewerProvenance>;

export interface ReviewExecutionEvidenceBindings {
    review_execution_mode: 'FULL' | 'DELTA';
    review_execution_contract_sha256: string;
    review_execution_full_scope_sha256: string;
    review_execution_complete_scope_lineage_sha256: string;
    review_execution_finding_reconciliation_sha256: string;
}

type ReviewExecutionEvidenceInput = Partial<Record<keyof ReviewExecutionEvidenceBindings, unknown>>;

export interface ReviewContextExecutionEvidenceContractResult {
    required: boolean;
    bindings: ReviewExecutionEvidenceBindings | null;
    violations: string[];
}

export interface NormalizedReviewReceiptEvidenceFields {
    reviewArtifactSha256: string | null;
    reviewContextSha256: string | null;
    reviewContextReuseSha256: string | null;
    reviewTreeStateSha256: string | null;
    reviewScopeSha256: string | null;
    codeScopeSha256: string | null;
    reviewExecutionMode: 'FULL' | 'DELTA' | null;
    reviewExecutionContractSha256: string | null;
    reviewExecutionFullScopeSha256: string | null;
    reviewExecutionCompleteScopeLineageSha256: string | null;
    reviewExecutionFindingReconciliationSha256: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reviewerFallbackReason: string | null;
    reviewerProvenance: ReviewEvidenceReviewerProvenance;
    trustLevel: string | null;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256: string | null;
    reusedFromCodeScopeSha256: string | null;
    reviewResultRecordedAtUtc: string | null;
    recordedAtUtc: string | null;
    reviewOutputSourceMtimeUtc: string | null;
}

export interface ReviewReceiptEvidenceContractResult {
    fields: NormalizedReviewReceiptEvidenceFields;
    violations: string[];
}

function contextReviewerIdentityMatchesReceipt(options: {
    taskId: string;
    reviewType: string;
    contextReviewerIdentity: string | null;
    receiptReviewerIdentity: string | null;
}): boolean {
    if (options.contextReviewerIdentity === options.receiptReviewerIdentity) {
        return true;
    }
    if (!options.receiptReviewerIdentity || !isResolvedReviewerIdentity(options.receiptReviewerIdentity)) {
        return false;
    }
    return options.contextReviewerIdentity === buildPlannedReviewerIdentity(options.taskId, options.reviewType);
}

function normalizeText(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function normalizeReviewExecutionMode(value: unknown): 'FULL' | 'DELTA' | null {
    const normalized = String(value || '').trim().toUpperCase();
    return normalized === 'FULL' || normalized === 'DELTA' ? normalized : null;
}

export function normalizeReviewEvidenceSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

export function normalizeReviewEvidenceTrustLevel(value: unknown): string | null {
    const normalized = String(value || '').trim().toUpperCase();
    return normalized || null;
}

export function normalizeReviewEvidenceReviewerIdentity(value: unknown): string | null {
    return normalizeText(value);
}

export function normalizeReviewReceiptEvidenceFields(
    receipt: Record<string, unknown>
): NormalizedReviewReceiptEvidenceFields {
    return {
        reviewArtifactSha256: normalizeReviewEvidenceSha256(receipt.review_artifact_sha256),
        reviewContextSha256: normalizeReviewEvidenceSha256(receipt.review_context_sha256),
        reviewContextReuseSha256: normalizeReviewEvidenceSha256(receipt.review_context_reuse_sha256),
        reviewTreeStateSha256: normalizeReviewEvidenceSha256(receipt.review_tree_state_sha256),
        reviewScopeSha256: normalizeReviewEvidenceSha256(receipt.review_scope_sha256),
        codeScopeSha256: normalizeReviewEvidenceSha256(receipt.code_scope_sha256),
        reviewExecutionMode: normalizeReviewExecutionMode(receipt.review_execution_mode),
        reviewExecutionContractSha256: normalizeReviewEvidenceSha256(receipt.review_execution_contract_sha256),
        reviewExecutionFullScopeSha256: normalizeReviewEvidenceSha256(receipt.review_execution_full_scope_sha256),
        reviewExecutionCompleteScopeLineageSha256: normalizeReviewEvidenceSha256(
            receipt.review_execution_complete_scope_lineage_sha256
        ),
        reviewExecutionFindingReconciliationSha256: normalizeReviewEvidenceSha256(
            receipt.review_execution_finding_reconciliation_sha256
        ),
        reviewerExecutionMode: normalizeCompatibilityReviewerExecutionMode(receipt.reviewer_execution_mode),
        reviewerIdentity: normalizeReviewEvidenceReviewerIdentity(receipt.reviewer_identity),
        reviewerFallbackReason: normalizeText(receipt.reviewer_fallback_reason),
        reviewerProvenance: receipt.reviewer_provenance == null
            ? null
            : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance),
        trustLevel: normalizeReviewEvidenceTrustLevel(receipt.trust_level),
        reusedExistingReview: receipt.reused_existing_review === true,
        reusedFromReceiptPath: normalizeText(receipt.reused_from_receipt_path),
        reusedFromReceiptSha256: normalizeReviewEvidenceSha256(receipt.reused_from_receipt_sha256),
        reusedFromReviewContextSha256: normalizeReviewEvidenceSha256(receipt.reused_from_review_context_sha256),
        reusedFromReviewContextReuseSha256: normalizeReviewEvidenceSha256(receipt.reused_from_review_context_reuse_sha256),
        reusedFromReviewTreeStateSha256: normalizeReviewEvidenceSha256(receipt.reused_from_review_tree_state_sha256),
        reusedFromReviewScopeSha256: normalizeReviewEvidenceSha256(receipt.reused_from_review_scope_sha256),
        reusedFromCodeScopeSha256: normalizeReviewEvidenceSha256(receipt.reused_from_code_scope_sha256),
        reviewResultRecordedAtUtc: normalizeText(receipt.review_result_recorded_at_utc),
        recordedAtUtc: normalizeText(receipt.recorded_at_utc),
        reviewOutputSourceMtimeUtc: normalizeText(receipt.review_output_source_mtime_utc)
    };
}

export function resolveReviewContextExecutionEvidenceBindings(
    reviewContext: Record<string, unknown> | null
): ReviewContextExecutionEvidenceContractResult {
    const schemaVersion = Number(reviewContext?.schema_version);
    const required = Number.isInteger(schemaVersion) && schemaVersion >= 4;
    if (!required) {
        return { required: false, bindings: null, violations: [] };
    }
    const reviewExecution = isPlainRecord(reviewContext?.review_execution)
        ? reviewContext.review_execution
        : null;
    const mode = normalizeReviewExecutionMode(reviewExecution?.mode);
    const contractSha256 = normalizeReviewEvidenceSha256(reviewExecution?.contract_sha256);
    const fullScopeSha256 = normalizeReviewEvidenceSha256(reviewExecution?.full_review_scope_sha256);
    const completeScopeLineageSha256 = normalizeReviewEvidenceSha256(
        reviewExecution?.complete_scope_lineage_sha256
    );
    const findingReconciliation = isPlainRecord(reviewExecution?.finding_reconciliation)
        ? reviewExecution.finding_reconciliation
        : null;
    if (
        !mode
        || !contractSha256
        || !/^[0-9a-f]{64}$/u.test(contractSha256)
        || !fullScopeSha256
        || !/^[0-9a-f]{64}$/u.test(fullScopeSha256)
        || !completeScopeLineageSha256
        || !/^[0-9a-f]{64}$/u.test(completeScopeLineageSha256)
        || !findingReconciliation
    ) {
        return {
            required: true,
            bindings: null,
            violations: [
                'schema-4 review context is missing valid authenticated review_execution lineage bindings'
            ]
        };
    }
    return {
        required: true,
        bindings: {
            review_execution_mode: mode,
            review_execution_contract_sha256: contractSha256,
            review_execution_full_scope_sha256: fullScopeSha256,
            review_execution_complete_scope_lineage_sha256: completeScopeLineageSha256,
            review_execution_finding_reconciliation_sha256: sha256RedactedJsonPayload(findingReconciliation)
        },
        violations: []
    };
}

export function getReviewExecutionEvidenceContractViolations(options: {
    reviewContext: Record<string, unknown> | null;
    evidence: Record<string, unknown> | null;
    evidenceLabel?: string;
}): string[] {
    const expected = resolveReviewContextExecutionEvidenceBindings(options.reviewContext);
    if (!expected.required) {
        return [];
    }
    if (!expected.bindings) {
        return expected.violations;
    }
    return getReviewExecutionEvidenceBindingViolations({
        expectedEvidence: expected.bindings,
        evidence: options.evidence,
        evidenceLabel: options.evidenceLabel,
        expectedEvidenceLabel: 'the authenticated schema-4 review context'
    });
}

function normalizeReviewExecutionEvidenceBindings(
    evidence: ReviewExecutionEvidenceInput | null
): Record<keyof ReviewExecutionEvidenceBindings, string | null> {
    return {
        review_execution_mode: normalizeReviewExecutionMode(evidence?.review_execution_mode),
        review_execution_contract_sha256: normalizeReviewEvidenceSha256(evidence?.review_execution_contract_sha256),
        review_execution_full_scope_sha256: normalizeReviewEvidenceSha256(evidence?.review_execution_full_scope_sha256),
        review_execution_complete_scope_lineage_sha256: normalizeReviewEvidenceSha256(
            evidence?.review_execution_complete_scope_lineage_sha256
        ),
        review_execution_finding_reconciliation_sha256: normalizeReviewEvidenceSha256(
            evidence?.review_execution_finding_reconciliation_sha256
        )
    };
}

export function getReviewExecutionEvidenceBindingViolations(options: {
    expectedEvidence: ReviewExecutionEvidenceInput | null;
    evidence: ReviewExecutionEvidenceInput | null;
    evidenceLabel?: string;
    expectedEvidenceLabel?: string;
}): string[] {
    const label = String(options.evidenceLabel || 'review evidence').trim();
    const expectedLabel = String(options.expectedEvidenceLabel || 'the authenticated review execution evidence').trim();
    const expected = normalizeReviewExecutionEvidenceBindings(options.expectedEvidence);
    const actual = normalizeReviewExecutionEvidenceBindings(options.evidence);
    const violations: string[] = [];
    for (const [field, expectedValue] of Object.entries(expected) as Array<
        [keyof ReviewExecutionEvidenceBindings, string | null]
    >) {
        if (!expectedValue || (field !== 'review_execution_mode' && !/^[0-9a-f]{64}$/u.test(expectedValue))) {
            violations.push(`${expectedLabel} is missing valid ${field}`);
            continue;
        }
        const actualValue = actual[field];
        if (!actualValue || (field !== 'review_execution_mode' && !/^[0-9a-f]{64}$/u.test(actualValue))) {
            violations.push(`${label} is missing valid ${field}`);
        } else if (actualValue !== expectedValue) {
            violations.push(`${label} ${field} does not match ${expectedLabel}`);
        }
    }
    return violations;
}

export function getReviewReceiptExecutionEvidenceContractViolations(options: {
    reviewContext: Record<string, unknown> | null;
    receipt: Record<string, unknown> | null;
}): string[] {
    const expected = resolveReviewContextExecutionEvidenceBindings(options.reviewContext);
    if (!expected.required) {
        return [];
    }
    const violations = getReviewExecutionEvidenceContractViolations({
        reviewContext: options.reviewContext,
        evidence: options.receipt,
        evidenceLabel: 'review receipt'
    });
    const reviewOutputContract = isPlainRecord(options.receipt?.review_output_contract)
        ? options.receipt.review_output_contract
        : null;
    violations.push(...getReviewExecutionEvidenceContractViolations({
        reviewContext: options.reviewContext,
        evidence: reviewOutputContract,
        evidenceLabel: 'review receipt review_output_contract'
    }));
    return violations;
}

export function validateReviewReceiptEvidenceContract(options: {
    taskId: string;
    reviewType: string;
    receipt: Record<string, unknown>;
    artifactSha256: string | null;
    contextSha256: string | null;
    contextReviewTreeStateSha256: string | null;
    contextExecutionMode: string | null;
    contextReviewerIdentity: string | null;
    reviewContext?: Record<string, unknown> | null;
}): ReviewReceiptEvidenceContractResult {
    const fields = normalizeReviewReceiptEvidenceFields(options.receipt);
    const violations: string[] = [];

    violations.push(...getReviewReceiptExecutionEvidenceContractViolations({
        reviewContext: options.reviewContext ?? null,
        receipt: options.receipt
    }));

    if (options.receipt.task_id !== options.taskId) {
        violations.push(`review receipt belongs to task '${String(options.receipt.task_id || '')}'`);
    }
    if (options.receipt.review_type !== options.reviewType) {
        violations.push(`review receipt has review_type '${String(options.receipt.review_type || '')}'`);
    }
    if (!options.artifactSha256 || fields.reviewArtifactSha256 !== options.artifactSha256) {
        violations.push('review artifact hash does not match the receipt');
    }
    if (!options.contextSha256 || fields.reviewContextSha256 !== options.contextSha256) {
        violations.push('review context hash does not match the receipt');
    }
    if (options.contextReviewTreeStateSha256 && !fields.reviewTreeStateSha256) {
        violations.push('review receipt is missing review_tree_state_sha256');
    } else if (
        options.contextReviewTreeStateSha256
        && fields.reviewTreeStateSha256
        && fields.reviewTreeStateSha256 !== options.contextReviewTreeStateSha256
    ) {
        violations.push('review receipt review_tree_state_sha256 does not match the review context tree_state');
    }
    if (fields.reviewerExecutionMode !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE) {
        violations.push("review receipt does not use reviewer_execution_mode 'delegated_subagent'");
    }
    if (fields.trustLevel !== REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL) {
        violations.push("review receipt trust_level must be 'INDEPENDENT_AUDITED'");
    }
    if (!fields.reviewerIdentity?.startsWith(REVIEW_EVIDENCE_AGENT_IDENTITY_PREFIX)) {
        violations.push("review receipt reviewer_identity must use 'agent:' scope");
    } else if (!isResolvedReviewerIdentity(fields.reviewerIdentity)) {
        violations.push('review receipt reviewer_identity must be a resolved delegated reviewer identity, not a planned pending identity');
    }
    if (!fields.reusedExistingReview && options.contextExecutionMode !== REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE) {
        violations.push("review context is missing delegated_subagent routing metadata");
    }
    if (
        !fields.reusedExistingReview
        && !contextReviewerIdentityMatchesReceipt({
            taskId: options.taskId,
            reviewType: options.reviewType,
            contextReviewerIdentity: options.contextReviewerIdentity,
            receiptReviewerIdentity: fields.reviewerIdentity
        })
    ) {
        violations.push('review context reviewer identity does not match the receipt');
    }
    if (options.receipt.reviewer_provenance == null) {
        violations.push('review receipt is missing reviewer_provenance');
    } else if (!fields.reviewerProvenance) {
        violations.push('review receipt reviewer_provenance is invalid');
    } else if (
        !fields.reviewerProvenance.task_sequence
        || !fields.reviewerProvenance.event_sha256
        || !/^[0-9a-f]{64}$/u.test(fields.reviewerProvenance.event_sha256)
    ) {
        violations.push('review receipt reviewer_provenance is incomplete');
    } else if (fields.reviewerProvenance.controller_event_type !== REVIEW_EVIDENCE_REQUIRED_PROVENANCE_EVENT_TYPE) {
        violations.push('review receipt reviewer_provenance must reference REVIEWER_INVOCATION_ATTESTED telemetry');
    } else if (!fields.reviewerProvenance.review_context_sha256) {
        violations.push('review receipt reviewer_provenance is missing review_context_sha256');
    } else if (
        !fields.reusedExistingReview
        && fields.reviewContextSha256
        && fields.reviewerProvenance.review_context_sha256 !== fields.reviewContextSha256
    ) {
        violations.push('review receipt reviewer_provenance review_context_sha256 does not match the receipt');
    } else if (fields.reusedExistingReview && !fields.reusedFromReviewContextSha256) {
        violations.push('reused review receipt is missing reused_from_review_context_sha256');
    } else if (
        fields.reusedExistingReview
        && fields.reusedFromReviewContextSha256
        && fields.reviewerProvenance.review_context_sha256 !== fields.reusedFromReviewContextSha256
    ) {
        violations.push('reused review receipt reviewer_provenance review_context_sha256 does not match reused_from_review_context_sha256');
    } else if (
        !fields.reusedExistingReview
        && fields.reviewTreeStateSha256
        && !fields.reviewerProvenance.review_tree_state_sha256
    ) {
        violations.push('review receipt reviewer_provenance is missing review_tree_state_sha256');
    } else if (
        !fields.reusedExistingReview
        && fields.reviewTreeStateSha256
        && fields.reviewerProvenance.review_tree_state_sha256 !== fields.reviewTreeStateSha256
    ) {
        violations.push('review receipt reviewer_provenance review_tree_state_sha256 does not match the receipt');
    } else if (fields.reusedExistingReview && !fields.reusedFromReviewTreeStateSha256) {
        violations.push('reused review receipt is missing reused_from_review_tree_state_sha256');
    } else if (
        fields.reusedExistingReview
        && fields.reusedFromReviewTreeStateSha256
        && fields.reviewerProvenance.review_tree_state_sha256 !== fields.reusedFromReviewTreeStateSha256
    ) {
        violations.push('reused review receipt reviewer_provenance review_tree_state_sha256 does not match reused_from_review_tree_state_sha256');
    }

    return { fields, violations };
}
