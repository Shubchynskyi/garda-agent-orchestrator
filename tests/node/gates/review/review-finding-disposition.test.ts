import assert from 'node:assert/strict';
import test from 'node:test';

import {
    evaluateReviewFindingsReportDispositions,
    evaluateReviewFindingsValidationArtifactDispositions,
    resolveLockedReviewFindingPolicyFromPreflight,
    type LockedReviewFindingPolicyResolution
} from '../../../../src/gates/review/review-finding-disposition';
import { buildReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import type { ReviewFinding, ReviewFindingsReport } from '../../../../src/gates/review/review-findings-schema';
import { buildLegacyReviewFollowUpTaskClosurePolicySnapshot } from '../../../../src/core/review-follow-up-task-closure-policy';

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
    base_policy: {
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
    follow_up_task_closure_policy: buildLegacyReviewFollowUpTaskClosurePolicySnapshot(),
    follow_up_task_closure_policy_source: 'legacy_default',
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

function validationArtifact(
    findings: ReviewFinding[],
    severity: 'critical' | 'high' | 'medium' | 'low' = 'high'
): ReviewFindingsValidationArtifact {
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
                    critical: severity === 'critical' ? findings.map((entry) => ({
                        id: entry.id,
                        severity,
                        title: entry.title,
                        description: entry.description,
                        evidence_locations: entry.evidence.map((evidence) => evidence.location),
                        coverage_obligation_ids: entry.coverage_obligation_ids
                    })) : [],
                    high: severity === 'high' ? findings.map((entry) => ({
                        id: entry.id,
                        severity,
                        title: entry.title,
                        description: entry.description,
                        evidence_locations: entry.evidence.map((evidence) => evidence.location),
                        coverage_obligation_ids: entry.coverage_obligation_ids
                    })) : [],
                    medium: severity === 'medium' ? findings.map((entry) => ({
                        id: entry.id,
                        severity,
                        title: entry.title,
                        description: entry.description,
                        evidence_locations: entry.evidence.map((evidence) => evidence.location),
                        coverage_obligation_ids: entry.coverage_obligation_ids
                    })) : [],
                    low: severity === 'low' ? findings.map((entry) => ({
                        id: entry.id,
                        severity,
                        title: entry.title,
                        description: entry.description,
                        evidence_locations: entry.evidence.map((evidence) => evidence.location),
                        coverage_obligation_ids: entry.coverage_obligation_ids
                    })) : []
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

function closurePolicyPreflight(
    skipLowFindings: boolean,
    forbidChildTasks: boolean,
    taskId = 'T-parent-F1',
    configured = true
) {
    return {
        task_id: taskId,
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'balanced',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'create_follow_up'
                },
                residual_risk: 'create_follow_up'
            },
            review_follow_up_task_closure_policy: {
                schema_version: 1,
                eligible: true,
                configured,
                valid: true,
                provenance: 'per_finding',
                source_notes_sha256: 'a'.repeat(64),
                skip_low_findings: skipLowFindings,
                forbid_child_tasks: forbidChildTasks,
                diagnostics: ['Frozen from explicit per_finding task metadata.']
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

test('evidence-only F-000 is excluded from disposition materialization items', () => {
    const artifact = buildReviewFindingsDispositionArtifact({
        taskId: 'T-evidence-only',
        reviewType: 'code',
        validationArtifact: validationArtifact([finding('F-000')]),
        validationArtifactPath: 'runtime/reviews/T-evidence-only-code-findings-validation.json',
        validationArtifactSha256: 'e'.repeat(64),
        policyResolution: STRICT_POLICY
    });

    assert.equal(artifact.disposition_result.verdict, 'pass_no_findings');
    assert.deepEqual(artifact.items, []);
    assert.equal(artifact.summary.item_count, 0);
    assert.equal(artifact.summary.follow_up_pending_count, 0);
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

test('high findings are forced to fix_now for legacy frozen policies', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight({
        task_id: 'T-legacy-fast',
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'soft',
                findings: {
                    critical: 'fix_now',
                    high: 'create_follow_up',
                    medium: 'ignore',
                    low: 'ignore'
                },
                residual_risk: 'ignore'
            }
        }
    });

    assert.equal(resolution.policy.findings.high, 'fix_now');
    assert.match(resolution.diagnostics.join(' '), /High-severity review findings are immutable fix_now obligations/u);
});

test('review findings follow-up tasks force every disposition to fix_now', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight({
        task_id: 'T-parent-F1',
        profile_policy_snapshot: {
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'soft',
                findings: {
                    critical: 'fix_now',
                    high: 'create_follow_up',
                    medium: 'create_follow_up',
                    low: 'ignore'
                },
                residual_risk: 'create_follow_up'
            }
        }
    });

    assert.deepEqual(resolution.policy.findings, {
        critical: 'fix_now',
        high: 'fix_now',
        medium: 'fix_now',
        low: 'fix_now'
    });
    assert.equal(resolution.policy.residual_risk, 'fix_now');
    assert.match(resolution.diagnostics.join(' '), /nested follow-up tasks are forbidden/u);
});

test('unconfigured follow-up closure metadata preserves the strict F-task safety floor', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight(
        closurePolicyPreflight(false, false, 'T-parent-F1', false)
    );

    assert.deepEqual(resolution.policy.findings, {
        critical: 'fix_now',
        high: 'fix_now',
        medium: 'fix_now',
        low: 'fix_now'
    });
    assert.equal(resolution.policy.residual_risk, 'fix_now');
    assert.match(resolution.diagnostics.join(' '), /strict F-task safety floor|nested follow-up tasks/u);
});

