import { buildReviewTrustSummary } from '../../../../src/gates/review/review-trust-summary';
import assert from 'node:assert';
import { test, describe } from 'node:test';

const mockProvenance = {
    schema_version: 1,
    attestation_type: 'reviewer_invocation_attestation',
    controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
    task_sequence: 1,
    event_sha256: 'a'.repeat(64),
    task_id: 'T-071',
    review_type: 'code',
    reviewer_execution_mode: 'delegated_subagent',
    reviewer_identity: 'agent:Gemini',
    review_context_sha256: 'b'.repeat(64),
    routing_event_sha256: 'c'.repeat(64)
};

describe('Review Trust Summary Visibility (T-071)', () => {
    test('surfaces REUSED marker when all reviews are reused', () => {
        const entries = [
            {
                review_type: 'code',
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_execution_mode: 'DELEGATED_SUBAGENT',
                reviewer_identity: 'agent:Gemini',
                reviewer_provenance: { ...mockProvenance },
                reviewer_fallback_reason_required: false,
                reused_existing_review: true
            }
        ];
        const summary = buildReviewTrustSummary(entries, 'code');
        assert.ok(summary?.visible_summary_line.includes('(REUSED)'), `Expected (REUSED) in: ${summary?.visible_summary_line}`);
    });

    test('surfaces REUSED/FRESH counts when mixed', () => {
        const entries = [
            {
                review_type: 'code',
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_execution_mode: 'DELEGATED_SUBAGENT',
                reviewer_identity: 'agent:Gemini',
                reviewer_provenance: { ...mockProvenance },
                reviewer_fallback_reason_required: false,
                reused_existing_review: true
            },
            {
                review_type: 'security',
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_execution_mode: 'DELEGATED_SUBAGENT',
                reviewer_identity: 'agent:Gemini',
                reviewer_provenance: { ...mockProvenance, review_type: 'security' },
                reviewer_fallback_reason_required: false,
                reused_existing_review: false
            }
        ];
        const summary = buildReviewTrustSummary(entries, 'mixed');
        assert.ok(summary?.visible_summary_line.includes('(REUSED: 1, FRESH: 1)'), `Expected (REUSED: 1, FRESH: 1) in: ${summary?.visible_summary_line}`);
    });

    test('does not surface reuse marker when all reviews are fresh', () => {
        const entries = [
            {
                review_type: 'code',
                trust_level: 'INDEPENDENT_AUDITED',
                reviewer_execution_mode: 'DELEGATED_SUBAGENT',
                reviewer_identity: 'agent:Gemini',
                reviewer_provenance: { ...mockProvenance },
                reviewer_fallback_reason_required: false,
                reused_existing_review: false
            }
        ];
        const summary = buildReviewTrustSummary(entries, 'code');
        assert.ok(!summary?.visible_summary_line.includes('REUSED'), `Did not expect REUSED in: ${summary?.visible_summary_line}`);
    });
});
