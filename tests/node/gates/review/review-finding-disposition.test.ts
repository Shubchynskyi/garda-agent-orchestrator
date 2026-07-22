import assert from 'node:assert/strict';
import test from 'node:test';

import {
    evaluateReviewFindingsReportDispositions,
    evaluateReviewFindingsValidationArtifactDispositions,
    type LockedReviewFindingPolicyResolution
} from '../../../../src/gates/review/review-finding-disposition';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import type { ReviewFinding, ReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';

const STRICT_POLICY: LockedReviewFindingPolicyResolution = {
    policy: {
        schema_version: 1,
        policy_id: 'strict',
        findings: {
            critical: 'fix_now',
            high: 'fix_now',
            medium: 'fix_now',
            low: 'fix_now'
        },
        residual_risk: 'fix_now'
    },
    source: 'preflight_profile_policy_snapshot',
    diagnostics: []
};

function finding(id: string): ReviewFinding {
    return {
        id,
        title: id === 'F-000'
            ? '[garda:evidence-only:missing-focused-validation] test=tests/node/example.test.ts; action=run-and-record-focused-test'
            : 'Actual implementation defect',
        description: id === 'F-000'
            ? 'The reviewer could not execute the focused command.'
            : 'The implementation violates the required behavior.',
        evidence: [{ location: 'src/example.ts:1', observation: 'Concrete scoped evidence.' }],
        coverage_obligation_ids: ['FILE-001']
    };
}

function report(findings: ReviewFinding[]): ReviewFindingsReport {
    return {
        schema_version: 1,
        task_id: 'T-evidence-only',
        review_type: 'code',
        review_context_sha256: 'a'.repeat(64),
        tree_state_sha256: 'b'.repeat(64),
        validation_notes: [],
        coverage_ledger: { coverage_contract_sha256: 'c'.repeat(64), entries: [] },
        findings: { critical: [], high: findings, medium: [], low: [] },
        residual_risks: [],
        reviewer_notes: []
    };
}

function validationArtifact(findings: ReviewFinding[]): ReviewFindingsValidationArtifact {
    return {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: 'T-evidence-only',
        review_type: 'code',
        validation_result_sha256: 'd'.repeat(64),
        validation_result: {
            status: 'accepted',
            accepted: true,
            detected: true,
            violations: [],
            coverage_status: null,
            normalized_inventory: {
                finding_count: findings.length,
                residual_risk_count: 0,
                findings_by_severity: {
                    critical: [],
                    high: findings.map((entry) => ({
                        id: entry.id,
                        severity: 'high',
                        title: entry.title,
                        description: entry.description,
                        evidence_locations: entry.evidence.map((evidence) => evidence.location),
                        coverage_obligation_ids: entry.coverage_obligation_ids
                    })),
                    medium: [],
                    low: []
                },
                residual_risks: []
            },
            evidence_diagnostics: {
                validation_note_evidence_locations: [],
                coverage_evidence_locations: [],
                finding_evidence_locations: findings.flatMap((entry) => entry.evidence.map((evidence) => evidence.location)),
                residual_risk_evidence_locations: [],
                total_evidence_locations: findings.length
            },
            bindings: {
                input: { review_output_sha256: null },
                output: { review_artifact_path: null, review_artifact_sha256: null },
                context: { review_context_path: null, review_context_sha256: null },
                scope: {
                    preflight_path: null,
                    preflight_sha256: null,
                    scope_sha256: null,
                    review_scope_sha256: null,
                    code_scope_sha256: null
                },
                tree: { review_tree_state_sha256: null },
                coverage_contract_sha256: null
            }
        }
    };
}

test('evidence-only F-000 remains audited but is excluded from report disposition', () => {
    const result = evaluateReviewFindingsReportDispositions(report([finding('F-000')]), STRICT_POLICY);

    assert.equal(result.verdict, 'pass_no_findings');
    assert.equal(result.total_count, 0);
    assert.equal(result.blocking_count, 0);
    assert.deepEqual(result.blocking_ids, []);
});

test('evidence-only F-000 remains nonblocking in an accepted validation artifact', () => {
    const result = evaluateReviewFindingsValidationArtifactDispositions(
        validationArtifact([finding('F-000')]),
        STRICT_POLICY
    );

    assert.equal(result.verdict, 'pass_no_findings');
    assert.equal(result.total_count, 0);
    assert.equal(result.blocking_count, 0);
});

test('an ordinary finding still blocks when mixed with evidence-only F-000', () => {
    const result = evaluateReviewFindingsValidationArtifactDispositions(
        validationArtifact([finding('F-000'), finding('F-001')]),
        STRICT_POLICY
    );

    assert.equal(result.verdict, 'fail_for_fix_now');
    assert.equal(result.total_count, 1);
    assert.equal(result.blocking_count, 1);
    assert.deepEqual(result.blocking_ids, ['F-001']);
});
