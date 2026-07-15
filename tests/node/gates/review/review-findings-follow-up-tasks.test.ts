import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    materializeReviewFindingsFollowUpTasks
} from '../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    parseCanonicalActiveTaskQueue
} from '../../../../src/core/task-md-table';

const TASK_ID = 'T-REVIEW-FOLLOWUP';
const REVIEW_TYPE = 'code';

const tempRoots: string[] = [];

function normalizeForArtifact(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeJson(filePath: string, value: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function seedTaskQueue(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/review-follow-up-tasks | Parent task | gpt-5.5 | 2026-07-13 | strict | Parent notes. |`,
        ''
    ].join('\n'), 'utf8');
}

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-followups-'));
    tempRoots.push(repoRoot);
    seedTaskQueue(repoRoot);
    return repoRoot;
}

interface SeededReviewArtifacts {
    reviewArtifactPath: string;
    validationArtifactPath: string;
    dispositionArtifactPath: string;
    receiptPath: string;
    validationArtifactSha256: string;
    validationResultSha256: string;
    dispositionArtifactSha256: string;
    dispositionResultSha256: string;
    receiptSha256: string;
}

function emptyFindingsBySeverity(): Record<'critical' | 'high' | 'medium' | 'low', Record<string, unknown>[]> {
    return {
        critical: [],
        high: [],
        medium: [],
        low: []
    };
}

function seedReviewArtifacts(repoRoot: string, options: {
    title?: string;
    description?: string;
    dispositionSourceValidationSha256?: string;
    validationStatus?: 'accepted' | 'rejected';
} = {}): SeededReviewArtifacts {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const reviewArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}.md`);
    const validationArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-findings-validation.json`);
    const dispositionArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-findings-disposition.json`);
    const receiptPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-receipt.json`);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(reviewArtifactPath, 'review output\n', 'utf8');

    const findingsBySeverity = emptyFindingsBySeverity();
    findingsBySeverity.medium.push({
        id: 'F-001',
        severity: 'medium',
        title: options.title || 'Persist follow-up evidence',
        description: options.description || 'The review found a deferred workflow issue that needs a backlog task.',
        evidence_locations: ['src/gates/review/example.ts:10', 'tests/node/gates/review/example.test.ts:20'],
        coverage_obligation_ids: ['C-001']
    });
    const validationResult = {
        status: options.validationStatus || 'accepted',
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 1,
            residual_risk_count: 0,
            findings_by_severity: findingsBySeverity,
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: ['src/gates/review/example.ts:10', 'tests/node/gates/review/example.test.ts:20'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 2
        },
        bindings: {
            input: {
                review_output_sha256: '1'.repeat(64)
            },
            output: {
                review_artifact_path: normalizeForArtifact(reviewArtifactPath),
                review_artifact_sha256: fileSha256(reviewArtifactPath)
            },
            context: {
                review_context_path: null,
                review_context_sha256: null
            },
            scope: {
                preflight_path: null,
                preflight_sha256: null,
                scope_sha256: null,
                review_scope_sha256: null,
                code_scope_sha256: null
            },
            tree: {
                review_tree_state_sha256: null
            },
            coverage_contract_sha256: null
        }
    };
    const validationArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_validation',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        validation_result: validationResult,
        validation_result_sha256: sha256JsonPayload(validationResult)
    };
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = fileSha256(validationArtifactPath);

    const dispositionResult = {
        findings: {
            critical: { action: 'fix_now', ids: [] },
            high: { action: 'fix_now', ids: [] },
            medium: { action: 'create_follow_up', ids: ['F-001'] },
            low: { action: 'ignore', ids: [] }
        },
        residual_risks: { action: 'ignore', ids: [] },
        counts_by_action: {
            fix_now: 0,
            create_follow_up: 1,
            ignore: 0
        },
        blocking_count: 0,
        verdict: 'follow_up_required'
    };
    const dispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        derivation_source: 'garda_locked_policy_evaluation',
        source_validation: {
            artifact_path: normalizeForArtifact(validationArtifactPath),
            artifact_sha256: options.dispositionSourceValidationSha256 || validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            status: 'accepted',
            accepted: true
        },
        policy: {
            policy_id: 'test_policy',
            policy_source: 'preflight_profile_policy_snapshot',
            policy_diagnostics: [],
            review_finding_policy: {
                schema_version: 1,
                policy_id: 'test_policy',
                findings: {
                    critical: 'fix_now',
                    high: 'fix_now',
                    medium: 'create_follow_up',
                    low: 'ignore'
                },
                residual_risk: 'ignore'
            }
        },
        disposition_result: dispositionResult,
        disposition_result_sha256: sha256JsonPayload(dispositionResult),
        items: [
            {
                id: 'F-001',
                kind: 'finding',
                severity: 'medium',
                action: 'create_follow_up',
                source_rule: 'review_finding_policy.findings.medium',
                policy_source: 'preflight_profile_policy_snapshot',
                blocking: false,
                materialization_status: 'pending_follow_up_materialization',
                audit_status: 'retained_in_disposition_artifact'
            }
        ],
        summary: {
            item_count: 1,
            fix_now_count: 0,
            follow_up_pending_count: 1,
            ignored_count: 0,
            blocking_count: 0,
            non_blocking_count: 1
        }
    };
    writeJson(dispositionArtifactPath, dispositionArtifact);
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);

    const receipt = {
        schema_version: 2,
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        review_findings_validation: {
            artifact_path: normalizeForArtifact(validationArtifactPath),
            artifact_sha256: validationArtifactSha256,
            snapshot_path: null,
            snapshot_sha256: null,
            status: 'accepted',
            accepted: true,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            violation_count: 0
        },
        review_findings_disposition_artifact: {
            artifact_path: normalizeForArtifact(dispositionArtifactPath),
            artifact_sha256: dispositionArtifactSha256,
            snapshot_path: null,
            snapshot_sha256: null,
            disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
            follow_up_pending_count: 1,
            blocking_count: 0
        },
        review_output_contract: {
            schema_version: 1,
            format: 'findings_json',
            validation_artifact_sha256: validationArtifactSha256,
            validation_result_sha256: validationArtifact.validation_result_sha256,
            disposition_artifact_sha256: dispositionArtifactSha256,
            disposition_result_sha256: dispositionArtifact.disposition_result_sha256,
            review_artifact_sha256: fileSha256(reviewArtifactPath)
        }
    };
    writeJson(receiptPath, receipt);

    return {
        reviewArtifactPath,
        validationArtifactPath,
        dispositionArtifactPath,
        receiptPath,
        validationArtifactSha256,
        validationResultSha256: validationArtifact.validation_result_sha256,
        dispositionArtifactSha256,
        dispositionResultSha256: dispositionArtifact.disposition_result_sha256,
        receiptSha256: fileSha256(receiptPath)
    };
}

function taskRows(repoRoot: string) {
    return parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')).rows;
}

function rowFor(repoRoot: string, taskId: string) {
    return taskRows(repoRoot).find((row) => row.taskId === taskId) || null;
}

describe('review findings follow-up task materialization', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('creates exactly one hash-bound F task and reruns without duplicates', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);

        const materialized = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.deepEqual(materialized.created_task_ids, [`${TASK_ID}-F1`]);
        const childRow = rowFor(repoRoot, `${TASK_ID}-F1`);
        assert.ok(childRow);
        assert.equal(childRow.status, 'TODO');
        assert.equal(rowFor(repoRoot, TASK_ID)?.status, 'IN_PROGRESS');
        assert.match(childRow.notes, /validation_sha256=/u);
        assert.match(childRow.notes, /validation_result_sha256=/u);
        assert.match(childRow.notes, /receipt_sha256=/u);
        assert.match(childRow.notes, /disposition_sha256=/u);
        assert.match(childRow.notes, /review_follow_up_fingerprint=[0-9a-f]{64}/u);
        assert.match(childRow.notes, /src\/gates\/review\/example\.ts:10/u);
        assert.match(childRow.notes, /Remediation:/u);
        assert.match(childRow.notes, new RegExp(artifacts.receiptSha256, 'u'));

        const artifact = readJson(materialized.artifact_path);
        assert.equal(artifact.status, 'MATERIALIZED');
        assert.equal((artifact.summary as Record<string, unknown>).created_task_count, 1);
        assert.equal((artifact.summary as Record<string, unknown>).reused_task_count, 0);
        assert.equal((artifact.source_validation as Record<string, unknown>).artifact_sha256, artifacts.validationArtifactSha256);
        assert.equal((artifact.source_receipt as Record<string, unknown>).receipt_sha256, artifacts.receiptSha256);

        const rerun = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(rerun.status, 'ALREADY_MATERIALIZED', rerun.output_lines.join('\n'));
        assert.deepEqual(rerun.created_task_ids, []);
        assert.deepEqual(rerun.reused_task_ids, [`${TASK_ID}-F1`]);
        assert.equal(taskRows(repoRoot).filter((row) => row.taskId.startsWith(`${TASK_ID}-F`)).length, 1);
    });

    it('preserves fix_now disposition items as blocked without creating follow-up tasks', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        const policy = disposition.policy as Record<string, unknown>;
        const reviewFindingPolicy = (policy.review_finding_policy as Record<string, unknown>);
        const policyFindings = reviewFindingPolicy.findings as Record<string, unknown>;
        policyFindings.medium = 'fix_now';
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'fix_now', ids: ['F-001'] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'ignore', ids: [] },
            counts_by_action: {
                fix_now: 1,
                create_follow_up: 0,
                ignore: 0
            },
            blocking_count: 1,
            verdict: 'fix_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        const dispositionItems = disposition.items as Array<Record<string, unknown>>;
        dispositionItems[0].action = 'fix_now';
        dispositionItems[0].blocking = true;
        dispositionItems[0].materialization_status = 'requires_fix_now';
        disposition.summary = {
            item_count: 1,
            fix_now_count: 1,
            follow_up_pending_count: 0,
            ignored_count: 0,
            blocking_count: 1,
            non_blocking_count: 0
        };
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);
        const receipt = readJson(artifacts.receiptPath);
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        receiptDisposition.disposition_result_sha256 = disposition.disposition_result_sha256;
        receiptDisposition.follow_up_pending_count = 0;
        receiptDisposition.blocking_count = 1;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        contract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED', result.output_lines.join('\n'));
        assert.deepEqual(result.created_task_ids, []);
        assert.deepEqual(result.reused_task_ids, []);
        assert.deepEqual(result.violations, []);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifact = readJson(result.artifact_path);
        const artifactItems = artifact.items as Array<Record<string, unknown>>;
        const summary = artifact.summary as Record<string, unknown>;
        assert.equal(artifact.status, 'BLOCKED');
        assert.equal(artifactItems[0].materialization_status, 'requires_fix_now');
        assert.equal(artifactItems[0].task_id, null);
        assert.equal(summary.follow_up_obligation_count, 0);
        assert.equal(summary.blocked_task_count, 1);
        assert.equal(summary.not_required_count, 0);
    });

    it('records ignore-only disposition items as not required without creating follow-up tasks', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        const policy = disposition.policy as Record<string, unknown>;
        const reviewFindingPolicy = policy.review_finding_policy as Record<string, unknown>;
        const policyFindings = reviewFindingPolicy.findings as Record<string, unknown>;
        policyFindings.medium = 'ignore';
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'ignore', ids: ['F-001'] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'ignore', ids: [] },
            counts_by_action: {
                fix_now: 0,
                create_follow_up: 0,
                ignore: 1
            },
            blocking_count: 0,
            verdict: 'no_action_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        const dispositionItems = disposition.items as Array<Record<string, unknown>>;
        dispositionItems[0].action = 'ignore';
        dispositionItems[0].blocking = false;
        dispositionItems[0].materialization_status = 'audited_ignored';
        disposition.summary = {
            item_count: 1,
            fix_now_count: 0,
            follow_up_pending_count: 0,
            ignored_count: 1,
            blocking_count: 0,
            non_blocking_count: 1
        };
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);
        const receipt = readJson(artifacts.receiptPath);
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        receiptDisposition.disposition_result_sha256 = disposition.disposition_result_sha256;
        receiptDisposition.follow_up_pending_count = 0;
        receiptDisposition.blocking_count = 0;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        contract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'NOT_REQUIRED', result.output_lines.join('\n'));
        assert.deepEqual(result.created_task_ids, []);
        assert.deepEqual(result.reused_task_ids, []);
        assert.deepEqual(result.violations, []);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifact = readJson(result.artifact_path);
        const artifactItems = artifact.items as Array<Record<string, unknown>>;
        const summary = artifact.summary as Record<string, unknown>;
        assert.equal(artifact.status, 'NOT_REQUIRED');
        assert.equal(artifactItems[0].materialization_status, 'not_required');
        assert.equal(artifactItems[0].task_id, null);
        assert.equal(summary.follow_up_obligation_count, 0);
        assert.equal(summary.blocked_task_count, 0);
        assert.equal(summary.not_required_count, 1);
    });

    it('creates a follow-up task for residual risk disposition items', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        validationResult.normalized_inventory = {
            finding_count: 0,
            residual_risk_count: 1,
            findings_by_severity: emptyFindingsBySeverity(),
            residual_risks: [{
                id: 'R-001',
                description: 'Residual deployment risk needs owner confirmation before closeout.',
                evidence_locations: ['src/gates/review/residual-risk.ts:12']
            }]
        };
        validationResult.evidence_diagnostics = {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: [],
            residual_risk_evidence_locations: ['src/gates/review/residual-risk.ts:12'],
            total_evidence_locations: 1
        };
        validation.validation_result_sha256 = sha256JsonPayload(validationResult);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        const policy = disposition.policy as Record<string, unknown>;
        const reviewFindingPolicy = policy.review_finding_policy as Record<string, unknown>;
        reviewFindingPolicy.residual_risk = 'create_follow_up';
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'create_follow_up', ids: [] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'create_follow_up', ids: ['R-001'] },
            counts_by_action: {
                fix_now: 0,
                create_follow_up: 1,
                ignore: 0
            },
            blocking_count: 0,
            verdict: 'follow_up_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        disposition.items = [{
            id: 'R-001',
            kind: 'residual_risk',
            severity: 'residual_risk',
            action: 'create_follow_up',
            source_rule: 'review_finding_policy.residual_risk',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: false,
            materialization_status: 'pending_follow_up_materialization',
            audit_status: 'retained_in_disposition_artifact'
        }];
        disposition.summary = {
            item_count: 1,
            fix_now_count: 0,
            follow_up_pending_count: 1,
            ignored_count: 0,
            blocking_count: 0,
            non_blocking_count: 1
        };
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        receiptDisposition.disposition_result_sha256 = disposition.disposition_result_sha256;
        receiptDisposition.follow_up_pending_count = 1;
        receiptDisposition.blocking_count = 0;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        contract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'MATERIALIZED', result.output_lines.join('\n'));
        assert.deepEqual(result.created_task_ids, [`${TASK_ID}-F1`]);
        const childRow = rowFor(repoRoot, `${TASK_ID}-F1`);
        assert.ok(childRow);
        assert.match(childRow.title, /\[code\] Follow up residual risk R-001/u);
        assert.match(childRow.notes, /src\/gates\/review\/residual-risk\.ts:12/u);
        const artifact = readJson(result.artifact_path);
        const artifactItems = artifact.items as Array<Record<string, unknown>>;
        assert.equal(artifact.status, 'MATERIALIZED');
        assert.equal(artifactItems[0].source_item_kind, 'residual_risk');
        assert.equal(artifactItems[0].severity, 'residual_risk');
        assert.equal(artifactItems[0].materialization_status, 'created');
        assert.equal(artifactItems[0].task_id, `${TASK_ID}-F1`);
    });

    it('blocks duplicate accepted validation residual risk inventory ids before materializing ambiguous follow-ups', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        validationResult.normalized_inventory = {
            finding_count: 0,
            residual_risk_count: 2,
            findings_by_severity: emptyFindingsBySeverity(),
            residual_risks: [
                {
                    id: 'R-001',
                    description: 'Residual deployment risk needs owner confirmation before closeout.',
                    evidence_locations: ['src/gates/review/residual-risk.ts:12']
                },
                {
                    id: 'R-001',
                    description: 'Ambiguous duplicate residual deployment risk must fail closed.',
                    evidence_locations: ['src/gates/review/residual-risk-duplicate.ts:18']
                }
            ]
        };
        validationResult.evidence_diagnostics = {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: [],
            residual_risk_evidence_locations: [
                'src/gates/review/residual-risk.ts:12',
                'src/gates/review/residual-risk-duplicate.ts:18'
            ],
            total_evidence_locations: 2
        };
        validation.validation_result_sha256 = sha256JsonPayload(validationResult);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        const policy = disposition.policy as Record<string, unknown>;
        const reviewFindingPolicy = policy.review_finding_policy as Record<string, unknown>;
        reviewFindingPolicy.residual_risk = 'create_follow_up';
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'create_follow_up', ids: [] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'create_follow_up', ids: ['R-001'] },
            counts_by_action: {
                fix_now: 0,
                create_follow_up: 1,
                ignore: 0
            },
            blocking_count: 0,
            verdict: 'follow_up_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        disposition.items = [{
            id: 'R-001',
            kind: 'residual_risk',
            severity: 'residual_risk',
            action: 'create_follow_up',
            source_rule: 'review_finding_policy.residual_risk',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: false,
            materialization_status: 'pending_follow_up_materialization',
            audit_status: 'retained_in_disposition_artifact'
        }];
        disposition.summary = {
            item_count: 1,
            fix_now_count: 0,
            follow_up_pending_count: 1,
            ignored_count: 0,
            blocking_count: 0,
            non_blocking_count: 1
        };
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        receiptDisposition.disposition_result_sha256 = disposition.disposition_result_sha256;
        receiptDisposition.follow_up_pending_count = 1;
        receiptDisposition.blocking_count = 0;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        contract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => violation.includes("duplicate residual risk inventory id 'R-001'")),
            result.violations.join('\n')
        );
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('does not reuse matching fingerprints from unrelated task rows', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const first = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        assert.equal(first.status, 'MATERIALIZED');
        const fingerprint = rowFor(repoRoot, `${TASK_ID}-F1`)?.notes.match(/review_follow_up_fingerprint=([0-9a-f]{64})/u)?.[1];
        assert.ok(fingerprint);

        seedTaskQueue(repoRoot);
        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskMd = fs.readFileSync(taskPath, 'utf8');
        fs.writeFileSync(taskPath, taskMd.replace(
            /\n$/u,
            `\n| T-UNRELATED | TODO | P1 | workflow/review-follow-up-tasks | Unrelated row | gpt-5.5 | 2026-07-13 | strict | review_follow_up_fingerprint=${fingerprint}. |\n`
        ), 'utf8');

        const rerun = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(rerun.status, 'MATERIALIZED', rerun.output_lines.join('\n'));
        assert.deepEqual(rerun.created_task_ids, [`${TASK_ID}-F1`]);
        assert.deepEqual(rerun.reused_task_ids, []);
        assert.ok(rowFor(repoRoot, 'T-UNRELATED'));
        assert.ok(rowFor(repoRoot, `${TASK_ID}-F1`));
    });

    it('allocates a new F task when the accepted finding changes without overwriting the previous follow-up', () => {
        const repoRoot = makeRepo();
        let artifacts = seedReviewArtifacts(repoRoot, {
            title: 'Persist original follow-up evidence'
        });
        const first = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        assert.equal(first.status, 'MATERIALIZED');
        const firstNotes = rowFor(repoRoot, `${TASK_ID}-F1`)?.notes || '';

        artifacts = seedReviewArtifacts(repoRoot, {
            title: 'Persist changed follow-up evidence',
            description: 'The accepted finding changed and needs a separate backlog task.'
        });
        const second = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(second.status, 'MATERIALIZED', second.output_lines.join('\n'));
        assert.deepEqual(second.created_task_ids, [`${TASK_ID}-F2`]);
        assert.ok(rowFor(repoRoot, `${TASK_ID}-F1`));
        assert.ok(rowFor(repoRoot, `${TASK_ID}-F2`));
        assert.equal(rowFor(repoRoot, `${TASK_ID}-F1`)?.notes, firstNotes);
        assert.notEqual(
            rowFor(repoRoot, `${TASK_ID}-F1`)?.notes.match(/review_follow_up_fingerprint=([0-9a-f]{64})/u)?.[1],
            rowFor(repoRoot, `${TASK_ID}-F2`)?.notes.match(/review_follow_up_fingerprint=([0-9a-f]{64})/u)?.[1]
        );
    });

    it('blocks stale hash bindings and does not mutate TASK.md', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot, {
            dispositionSourceValidationSha256: 'a'.repeat(64)
        });
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('sha256 mismatch')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifact = readJson(result.artifact_path);
        assert.equal(artifact.status, 'BLOCKED');
        assert.equal((artifact.violations as string[]).some((violation) => violation.includes('sha256 mismatch')), true);
    });

    it('blocks rejected validation status even when the accepted flag and hashes match', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot, {
            validationStatus: 'rejected'
        });
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('status must be accepted')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks malformed disposition item shape without throwing or mutating TASK.md', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        disposition.items = [null];
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('invalid shape')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks disposition items whose action conflicts with the hashed disposition result', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'fix_now', ids: ['F-001'] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'ignore', ids: [] },
            counts_by_action: {
                fix_now: 1,
                create_follow_up: 0,
                ignore: 0
            },
            blocking_count: 1,
            verdict: 'fix_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('does not match disposition_result action')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks disposition_result ids that are omitted from disposition items', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        disposition.items = [];
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => (
                violation.includes("disposition_result.findings.medium id 'F-001' is missing a matching disposition item")
            ))
        );
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks hash-consistent disposition items that omit required provenance fields', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const disposition = readJson(artifacts.dispositionArtifactPath);
        const items = disposition.items as Array<Record<string, unknown>>;
        delete items[0].source_rule;
        delete items[0].policy_source;
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('source_rule')));
        assert.ok(result.violations.some((violation) => violation.includes('policy_source')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks explicit artifact paths outside the reviews root before mutating TASK.md', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath,
            artifactPath: path.join(repoRoot, 'TASK.md')
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('ArtifactPath must stay inside reviews root')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks default follow-up artifact paths derived outside the reviews root', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const externalDispositionPath = path.join(repoRoot, 'tmp-artifacts', `${TASK_ID}-${REVIEW_TYPE}-findings-disposition.json`);
        fs.mkdirSync(path.dirname(externalDispositionPath), { recursive: true });
        fs.copyFileSync(artifacts.dispositionArtifactPath, externalDispositionPath);
        const externalFollowUpPath = path.join(repoRoot, 'tmp-artifacts', `${TASK_ID}-${REVIEW_TYPE}-findings-follow-ups.json`);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: externalDispositionPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('ArtifactPath must stay inside reviews root')));
        assert.equal(fs.existsSync(externalFollowUpPath), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('rolls back TASK.md when the final materialization artifact cannot be written', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const artifactDirectoryPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-${REVIEW_TYPE}-findings-follow-ups.json`
        );
        fs.mkdirSync(artifactDirectoryPath, { recursive: true });
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath,
            artifactPath: artifactDirectoryPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('artifact write failed')));
        assert.ok(result.violations.some((violation) => violation.includes('TASK.md changes were rolled back')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks malformed accepted validation inventory shape without throwing or mutating TASK.md', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        const inventory = validationResult.normalized_inventory as Record<string, unknown>;
        const findingsBySeverity = inventory.findings_by_severity as Record<string, unknown>;
        findingsBySeverity.medium = { malformed: true };
        validation.validation_result_sha256 = sha256JsonPayload(validation.validation_result);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        writeJson(artifacts.receiptPath, receipt);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('findings_by_severity.medium must be an array')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks disposition items that are absent from the accepted validation inventory', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        const inventory = validationResult.normalized_inventory as Record<string, unknown>;
        const findingsBySeverity = inventory.findings_by_severity as Record<string, unknown>;
        findingsBySeverity.medium = [];
        validation.validation_result_sha256 = sha256JsonPayload(validation.validation_result);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        writeJson(artifacts.receiptPath, receipt);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('is not present in the accepted validation inventory')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks duplicate accepted validation finding inventory ids before materializing ambiguous follow-ups', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        const inventory = validationResult.normalized_inventory as Record<string, unknown>;
        const findingsBySeverity = inventory.findings_by_severity as Record<string, unknown>;
        const mediumFindings = findingsBySeverity.medium as Array<Record<string, unknown>>;
        const lowFindings = findingsBySeverity.low as Array<Record<string, unknown>>;
        lowFindings.push({
            ...mediumFindings[0],
            severity: 'low',
            title: 'Ambiguous duplicate follow-up evidence',
            description: 'The same accepted finding id appears twice and must not be silently overwritten.'
        });
        inventory.finding_count = 2;
        validation.validation_result_sha256 = sha256JsonPayload(validation.validation_result);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        writeJson(artifacts.receiptPath, receipt);
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => violation.includes("duplicate finding inventory id 'F-001'")),
            result.violations.join('\n')
        );
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('uses the accepted validation inventory index for large follow-up sets without scanning ambiguity', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        const targetFindingId = 'F-240';
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        const inventory = validationResult.normalized_inventory as Record<string, unknown>;
        const findingsBySeverity = inventory.findings_by_severity as Record<string, unknown>;
        findingsBySeverity.medium = Array.from({ length: 250 }, (_, index) => ({
            id: `F-${String(index + 1).padStart(3, '0')}`,
            severity: 'medium',
            title: `Large inventory finding ${index + 1}`,
            description: `Large inventory entry ${index + 1} should remain addressable by id.`,
            evidence_locations: [`src/gates/review/large-inventory-${index + 1}.ts:10`],
            coverage_obligation_ids: [`C-${String(index + 1).padStart(3, '0')}`]
        }));
        inventory.finding_count = 250;
        validationResult.evidence_diagnostics = {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: ['src/gates/review/large-inventory-240.ts:10'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 250
        };
        validation.validation_result_sha256 = sha256JsonPayload(validation.validation_result);
        writeJson(artifacts.validationArtifactPath, validation);
        const validationArtifactSha256 = fileSha256(artifacts.validationArtifactPath);

        const disposition = readJson(artifacts.dispositionArtifactPath);
        const sourceValidation = disposition.source_validation as Record<string, unknown>;
        sourceValidation.artifact_sha256 = validationArtifactSha256;
        sourceValidation.validation_result_sha256 = validation.validation_result_sha256;
        disposition.disposition_result = {
            findings: {
                critical: { action: 'fix_now', ids: [] },
                high: { action: 'fix_now', ids: [] },
                medium: { action: 'create_follow_up', ids: [targetFindingId] },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'ignore', ids: [] },
            counts_by_action: {
                fix_now: 0,
                create_follow_up: 1,
                ignore: 0
            },
            blocking_count: 0,
            verdict: 'follow_up_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        const dispositionItems = disposition.items as Array<Record<string, unknown>>;
        dispositionItems[0].id = targetFindingId;
        writeJson(artifacts.dispositionArtifactPath, disposition);
        const dispositionArtifactSha256 = fileSha256(artifacts.dispositionArtifactPath);

        const receipt = readJson(artifacts.receiptPath);
        const receiptValidation = receipt.review_findings_validation as Record<string, unknown>;
        receiptValidation.artifact_sha256 = validationArtifactSha256;
        receiptValidation.validation_result_sha256 = validation.validation_result_sha256;
        const receiptDisposition = receipt.review_findings_disposition_artifact as Record<string, unknown>;
        receiptDisposition.artifact_sha256 = dispositionArtifactSha256;
        receiptDisposition.disposition_result_sha256 = disposition.disposition_result_sha256;
        const contract = receipt.review_output_contract as Record<string, unknown>;
        contract.validation_artifact_sha256 = validationArtifactSha256;
        contract.validation_result_sha256 = validation.validation_result_sha256;
        contract.disposition_artifact_sha256 = dispositionArtifactSha256;
        contract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'MATERIALIZED', result.output_lines.join('\n'));
        assert.deepEqual(result.created_task_ids, [`${TASK_ID}-F1`]);
        const childRow = rowFor(repoRoot, `${TASK_ID}-F1`);
        assert.ok(childRow);
        assert.match(childRow.title, /Large inventory finding 240/u);
        assert.match(childRow.notes, /src\/gates\/review\/large-inventory-240\.ts:10/u);
        assert.doesNotMatch(childRow.title, /Large inventory finding 1\b/u);
    });

    it('blocks missing receipts before writing follow-up task rows', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);
        fs.rmSync(artifacts.receiptPath, { force: true });
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('Review receipt')));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    const staleHash = 'f'.repeat(64);
    const receiptBindingTamperCases: Array<{
        name: string;
        expectedViolation: string;
        mutate: (receipt: Record<string, unknown>, artifacts: SeededReviewArtifacts) => void;
    }> = [
        {
            name: 'validation artifact path',
            expectedViolation: 'Review receipt review_findings_validation.artifact_path mismatch',
            mutate: (receipt, artifacts) => {
                const validationReference = receipt.review_findings_validation as Record<string, unknown>;
                validationReference.artifact_path = normalizeForArtifact(path.join(
                    path.dirname(artifacts.validationArtifactPath),
                    'stale-validation.json'
                ));
            }
        },
        {
            name: 'validation artifact hash',
            expectedViolation: 'Review receipt review_findings_validation.artifact_sha256 mismatch',
            mutate: (receipt) => {
                const validationReference = receipt.review_findings_validation as Record<string, unknown>;
                validationReference.artifact_sha256 = staleHash;
            }
        },
        {
            name: 'validation result hash',
            expectedViolation: 'Review receipt review_findings_validation.validation_result_sha256 mismatch',
            mutate: (receipt) => {
                const validationReference = receipt.review_findings_validation as Record<string, unknown>;
                validationReference.validation_result_sha256 = staleHash;
            }
        },
        {
            name: 'disposition artifact path',
            expectedViolation: 'Review receipt review_findings_disposition_artifact.artifact_path mismatch',
            mutate: (receipt, artifacts) => {
                const dispositionReference = receipt.review_findings_disposition_artifact as Record<string, unknown>;
                dispositionReference.artifact_path = normalizeForArtifact(path.join(
                    path.dirname(artifacts.dispositionArtifactPath),
                    'stale-disposition.json'
                ));
            }
        },
        {
            name: 'disposition artifact hash',
            expectedViolation: 'Review receipt review_findings_disposition_artifact.artifact_sha256 mismatch',
            mutate: (receipt) => {
                const dispositionReference = receipt.review_findings_disposition_artifact as Record<string, unknown>;
                dispositionReference.artifact_sha256 = staleHash;
            }
        },
        {
            name: 'disposition result hash',
            expectedViolation: 'Review receipt review_findings_disposition_artifact.disposition_result_sha256 mismatch',
            mutate: (receipt) => {
                const dispositionReference = receipt.review_findings_disposition_artifact as Record<string, unknown>;
                dispositionReference.disposition_result_sha256 = staleHash;
            }
        },
        {
            name: 'contract validation artifact hash',
            expectedViolation: 'Review receipt review_output_contract.validation_artifact_sha256 mismatch',
            mutate: (receipt) => {
                const contract = receipt.review_output_contract as Record<string, unknown>;
                contract.validation_artifact_sha256 = staleHash;
            }
        },
        {
            name: 'contract validation result hash',
            expectedViolation: 'Review receipt review_output_contract.validation_result_sha256 mismatch',
            mutate: (receipt) => {
                const contract = receipt.review_output_contract as Record<string, unknown>;
                contract.validation_result_sha256 = staleHash;
            }
        },
        {
            name: 'contract disposition artifact hash',
            expectedViolation: 'Review receipt review_output_contract.disposition_artifact_sha256 mismatch',
            mutate: (receipt) => {
                const contract = receipt.review_output_contract as Record<string, unknown>;
                contract.disposition_artifact_sha256 = staleHash;
            }
        },
        {
            name: 'contract disposition result hash',
            expectedViolation: 'Review receipt review_output_contract.disposition_result_sha256 mismatch',
            mutate: (receipt) => {
                const contract = receipt.review_output_contract as Record<string, unknown>;
                contract.disposition_result_sha256 = staleHash;
            }
        }
    ];

    for (const tamperCase of receiptBindingTamperCases) {
        it(`blocks stale receipt binding for ${tamperCase.name} before writing follow-up task rows`, () => {
            const repoRoot = makeRepo();
            const artifacts = seedReviewArtifacts(repoRoot);
            const receipt = readJson(artifacts.receiptPath);
            tamperCase.mutate(receipt, artifacts);
            writeJson(artifacts.receiptPath, receipt);
            const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

            const result = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId: TASK_ID,
                reviewType: REVIEW_TYPE,
                dispositionArtifactPath: artifacts.dispositionArtifactPath
            });

            assert.equal(result.status, 'BLOCKED');
            assert.ok(
                result.violations.some((violation) => violation.includes(tamperCase.expectedViolation)),
                result.violations.join('\n')
            );
            assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
            assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        });
    }

    it('blocks traversal in default artifact path inputs before writing outside the repo', () => {
        const repoRoot = makeRepo();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-followups-outside-'));
        tempRoots.push(outsideRoot);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const outsideBasePath = path.join(outsideRoot, 'pwn');
        const traversalTaskId = path.relative(reviewsRoot, outsideBasePath);
        const oldTraversalArtifactPath = path.resolve(
            reviewsRoot,
            `${traversalTaskId}-${REVIEW_TYPE}-findings-follow-ups.json`
        );
        const originalTaskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: traversalTaskId,
            reviewType: REVIEW_TYPE
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(result.violations.some((violation) => violation.includes('must match semantic pattern')));
        assert.equal(fs.existsSync(oldTraversalArtifactPath), false);
        assert.equal(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), originalTaskMd);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifactRelativePath = path.relative(path.resolve(repoRoot), path.resolve(result.artifact_path));
        assert.ok(artifactRelativePath && !artifactRelativePath.startsWith('..') && !path.isAbsolute(artifactRelativePath));
    });
});
