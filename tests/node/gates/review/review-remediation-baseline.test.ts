import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { sha256RedactedJsonPayload } from '../../../../src/core/redaction';
import type { ReviewFindingsDispositionArtifact } from '../../../../src/gates/review/review-findings-disposition-artifact';
import type { ReviewFindingsValidationArtifact } from '../../../../src/gates/review/review-findings-validation-artifact';
import {
    buildReviewRemediationBaselineArtifact,
    validateReviewRemediationBaselineArtifact
} from '../../../../src/gates/review-remediation/review-remediation-baseline';

const temporaryRoots: string[] = [];
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');

function createTempRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-remediation-baseline-'));
    temporaryRoots.push(root);
    return root;
}

function writeJson(filePath: string, payload: unknown): string {
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function buildFixture(root: string) {
    const taskId = 'T-979-35-fixture';
    const reviewType = 'code';
    const reviewArtifactPath = path.join(root, `${taskId}-code.md`);
    const receiptPath = path.join(root, `${taskId}-code-receipt.json`);
    const validationArtifactPath = path.join(root, `${taskId}-code-findings-validation.json`);
    const dispositionArtifactPath = path.join(root, `${taskId}-code-findings-disposition.json`);
    const reviewArtifactSha256 = hash('review-artifact');
    const contextSha256 = hash('context');
    const treeSha256 = hash('tree');
    const scopeSha256 = hash('scope');
    const preflightSha256 = hash('preflight');
    const reviewScopeSha256 = hash('review-scope');
    const codeScopeSha256 = hash('code-scope');
    const validationResult = {
        status: 'accepted' as const,
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 2,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [{
                    id: 'F-001',
                    severity: 'high' as const,
                    title: 'Bound defect',
                    description: 'A concrete defect requires remediation.',
                    evidence_locations: ['src/example.ts:17'],
                    coverage_obligation_ids: ['FILE-001']
                }, {
                    id: 'F-002',
                    severity: 'high' as const,
                    title: 'Second bound defect',
                    description: 'A second concrete defect requires remediation.',
                    evidence_locations: ['src/second.ts:23'],
                    coverage_obligation_ids: ['FILE-002']
                }],
                medium: [],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: ['src/example.ts:17'],
            finding_evidence_locations: ['src/example.ts:17'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 2
        },
        bindings: {
            input: { review_output_sha256: hash('output') },
            output: {
                review_artifact_path: reviewArtifactPath.replace(/\\/gu, '/'),
                review_artifact_sha256: reviewArtifactSha256
            },
            context: {
                review_context_path: path.join(root, 'context.json').replace(/\\/gu, '/'),
                review_context_sha256: contextSha256
            },
            scope: {
                preflight_path: path.join(root, 'preflight.json').replace(/\\/gu, '/'),
                preflight_sha256: preflightSha256,
                scope_sha256: scopeSha256,
                review_scope_sha256: reviewScopeSha256,
                code_scope_sha256: codeScopeSha256
            },
            tree: { review_tree_state_sha256: treeSha256 },
            coverage_contract_sha256: hash('coverage')
        }
    };
    const validationArtifact: ReviewFindingsValidationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: taskId,
        review_type: reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256RedactedJsonPayload(validationResult)
    };
    const validationArtifactSha256 = sha256RedactedJsonPayload(validationArtifact);
    const dispositionResult = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        policy_source: 'preflight_profile_policy_snapshot' as const,
        policy_diagnostics: [],
        findings: {
            critical: { action: 'fix_now' as const, ids: [], count: 0 },
            high: { action: 'fix_now' as const, ids: ['F-001', 'F-002'], count: 2 },
            medium: { action: 'create_follow_up' as const, ids: [], count: 0 },
            low: { action: 'create_follow_up' as const, ids: [], count: 0 }
        },
        residual_risks: { action: 'create_follow_up' as const, ids: [], count: 0 },
        counts_by_action: { fix_now: 2, create_follow_up: 0, ignore: 0 },
        blocking_count: 2,
        blocking_ids: ['F-001', 'F-002'],
        non_blocking_count: 0,
        total_count: 2,
        verdict: 'fail_for_fix_now' as const
    };
    const reviewFindingPolicy = {
        schema_version: 1 as const,
        policy_id: 'balanced' as const,
        findings: {
            critical: 'fix_now' as const,
            high: 'fix_now' as const,
            medium: 'create_follow_up' as const,
            low: 'create_follow_up' as const
        },
        residual_risk: 'create_follow_up' as const
    };
    const dispositionArtifact: ReviewFindingsDispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: taskId,
        review_type: reviewType,
        derivation_source: 'garda_locked_policy_evaluation',
        source_validation: {
            artifact_path: validationArtifactPath.replace(/\\/gu, '/'),
            artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            status: 'accepted',
            accepted: true
        },
        policy: {
            policy_id: 'balanced',
            policy_source: 'preflight_profile_policy_snapshot',
            policy_diagnostics: [],
            review_finding_policy: reviewFindingPolicy
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256RedactedJsonPayload(dispositionResult),
        items: [{
            id: 'F-001',
            kind: 'finding',
            severity: 'high',
            action: 'fix_now',
            source_rule: 'review_finding_policy.findings.high',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: true,
            materialization_status: 'requires_fix_now',
            audit_status: 'retained_in_disposition_artifact'
        }, {
            id: 'F-002',
            kind: 'finding',
            severity: 'high',
            action: 'fix_now',
            source_rule: 'review_finding_policy.findings.high',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: true,
            materialization_status: 'requires_fix_now',
            audit_status: 'retained_in_disposition_artifact'
        }],
        summary: {
            item_count: 2,
            fix_now_count: 2,
            follow_up_pending_count: 0,
            ignored_count: 0,
            blocking_count: 2,
            non_blocking_count: 0
        }
    };
    const dispositionArtifactSha256 = sha256RedactedJsonPayload(dispositionArtifact);
    const findingsReportSha256 = hash('findings-report');
    const receipt = {
        task_id: taskId,
        review_type: reviewType,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: contextSha256,
        review_tree_state_sha256: treeSha256,
        review_findings_report_sha256: findingsReportSha256
    };
    const receiptSha256 = sha256RedactedJsonPayload(receipt);
    const profilePolicySnapshotSha256 = hash('profile-policy-snapshot');
    const baseline = buildReviewRemediationBaselineArtifact({
        taskId,
        reviewType,
        reviewArtifactPath,
        reviewArtifactSha256,
        receiptPath,
        receiptSha256,
        receipt,
        validationArtifactPath,
        validationArtifactSha256,
        validationArtifact,
        dispositionArtifactPath,
        dispositionArtifactSha256,
        dispositionArtifact,
        profilePolicySnapshot: { snapshot_hash: profilePolicySnapshotSha256 }
    });
    fs.writeFileSync(reviewArtifactPath, 'review-artifact', 'utf8');
    assert.equal(writeJson(receiptPath, receipt), receiptSha256);
    assert.equal(writeJson(validationArtifactPath, validationArtifact), validationArtifactSha256);
    assert.equal(writeJson(dispositionArtifactPath, dispositionArtifact), dispositionArtifactSha256);
    fs.copyFileSync(receiptPath, baseline.bindings.receipt.snapshot_path);
    fs.copyFileSync(reviewArtifactPath, baseline.bindings.review_artifact.snapshot_path);
    fs.copyFileSync(validationArtifactPath, baseline.bindings.findings_validation.snapshot_path);
    fs.copyFileSync(dispositionArtifactPath, baseline.bindings.findings_disposition.snapshot_path);
    const baselinePath = path.join(root, `${taskId}-code-remediation-baseline.json`);
    const baselineSha256 = writeJson(baselinePath, baseline);
    return {
        baseline,
        baselinePath,
        baselineSha256,
        taskId,
        reviewType,
        receiptSha256,
        contextSha256,
        treeSha256,
        scopeSha256,
        profilePolicySnapshotSha256
    };
}