test('explicit follow-up closure policy applies all four independent flag combinations', () => {
    const none = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(false, false));
    assert.equal(none.policy.findings.medium, 'create_follow_up');
    assert.equal(none.policy.findings.low, 'create_follow_up');
    assert.equal(none.policy.residual_risk, 'create_follow_up');

    const skipOnly = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(true, false));
    assert.equal(skipOnly.policy.findings.medium, 'create_follow_up');
    assert.equal(skipOnly.policy.findings.low, 'ignore');
    assert.equal(skipOnly.policy.residual_risk, 'create_follow_up');

    const forbidOnly = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(false, true));
    assert.equal(forbidOnly.policy.findings.medium, 'fix_now');
    assert.equal(forbidOnly.policy.findings.low, 'fix_now');
    assert.equal(forbidOnly.policy.residual_risk, 'fix_now');

    const both = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(true, true));
    assert.equal(both.policy.findings.critical, 'fix_now');
    assert.equal(both.policy.findings.high, 'fix_now');
    assert.equal(both.policy.findings.medium, 'fix_now');
    assert.equal(both.policy.findings.low, 'ignore');
    assert.equal(both.policy.residual_risk, 'fix_now');
});

test('ordinary tasks ignore follow-up-only closure controls', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight(
        closurePolicyPreflight(true, true, 'T-parent')
    );

    assert.equal(resolution.policy.findings.medium, 'create_follow_up');
    assert.equal(resolution.policy.findings.low, 'create_follow_up');
    assert.equal(resolution.policy.residual_risk, 'create_follow_up');

    const artifact = buildReviewFindingsDispositionArtifact({
        taskId: 'T-parent',
        reviewType: 'code',
        validationArtifact: validationArtifact([finding('F-001')], 'low'),
        validationArtifactPath: 'runtime/reviews/T-parent-code-findings-validation.json',
        validationArtifactSha256: 'e'.repeat(64),
        policyResolution: resolution
    });
    assert.equal(artifact.items[0].action, 'create_follow_up');
    assert.equal(artifact.items[0].source_rule, 'review_finding_policy.findings.low');
});

test('skip low findings is retained as explicit disposition policy provenance', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(true, true));
    const artifact = buildReviewFindingsDispositionArtifact({
        taskId: 'T-parent-F1',
        reviewType: 'code',
        validationArtifact: validationArtifact([finding('F-001')], 'low'),
        validationArtifactPath: 'runtime/reviews/T-parent-F1-code-findings-validation.json',
        validationArtifactSha256: 'e'.repeat(64),
        policyResolution: resolution
    });

    assert.equal(artifact.items[0].action, 'ignore');
    assert.equal(
        artifact.items[0].source_rule,
        'review_follow_up_task_closure_policy.skip_low_findings'
    );
    assert.equal(artifact.summary.ignored_count, 1);
    assert.equal(artifact.summary.blocking_count, 0);
    assert.equal(artifact.policy.review_follow_up_task_closure_policy?.provenance, 'per_finding');
    assert.equal(
        artifact.disposition_result.review_follow_up_task_closure_policy?.source_notes_sha256,
        'a'.repeat(64)
    );
});

test('forbid child tasks retains would-be follow-up findings as current-task remediation', () => {
    const resolution = resolveLockedReviewFindingPolicyFromPreflight(closurePolicyPreflight(false, true));
    const artifact = buildReviewFindingsDispositionArtifact({
        taskId: 'T-parent-F1',
        reviewType: 'code',
        validationArtifact: validationArtifact([finding('F-001')], 'medium'),
        validationArtifactPath: 'runtime/reviews/T-parent-F1-code-findings-validation.json',
        validationArtifactSha256: 'e'.repeat(64),
        policyResolution: resolution
    });

    assert.equal(artifact.items[0].action, 'fix_now');
    assert.equal(
        artifact.items[0].source_rule,
        'review_follow_up_task_closure_policy.forbid_child_tasks'
    );
    assert.equal(artifact.items[0].materialization_status, 'requires_fix_now');
    assert.equal(artifact.disposition_result.verdict, 'fail_for_fix_now');
});
