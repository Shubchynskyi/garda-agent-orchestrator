import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
    REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL,
    resolveReviewContextExecutionEvidenceBindings,
    validateReviewReceiptEvidenceContract
} from '../../../../src/gates/review/review-evidence-contract';

const taskId = 'T-786-2';
const reviewType = 'code';
const artifactSha256 = 'a'.repeat(64);
const contextSha256 = 'b'.repeat(64);
const treeStateSha256 = 'c'.repeat(64);
const routingEventSha256 = 'd'.repeat(64);
const invocationEventSha256 = 'e'.repeat(64);
const previousEventSha256 = 'f'.repeat(64);
const reviewContext = {
    schema_version: 4,
    review_execution: {
        mode: 'DELTA',
        contract_sha256: '1'.repeat(64),
        full_review_scope_sha256: '2'.repeat(64),
        complete_scope_lineage_sha256: '3'.repeat(64),
        finding_reconciliation: {
            protected_open_finding_ids: ['F-001'],
            protected_fix_now_finding_ids: []
        }
    }
};
const reviewExecutionBindings = resolveReviewContextExecutionEvidenceBindings(reviewContext).bindings!;

function buildReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        review_artifact_sha256: artifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeStateSha256,
        reviewer_execution_mode: REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
        reviewer_identity: 'agent:reviewer-1',
        reviewer_provenance: {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: 7,
            prev_event_sha256: previousEventSha256,
            event_sha256: invocationEventSha256,
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
            reviewer_identity: 'agent:reviewer-1',
            review_context_sha256: contextSha256,
            review_tree_state_sha256: treeStateSha256,
            routing_event_sha256: routingEventSha256
        },
        trust_level: REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL,
        ...overrides
    };
}

function validate(receipt: Record<string, unknown>) {
    return validateReviewReceiptEvidenceContract({
        taskId,
        reviewType,
        receipt,
        artifactSha256,
        contextSha256,
        contextReviewTreeStateSha256: treeStateSha256,
        contextExecutionMode: REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
        contextReviewerIdentity: 'agent:reviewer-1'
    });
}

function validateSchema4(receipt: Record<string, unknown>) {
    return validateReviewReceiptEvidenceContract({
        taskId,
        reviewType,
        receipt,
        artifactSha256,
        contextSha256,
        contextReviewTreeStateSha256: treeStateSha256,
        contextExecutionMode: REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
        contextReviewerIdentity: 'agent:reviewer-1',
        reviewContext
    });
}

function buildSchema4Receipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return buildReceipt({
        ...reviewExecutionBindings,
        review_output_contract: {
            schema_version: 1,
            ...reviewExecutionBindings
        },
        ...overrides
    });
}

test('validateReviewReceiptEvidenceContract accepts delegated attested receipt evidence', () => {
    const result = validate(buildReceipt());

    assert.deepEqual(result.violations, []);
    assert.equal(result.fields.reviewerExecutionMode, REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE);
    assert.equal(result.fields.trustLevel, REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL);
    assert.equal(result.fields.reviewerProvenance?.controller_event_type, 'REVIEWER_INVOCATION_ATTESTED');
});

test('validateReviewReceiptEvidenceContract rejects fabricated local receipt evidence', () => {
    const result = validate(buildReceipt({
        trust_level: 'LOCAL_ASSERTED',
        reviewer_identity: 'self:author',
        reviewer_provenance: null
    }));

    assert.ok(result.violations.includes("review receipt trust_level must be 'INDEPENDENT_AUDITED'"));
    assert.ok(result.violations.includes("review receipt reviewer_identity must use 'agent:' scope"));
    assert.ok(result.violations.includes('review receipt is missing reviewer_provenance'));
});

test('validateReviewReceiptEvidenceContract rejects planned pending reviewer identities in receipts', () => {
    const result = validate(buildReceipt({
        reviewer_identity: 'agent:pending:T-786-2-code',
        reviewer_provenance: {
            ...(buildReceipt().reviewer_provenance as Record<string, unknown>),
            reviewer_identity: 'agent:pending:T-786-2-code'
        }
    }));

    assert.ok(result.violations.includes(
        'review receipt reviewer_identity must be a resolved delegated reviewer identity, not a planned pending identity'
    ));
});

test('validateReviewReceiptEvidenceContract rejects stale context and tree-state bindings', () => {
    const staleTreeState = '1'.repeat(64);
    const result = validateReviewReceiptEvidenceContract({
        taskId,
        reviewType,
        receipt: buildReceipt({
            review_context_sha256: '2'.repeat(64),
            review_tree_state_sha256: staleTreeState,
            reviewer_provenance: {
                ...(buildReceipt().reviewer_provenance as Record<string, unknown>),
                review_tree_state_sha256: staleTreeState
            }
        }),
        artifactSha256,
        contextSha256,
        contextReviewTreeStateSha256: treeStateSha256,
        contextExecutionMode: REVIEW_EVIDENCE_REQUIRED_EXECUTION_MODE,
        contextReviewerIdentity: 'agent:reviewer-1'
    });

    assert.ok(result.violations.includes('review context hash does not match the receipt'));
    assert.ok(result.violations.includes('review receipt review_tree_state_sha256 does not match the review context tree_state'));
});

test('validateReviewReceiptEvidenceContract accepts exact schema-4 FULL/DELTA execution lineage', () => {
    const result = validateSchema4(buildSchema4Receipt());

    assert.deepEqual(result.violations, []);
    assert.equal(result.fields.reviewExecutionMode, 'DELTA');
    assert.equal(
        result.fields.reviewExecutionFindingReconciliationSha256,
        reviewExecutionBindings.review_execution_finding_reconciliation_sha256
    );
});

test('validateReviewReceiptEvidenceContract rejects missing schema-4 execution lineage', () => {
    const result = validateSchema4(buildSchema4Receipt({
        review_execution_complete_scope_lineage_sha256: null
    }));

    assert.ok(result.violations.includes(
        'review receipt is missing valid review_execution_complete_scope_lineage_sha256'
    ));
});

test('validateReviewReceiptEvidenceContract rejects stale execution contracts and protected finding reconciliation', () => {
    const result = validateSchema4(buildSchema4Receipt({
        review_execution_contract_sha256: '8'.repeat(64),
        review_execution_finding_reconciliation_sha256: '9'.repeat(64),
        review_output_contract: {
            schema_version: 1,
            ...reviewExecutionBindings,
            review_execution_finding_reconciliation_sha256: '9'.repeat(64)
        }
    }));

    assert.ok(result.violations.includes(
        'review receipt review_execution_contract_sha256 does not match the authenticated schema-4 review context'
    ));
    assert.ok(result.violations.includes(
        'review receipt review_execution_finding_reconciliation_sha256 does not match the authenticated schema-4 review context'
    ));
    assert.ok(result.violations.includes(
        'review receipt review_output_contract review_execution_finding_reconciliation_sha256 does not match the authenticated schema-4 review context'
    ));
});