afterEach(() => {
    for (const root of temporaryRoots.splice(0)) {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

describe('review remediation baseline', () => {
    it('builds and accepts one immutable receipt-bound fix_now baseline', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedArtifactSha256: fixture.baselineSha256,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: fixture.receiptSha256,
            expectedReviewContextSha256: fixture.contextSha256,
            expectedReviewTreeStateSha256: fixture.treeSha256,
            expectedScopeSha256: fixture.scopeSha256,
            expectedProfilePolicySnapshotSha256: fixture.profilePolicySnapshotSha256
        });

        assert.equal(result.valid, true, result.violations.join('\n'));
        assert.deepEqual(result.artifact?.path_line_inventory, [
            { path: 'src/example.ts', line: 17, item_ids: ['F-001'] },
            { path: 'src/second.ts', line: 23, item_ids: ['F-002'] }
        ]);
    });

    it('rejects stale or foreign expected bindings', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: 'T-foreign',
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: hash('stale-receipt'),
            expectedReviewContextSha256: hash('stale-context'),
            expectedReviewTreeStateSha256: hash('stale-tree'),
            expectedScopeSha256: hash('stale-scope'),
            expectedProfilePolicySnapshotSha256: hash('stale-policy')
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes('task_id mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('receipt_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('review_context_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('review_tree_state_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('scope_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('profile_policy_snapshot_sha256 mismatch')));
    });

    it('rejects incomplete or internally inconsistent baseline data', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline) as unknown as Record<string, unknown>;
        const bindings = tampered.bindings as Record<string, unknown>;
        const receiptBinding = bindings.receipt as Record<string, unknown>;
        delete receiptBinding.snapshot_sha256;
        const fixNowItems = tampered.fix_now_items as Array<Record<string, unknown>>;
        fixNowItems[0].evidence_locations = ['src/other.ts:22'];
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes('bindings.receipt is incomplete')));
        assert.ok(result.violations.some((violation) => violation.includes('fix_now_items_sha256 mismatch')));
        assert.ok(result.violations.some((violation) => violation.includes('path_line_inventory does not match')));
    });

    it('rejects a hash-recomputed fix_now item that contradicts its accepted finding', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.fix_now_items[0].kind = 'residual_risk';
        tampered.fix_now_items[0].severity = 'residual_risk';
        tampered.fix_now_items[0].source_rule = 'review_finding_policy.residual_risk';
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' kind")));
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' severity")));
        assert.ok(result.violations.some((violation) => violation.includes("fix_now item 'F-001' source_rule")));
    });

    it('rejects replaced or deleted bound evidence snapshots', () => {
        const fixture = buildFixture(createTempRoot());
        const validationSnapshotPath = fixture.baseline.bindings.findings_validation.snapshot_path;
        const receiptSnapshotPath = fixture.baseline.bindings.receipt.snapshot_path;
        fs.writeFileSync(validationSnapshotPath, '{"tampered":true}\n', 'utf8');
        fs.rmSync(receiptSnapshotPath);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('bindings.findings_validation snapshot hash mismatch')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes('bindings.receipt snapshot') && violation.includes('is missing')
        ));
    });

    it('rejects omission of an authenticated fix_now disposition item', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.fix_now_items = tampered.fix_now_items.filter((item) => item.id !== 'F-002');
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        tampered.path_line_inventory = tampered.path_line_inventory.filter((entry) =>
            !entry.item_ids.includes('F-002')
        );
        tampered.path_line_inventory_sha256 = sha256RedactedJsonPayload(tampered.path_line_inventory);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('does not match authenticated disposition count')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes("missing authenticated disposition item 'F-002'")
        ));
    });

    it('rejects malformed supplied expected hashes instead of disabling the binding', () => {
        const fixture = buildFixture(createTempRoot());
        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedArtifactSha256: 'not-a-sha256',
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType,
            expectedReceiptSha256: ''
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('remediation baseline artifact hash expected value must be a SHA-256 hash')
        ));
        assert.ok(result.violations.some((violation) =>
            violation.includes('receipt_sha256 expected value must be a SHA-256 hash')
        ));
    });

    it('rejects a hash-recomputed accepted inventory that diverges from validation evidence', () => {
        const fixture = buildFixture(createTempRoot());
        const tampered = structuredClone(fixture.baseline);
        tampered.accepted_findings[0].title = 'Rewritten finding';
        tampered.accepted_findings[0].evidence_locations = ['src/tampered.ts:99'];
        tampered.accepted_findings[0].coverage_obligation_ids = ['FILE-TAMPERED'];
        tampered.fix_now_items[0].evidence_locations = ['src/tampered.ts:99'];
        tampered.accepted_inventory_sha256 = sha256RedactedJsonPayload({
            findings: tampered.accepted_findings,
            residualRisks: tampered.accepted_residual_risks
        });
        tampered.fix_now_items_sha256 = sha256RedactedJsonPayload(tampered.fix_now_items);
        tampered.path_line_inventory = [
            { path: 'src/second.ts', line: 23, item_ids: ['F-002'] },
            { path: 'src/tampered.ts', line: 99, item_ids: ['F-001'] }
        ];
        tampered.path_line_inventory_sha256 = sha256RedactedJsonPayload(tampered.path_line_inventory);
        writeJson(fixture.baselinePath, tampered);

        const result = validateReviewRemediationBaselineArtifact({
            artifactPath: fixture.baselinePath,
            expectedTaskId: fixture.taskId,
            expectedReviewType: fixture.reviewType
        });

        assert.equal(result.valid, false);
        assert.ok(result.violations.some((violation) =>
            violation.includes('does not match the authenticated findings-validation snapshot')
        ));
    });
});
