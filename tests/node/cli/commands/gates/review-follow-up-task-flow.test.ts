import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    getAllShimmedGateNames
} from '../../../../../src/compat/shim-registry';
import {
    buildGateHelpText
} from '../../../../../src/cli/commands/gate-command-help';
import {
    handleGate
} from '../../../../../src/cli/commands/gate-command';
import {
    runMaterializeReviewFollowUpTasksCommand
} from '../../../../../src/cli/commands/gates';
import {
    parseCanonicalActiveTaskQueue
} from '../../../../../src/core/task-md-table';

const TASK_ID = 'T-CLI-FOLLOWUP';
const REVIEW_TYPE = 'code';

const tempRoots: string[] = [];

interface SeededReviewArtifacts {
    dispositionArtifactPath: string;
    receiptSha256: string;
}

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
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cli-followups-'));
    tempRoots.push(repoRoot);
    seedTaskQueue(repoRoot);
    return repoRoot;
}

function seedReviewArtifacts(repoRoot: string): SeededReviewArtifacts {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const reviewArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}.md`);
    const validationArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-findings-validation.json`);
    const dispositionArtifactPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-findings-disposition.json`);
    const receiptPath = path.join(reviewsRoot, `${TASK_ID}-${REVIEW_TYPE}-receipt.json`);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(reviewArtifactPath, 'review output\n', 'utf8');

    const validationResult = {
        status: 'accepted',
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: 1,
            residual_risk_count: 0,
            findings_by_severity: {
                critical: [],
                high: [],
                medium: [
                    {
                        id: 'F-001',
                        severity: 'medium',
                        title: 'Persist follow-up evidence',
                        description: 'The review found a deferred workflow issue that needs a backlog task.',
                        evidence_locations: ['src/gates/review/example.ts:10'],
                        coverage_obligation_ids: ['C-001']
                    }
                ],
                low: []
            },
            residual_risks: []
        },
        evidence_diagnostics: {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: ['src/gates/review/example.ts:10'],
            residual_risk_evidence_locations: [],
            total_evidence_locations: 1
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
            artifact_sha256: validationArtifactSha256,
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
        dispositionArtifactPath,
        receiptSha256: fileSha256(receiptPath)
    };
}

function activeRows(repoRoot: string) {
    return parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')).rows;
}

async function captureHandleGate(argv: string[]): Promise<{ output: string; exitCode: number }> {
    const chunks: string[] = [];
    const originalWrite = process.stdout.write;
    const previousExitCode = process.exitCode;
    process.exitCode = 0;
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
        chunks.push(String(chunk));
        return true;
    }) as typeof process.stdout.write;
    try {
        await handleGate(argv);
        return {
            output: chunks.join(''),
            exitCode: Number(process.exitCode ?? 0)
        };
    } finally {
        process.stdout.write = originalWrite;
        process.exitCode = previousExitCode;
    }
}

describe('materialize-review-follow-up-tasks CLI gate surface', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('exports help and shim registry entries for source and bundle command paths', () => {
        const sourceHelp = buildGateHelpText('materialize-review-follow-up-tasks', process.cwd());
        assert.match(sourceHelp, /node bin\/garda\.js gate materialize-review-follow-up-tasks/u);
        assert.match(sourceHelp, /--disposition-artifact-path/u);
        assert.ok(getAllShimmedGateNames().includes('materialize-review-follow-up-tasks'));

        const repoRoot = makeRepo();
        const bundleHelp = buildGateHelpText('materialize-review-follow-up-tasks', repoRoot);
        assert.match(bundleHelp, /node garda-agent-orchestrator\/bin\/garda\.js gate materialize-review-follow-up-tasks/u);
        assert.match(bundleHelp, /garda-agent-orchestrator\/runtime\/reviews\/<task-id>-<review-type>-findings-follow-ups\.json/u);
    });

    it('routes materialization through the exported command flow without reviewer TASK.md writes', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot);

        const result = runMaterializeReviewFollowUpTasksCommand({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.ok(result.outputLines.includes('REVIEW_FINDINGS_FOLLOW_UP_TASKS_MATERIALIZED'));
        const childRow = activeRows(repoRoot).find((row) => row.taskId === `${TASK_ID}-F1`);
        assert.ok(childRow);
        assert.match(childRow.notes, new RegExp(artifacts.receiptSha256, 'u'));
    });

    it('dispatches the gate name and propagates blocked materialization as a non-zero exit code', async () => {
        const repoRoot = makeRepo();
        const missingDispositionPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-${REVIEW_TYPE}-findings-disposition.json`
        );

        const result = await captureHandleGate([
            'materialize-review-follow-up-tasks',
            '--task-id',
            TASK_ID,
            '--review-type',
            REVIEW_TYPE,
            '--disposition-artifact-path',
            missingDispositionPath,
            '--repo-root',
            repoRoot
        ]);

        assert.notEqual(result.exitCode, 0);
        assert.match(result.output, /REVIEW_FINDINGS_FOLLOW_UP_TASKS_BLOCKED/u);
        assert.equal(activeRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });
});
