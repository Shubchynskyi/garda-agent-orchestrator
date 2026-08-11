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
    followUpArtifactMatchesCurrentTaskQueue
} from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    parseCanonicalActiveTaskQueue
} from '../../../../src/core/task-md-table';
import {
    appendEvent,
    seedCompletedReviewerLaunchAndInvocation
} from '../next-step/next-step-full-suite-fixtures';

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

function seedTaskQueue(repoRoot: string, taskId = TASK_ID, profile = 'strict'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '## Active Queue',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${taskId} | IN_PROGRESS | P1 | workflow/review-follow-up-tasks | Parent task | gpt-5.5 | 2026-07-13 | ${profile} | Parent notes. |`,
        ''
    ].join('\n'), 'utf8');
}

function makeRepo(taskId = TASK_ID, profile = 'strict'): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-followups-'));
    tempRoots.push(repoRoot);
    seedTaskQueue(repoRoot, taskId, profile);
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
    includeFixNowFinding?: boolean;
    includeGroupedAttestation?: boolean;
    validationStatus?: 'accepted' | 'rejected';
    reviewType?: string;
    followUpSeverity?: 'critical' | 'high' | 'medium' | 'low';
    taskId?: string;
} = {}): SeededReviewArtifacts {
    const taskId = options.taskId || TASK_ID;
    const reviewType = options.reviewType || REVIEW_TYPE;
    const followUpSeverity = options.followUpSeverity || 'medium';
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const reviewArtifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const validationArtifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}-findings-validation.json`);
    const dispositionArtifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}-findings-disposition.json`);
    const receiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    const compileGatePath = path.join(reviewsRoot, `${taskId}-compile-gate.json`);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(reviewArtifactPath, 'review output\n', 'utf8');
    const preflightSha256 = fs.existsSync(preflightPath) ? fileSha256(preflightPath) : null;
    const compileGate = fs.existsSync(compileGatePath) ? readJson(compileGatePath) : null;
    const taskEventsPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    const compileTimelineTimestamp = fs.existsSync(taskEventsPath)
        ? fs.readFileSync(taskEventsPath, 'utf8')
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .filter((event) => event.event_type === 'COMPILE_GATE_PASSED')
            .at(-1)?.timestamp_utc
        : null;
    const compileGateTimestamp = String(compileTimelineTimestamp || compileGate?.timestamp_utc || '').trim() || null;
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    let reviewContextSha256: string | null = null;
    if (preflightSha256 && compileGateTimestamp) {
        const reviewTreeStateSha256 = sha256JsonPayload({ task_id: taskId, review_type: reviewType });
        writeJson(reviewContextPath, {
            task_id: taskId,
            review_type: reviewType,
            preflight_path: normalizeForArtifact(preflightPath),
            preflight_sha256: preflightSha256,
            tree_state: {
                tree_state_sha256: reviewTreeStateSha256
            },
            reviewer_routing: {
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: `agent:${reviewType}-reviewer`
            },
            full_suite_validation: {
                cycle_binding_valid: true,
                matches_current_preflight: true,
                matches_current_compile_gate: true,
                compile_gate_timestamp_utc: compileGateTimestamp,
                cycle_binding: {
                    preflight_sha256: preflightSha256,
                    compile_gate_timestamp: compileGateTimestamp
                }
            }
        });
        reviewContextSha256 = fileSha256(reviewContextPath);
    }

    const findingsBySeverity = emptyFindingsBySeverity();
    findingsBySeverity[followUpSeverity].push({
        id: 'F-001',
        severity: followUpSeverity,
        title: options.title || 'Persist follow-up evidence',
        description: options.description || 'The review found a deferred workflow issue that needs a backlog task.',
        evidence_locations: ['src/gates/review/example.ts:10', 'tests/node/gates/review/example.test.ts:20'],
        coverage_obligation_ids: ['C-001']
    });
    if (options.includeFixNowFinding) {
        findingsBySeverity.high.push({
            id: 'F-002',
            severity: 'high',
            title: 'Fix blocking evidence first',
            description: 'The review also found a blocking issue that must be fixed in the current task.',
            evidence_locations: ['src/gates/review/blocking-example.ts:30'],
            coverage_obligation_ids: ['C-002']
        });
    }
    const validationResult = {
        status: options.validationStatus || 'accepted',
        accepted: true,
        detected: true,
        violations: [],
        coverage_status: null,
        normalized_inventory: {
            finding_count: options.includeFixNowFinding ? 2 : 1,
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
                review_context_path: reviewContextSha256 ? normalizeForArtifact(reviewContextPath) : null,
                review_context_sha256: reviewContextSha256
            },
            scope: {
                preflight_path: preflightSha256 ? normalizeForArtifact(preflightPath) : null,
                preflight_sha256: preflightSha256,
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
        task_id: taskId,
        review_type: reviewType,
        validation_result: validationResult,
        validation_result_sha256: sha256JsonPayload(validationResult)
    };
    writeJson(validationArtifactPath, validationArtifact);
    const validationArtifactSha256 = fileSha256(validationArtifactPath);

    const dispositionResult = {
        findings: {
            critical: { action: followUpSeverity === 'critical' ? 'create_follow_up' : 'fix_now', ids: followUpSeverity === 'critical' ? ['F-001'] : [] },
            high: { action: followUpSeverity === 'high' ? 'create_follow_up' : 'fix_now', ids: [...(followUpSeverity === 'high' ? ['F-001'] : []), ...(options.includeFixNowFinding ? ['F-002'] : [])] },
            medium: { action: 'create_follow_up', ids: followUpSeverity === 'medium' ? ['F-001'] : [] },
            low: { action: followUpSeverity === 'low' ? 'create_follow_up' : 'ignore', ids: followUpSeverity === 'low' ? ['F-001'] : [] }
        },
        residual_risks: { action: 'ignore', ids: [] },
        counts_by_action: {
            fix_now: options.includeFixNowFinding ? 1 : 0,
            create_follow_up: 1,
            ignore: 0
        },
        blocking_count: options.includeFixNowFinding ? 1 : 0,
        verdict: options.includeFixNowFinding ? 'fix_required' : 'follow_up_required'
    };
    const dispositionArtifact = {
        schema_version: 1,
        artifact_type: 'review_findings_disposition',
        task_id: taskId,
        review_type: reviewType,
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
                    critical: followUpSeverity === 'critical' ? 'create_follow_up' : 'fix_now',
                    high: followUpSeverity === 'high' ? 'create_follow_up' : 'fix_now',
                    medium: 'create_follow_up',
                    low: followUpSeverity === 'low' ? 'create_follow_up' : 'ignore'
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
                severity: followUpSeverity,
                action: 'create_follow_up',
                source_rule: `review_finding_policy.findings.${followUpSeverity}`,
                policy_source: 'preflight_profile_policy_snapshot',
                blocking: false,
                materialization_status: 'pending_follow_up_materialization',
                audit_status: 'retained_in_disposition_artifact'
            },
            ...(options.includeFixNowFinding
                ? [{
                    id: 'F-002',
                    kind: 'finding',
                    severity: 'high',
                    action: 'fix_now',
                    source_rule: 'review_finding_policy.findings.high',
                    policy_source: 'preflight_profile_policy_snapshot',
                    blocking: true,
                    materialization_status: 'requires_fix_now',
                    audit_status: 'retained_in_disposition_artifact'
                }]
                : [])
        ],
        summary: {
            item_count: options.includeFixNowFinding ? 2 : 1,
            fix_now_count: options.includeFixNowFinding ? 1 : 0,
            follow_up_pending_count: 1,
            ignored_count: 0,
            blocking_count: options.includeFixNowFinding ? 1 : 0,
            non_blocking_count: 1
        }
    };
    writeJson(dispositionArtifactPath, dispositionArtifact);
    const dispositionArtifactSha256 = fileSha256(dispositionArtifactPath);

    const receipt = {
        schema_version: 2,
        task_id: taskId,
        review_type: reviewType,
        preflight_sha256: preflightSha256,
        review_context_sha256: reviewContextSha256,
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
            blocking_count: options.includeFixNowFinding ? 1 : 0
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

    const groupedPolicy = isGroupedFollowUpPolicy(preflightPath);
    if (groupedPolicy && reviewContextSha256 && options.includeGroupedAttestation !== false) {
        const reviewerIdentity = `agent:${reviewType}-reviewer`;
        seedCompletedReviewerLaunchAndInvocation(repoRoot, taskId, reviewType, reviewerIdentity);
        const taskEventsPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'task-events',
            `${taskId}.jsonl`
        );
        const invocationEvent = fs.readFileSync(taskEventsPath, 'utf8')
            .split(/\r?\n/u)
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
            .reverse()
            .find((event) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED');
        assert.ok(invocationEvent);
        const invocationIntegrity = invocationEvent.integrity as Record<string, unknown>;
        const invocationDetails = invocationEvent.details as Record<string, unknown>;
        const reviewContext = readJson(reviewContextPath);
        const treeState = reviewContext.tree_state as Record<string, unknown>;
        Object.assign(receipt, {
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_tree_state_sha256: treeState.tree_state_sha256,
            reviewer_provenance: {
                schema_version: 1,
                attestation_type: 'reviewer_invocation_attestation',
                controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
                task_sequence: invocationIntegrity.task_sequence,
                prev_event_sha256: invocationIntegrity.prev_event_sha256,
                event_sha256: invocationIntegrity.event_sha256,
                task_id: taskId,
                review_type: reviewType,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fileSha256(reviewContextPath),
                review_tree_state_sha256: treeState.tree_state_sha256,
                routing_event_sha256: invocationDetails.routing_event_sha256
            }
        });
        writeJson(receiptPath, receipt);
    }

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

function isGroupedFollowUpPolicy(preflightPath: string): boolean {
    if (!fs.existsSync(preflightPath)) {
        return false;
    }
    const preflight = readJson(preflightPath);
    const snapshot = preflight.profile_policy_snapshot as Record<string, unknown> | undefined;
    const policy = snapshot?.review_follow_up_policy as Record<string, unknown> | undefined;
    return policy?.materialization_mode === 'grouped_by_parent';
}

function taskRows(repoRoot: string) {
    return parseCanonicalActiveTaskQueue(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8')).rows;
}

function rowFor(repoRoot: string, taskId: string) {
    return taskRows(repoRoot).find((row) => row.taskId === taskId) || null;
}

function seedGroupedPreflight(
    repoRoot: string,
    compileTimestamp = '2026-07-17T12:30:00.000Z',
    artifactTimestamp = compileTimestamp
): void {
    seedGroupedPreflightForTask(repoRoot, TASK_ID, {
        parent_profile: 'strict',
        profile: 'balanced',
        source: 'one_level_lighter',
        configured_mode: 'one_level_lighter',
        diagnostics: ["Follow-up task profile lowered from 'strict' to 'balanced'."]
    }, compileTimestamp, artifactTimestamp);
}

function seedGroupedPreflightForTask(
    repoRoot: string,
    taskId: string,
    assignment: {
        parent_profile: string;
        profile: string;
        source: 'one_level_lighter' | 'inherit_parent' | 'fixed_profile' | 'safe_inherit_parent';
        configured_mode: 'one_level_lighter' | 'inherit_parent' | 'fixed_profile';
        diagnostics: string[];
    },
    compileTimestamp = '2026-07-17T12:30:00.000Z',
    artifactTimestamp = compileTimestamp
): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    writeJson(
        preflightPath,
        {
            task_id: taskId,
            profile_policy_snapshot: {
                schema_version: 1,
                lock_timestamp_utc: '2026-07-17T12:00:00.000Z',
                snapshot_hash: 'a'.repeat(64),
                review_follow_up_policy: {
                    schema_version: 1,
                    materialization_mode: 'grouped_by_parent',
                    task_profile: {
                        mode: assignment.configured_mode,
                        fixed_profile: assignment.configured_mode === 'fixed_profile' ? assignment.profile : null
                    }
                },
                review_follow_up_task_profile_assignment: {
                    ...assignment
                }
            }
        }
    );
    writeJson(path.join(reviewsRoot, `${taskId}-compile-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        timestamp_utc: artifactTimestamp,
        preflight_path: normalizeForArtifact(preflightPath),
        preflight_hash_sha256: fileSha256(preflightPath)
    });
    fs.mkdirSync(
        path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
        { recursive: true }
    );
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED', 'PASS', {}, compileTimestamp);
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
        assert.equal(childRow.priority, 'P2');
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

    it('groups deferred items into one snapshot-bound pending child and reruns idempotently', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
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
        assert.equal(childRow.profile, 'balanced');
        assert.match(childRow.notes, /review_follow_up_group_fingerprint=[0-9a-f]{64}/u);
        assert.match(childRow.notes, /review_follow_up_snapshot_sha256=a{64}/u);
        assert.match(childRow.notes, /review_follow_up_lane_binding=code:1:[0-9a-f]{64}:[0-9a-f]{64}\./u);
        assert.match(childRow.notes, /review_follow_up_task_profile=balanced/u);
        assert.match(childRow.notes, /review_follow_up_task_profile_source=one_level_lighter/u);
        assert.ok(childRow.notes.includes(
            `review_follow_up_lane_artifact=code:\`${normalizeForArtifact(path.relative(repoRoot, materialized.artifact_path))}\`.`
        ));

        const artifact = readJson(materialized.artifact_path);
        assert.equal((artifact.materialization_policy as Record<string, unknown>).mode, 'grouped_by_parent');
        assert.equal((artifact.materialization_policy as Record<string, unknown>).task_profile, 'balanced');
        assert.equal((artifact.materialization_policy as Record<string, unknown>).task_profile_source, 'one_level_lighter');
        assert.equal((artifact.summary as Record<string, unknown>).created_task_count, 1);

        const dispositionArtifact = readJson(artifacts.dispositionArtifactPath);
        const matchesCurrentQueue = () => followUpArtifactMatchesCurrentTaskQueue({
            artifact: readJson(materialized.artifact_path),
            dispositionArtifact,
            dispositionArtifactSha256: artifacts.dispositionArtifactSha256,
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            expectedFollowUpCount: 1,
            materializationMode: 'grouped_by_parent',
            followUpArtifactPath: materialized.artifact_path
        });
        assert.equal(matchesCurrentQueue(), true);

        const taskPath = path.join(repoRoot, 'TASK.md');
        const currentTaskText = fs.readFileSync(taskPath, 'utf8');
        fs.writeFileSync(
            taskPath,
            currentTaskText.replace(
                /review_follow_up_group_fingerprint=[0-9a-f]{64}/u,
                `review_follow_up_group_fingerprint=${'0'.repeat(64)}`
            ),
            'utf8'
        );
        assert.equal(matchesCurrentQueue(), false);
        fs.writeFileSync(taskPath, currentTaskText, 'utf8');

        const rerun = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        assert.equal(rerun.status, 'ALREADY_MATERIALIZED', rerun.output_lines.join('\n'));
        assert.deepEqual(rerun.reused_task_ids, [`${TASK_ID}-F1`]);
        assert.equal(taskRows(repoRoot).filter((row) => row.taskId.startsWith(`${TASK_ID}-F`)).length, 1);

        const testArtifacts = seedReviewArtifacts(repoRoot, {
            reviewType: 'test',
            title: 'Deferred high-severity test-lane risk',
            followUpSeverity: 'high'
        });
        const secondLane = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'test',
            dispositionArtifactPath: testArtifacts.dispositionArtifactPath
        });
        assert.equal(secondLane.status, 'ALREADY_MATERIALIZED', secondLane.output_lines.join('\n'));
        assert.deepEqual(secondLane.reused_task_ids, [`${TASK_ID}-F1`]);
        const updatedChild = rowFor(repoRoot, `${TASK_ID}-F1`);
        assert.ok(updatedChild);
        assert.equal(updatedChild.priority, 'P1');
        assert.match(updatedChild.notes, /review_follow_up_lane_binding=code:1:[0-9a-f]{64}:[0-9a-f]{64}\./u);
        assert.match(updatedChild.notes, /review_follow_up_lane_binding=test:1:[0-9a-f]{64}:[0-9a-f]{64}\./u);
        assert.equal((updatedChild.notes.match(/review_follow_up_lane_binding=/gu) || []).length, 2);
        assert.ok(updatedChild.notes.includes(
            `review_follow_up_lane_artifact=code:\`${normalizeForArtifact(path.relative(repoRoot, materialized.artifact_path))}\`.`
        ));
        assert.ok(updatedChild.notes.includes(
            `review_follow_up_lane_artifact=test:\`${normalizeForArtifact(path.relative(repoRoot, secondLane.artifact_path))}\`.`
        ));
        assert.equal((updatedChild.notes.match(/review_follow_up_lane_artifact=/gu) || []).length, 2);
        assert.equal(taskRows(repoRoot).filter((row) => row.taskId.startsWith(`${TASK_ID}-F`)).length, 1);

        seedGroupedPreflight(repoRoot, '2026-07-17T13:30:00.000Z');
        const staleCycle = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        assert.equal(staleCycle.status, 'BLOCKED');
        assert.ok(
            staleCycle.violations.some((violation) => violation.includes('compile gate timestamp mismatch')),
            staleCycle.violations.join('\n')
        );
        const nextCycleArtifacts = seedReviewArtifacts(repoRoot);
        const nextCycle = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: nextCycleArtifacts.dispositionArtifactPath
        });
        assert.equal(nextCycle.status, 'MATERIALIZED', nextCycle.output_lines.join('\n'));
        assert.deepEqual(nextCycle.created_task_ids, [`${TASK_ID}-F2`]);
        assert.equal(taskRows(repoRoot).filter((row) => row.taskId.startsWith(`${TASK_ID}-F`)).length, 2);
    });

    it('materializes inherited, fixed, safe fallback, and nested frozen child profiles', () => {
        const scenarios = [
            {
                taskId: 'T-FOLLOWUP-INHERIT',
                parentProfile: 'strict',
                expectedProfile: 'strict',
                source: 'inherit_parent' as const,
                configuredMode: 'inherit_parent' as const
            },
            {
                taskId: 'T-FOLLOWUP-FIXED',
                parentProfile: 'strict',
                expectedProfile: 'fast',
                source: 'fixed_profile' as const,
                configuredMode: 'fixed_profile' as const
            },
            {
                taskId: 'T-FOLLOWUP-CUSTOM',
                parentProfile: 'custom-review',
                expectedProfile: 'custom-review',
                source: 'safe_inherit_parent' as const,
                configuredMode: 'one_level_lighter' as const
            },
            {
                taskId: 'T-FOLLOWUP-NESTED-F1',
                parentProfile: 'balanced',
                expectedProfile: 'fast',
                source: 'one_level_lighter' as const,
                configuredMode: 'one_level_lighter' as const
            }
        ];

        for (const scenario of scenarios) {
            const repoRoot = makeRepo(scenario.taskId, scenario.parentProfile);
            seedGroupedPreflightForTask(repoRoot, scenario.taskId, {
                parent_profile: scenario.parentProfile,
                profile: scenario.expectedProfile,
                source: scenario.source,
                configured_mode: scenario.configuredMode,
                diagnostics: [`Resolved ${scenario.source}.`]
            });
            const artifacts = seedReviewArtifacts(repoRoot, { taskId: scenario.taskId });

            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId: scenario.taskId,
                reviewType: REVIEW_TYPE,
                dispositionArtifactPath: artifacts.dispositionArtifactPath
            });

            assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
            const childTaskId = `${scenario.taskId}-F1`;
            const childRow = rowFor(repoRoot, childTaskId);
            assert.ok(childRow);
            assert.equal(childRow.profile, scenario.expectedProfile);
            assert.match(childRow.notes, new RegExp(`review_follow_up_task_profile=${scenario.expectedProfile}`, 'u'));
            assert.match(childRow.notes, new RegExp(`review_follow_up_task_profile_source=${scenario.source}`, 'u'));
            const artifact = readJson(materialized.artifact_path);
            const materializationPolicy = artifact.materialization_policy as Record<string, unknown>;
            assert.equal(materializationPolicy.task_profile, scenario.expectedProfile);
            assert.equal(materializationPolicy.task_profile_source, scenario.source);
        }
    });

    it('recovers from a missing canonical lower profile with the frozen safe fallback', () => {
        const taskId = 'T-FOLLOWUP-SAFE-FALLBACK';
        const parentProfile = 'custom-review';
        const repoRoot = makeRepo(taskId, parentProfile);
        seedGroupedPreflightForTask(repoRoot, taskId, {
            parent_profile: parentProfile,
            profile: parentProfile,
            source: 'safe_inherit_parent',
            configured_mode: 'one_level_lighter',
            diagnostics: ['No canonical lower profile exists; safely inherited the parent profile.']
        });
        const artifacts = seedReviewArtifacts(repoRoot, { taskId });

        const materialized = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        const childRow = rowFor(repoRoot, `${taskId}-F1`);
        assert.ok(childRow);
        assert.equal(childRow.profile, parentProfile);
        assert.match(childRow.notes, /review_follow_up_task_profile_source=safe_inherit_parent/u);
    });

    it('keeps representative large grouped materialization bounded and deterministic', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
        const artifacts = seedReviewArtifacts(repoRoot);
        const itemCount = 200;
        const itemIds = Array.from({ length: itemCount }, (_, index) => `F-${String(index + 1).padStart(3, '0')}`);
        const validation = readJson(artifacts.validationArtifactPath);
        const validationResult = validation.validation_result as Record<string, unknown>;
        const inventory = validationResult.normalized_inventory as Record<string, unknown>;
        const findingsBySeverity = inventory.findings_by_severity as Record<string, unknown>;
        findingsBySeverity.medium = itemIds.map((id, index) => ({
            id,
            severity: 'medium',
            title: `Grouped deferred finding ${index + 1}`,
            description: `Grouped deferred finding ${index + 1} must retain its source metadata.`,
            evidence_locations: [`src/gates/review/grouped-evidence-${index + 1}.ts:10`],
            coverage_obligation_ids: [`C-${String(index + 1).padStart(3, '0')}`]
        }));
        inventory.finding_count = itemCount;
        validationResult.evidence_diagnostics = {
            validation_note_evidence_locations: [],
            coverage_evidence_locations: [],
            finding_evidence_locations: itemIds.map((_, index) => `src/gates/review/grouped-evidence-${index + 1}.ts:10`),
            residual_risk_evidence_locations: [],
            total_evidence_locations: itemCount
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
                medium: { action: 'create_follow_up', ids: itemIds },
                low: { action: 'ignore', ids: [] }
            },
            residual_risks: { action: 'ignore', ids: [] },
            counts_by_action: { fix_now: 0, create_follow_up: itemCount, ignore: 0 },
            blocking_count: 0,
            verdict: 'follow_up_required'
        };
        disposition.disposition_result_sha256 = sha256JsonPayload(disposition.disposition_result);
        disposition.items = itemIds.map((id) => ({
            id,
            kind: 'finding',
            severity: 'medium',
            action: 'create_follow_up',
            source_rule: 'review_finding_policy.findings.medium',
            policy_source: 'preflight_profile_policy_snapshot',
            blocking: false,
            materialization_status: 'pending_follow_up_materialization',
            audit_status: 'retained_in_disposition_artifact'
        }));
        disposition.summary = {
            item_count: itemCount,
            fix_now_count: 0,
            follow_up_pending_count: itemCount,
            ignored_count: 0,
            blocking_count: 0,
            non_blocking_count: itemCount
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
        receiptDisposition.follow_up_pending_count = itemCount;
        const receiptContract = receipt.review_output_contract as Record<string, unknown>;
        receiptContract.validation_artifact_sha256 = validationArtifactSha256;
        receiptContract.validation_result_sha256 = validation.validation_result_sha256;
        receiptContract.disposition_artifact_sha256 = dispositionArtifactSha256;
        receiptContract.disposition_result_sha256 = disposition.disposition_result_sha256;
        writeJson(artifacts.receiptPath, receipt);

        const startedAt = process.hrtime.bigint();
        const materialized = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1_000_000;

        assert.equal(materialized.status, 'MATERIALIZED', materialized.output_lines.join('\n'));
        assert.ok(elapsedMs < 10_000, `grouped materialization took ${elapsedMs.toFixed(1)}ms`);
        const childRow = rowFor(repoRoot, `${TASK_ID}-F1`);
        assert.ok(childRow);
        assert.ok(childRow.notes.length < 1000, childRow.notes);
        assert.match(childRow.notes, /review_follow_up_lane_binding=code:200:[0-9a-f]{64}:[0-9a-f]{64}\./u);
        assert.match(childRow.notes, /review_follow_up_lane_artifact=code:`[^`]+`\./u);
        assert.doesNotMatch(childRow.notes, /Grouped deferred finding 200/u);
        assert.doesNotMatch(childRow.notes, /grouped-evidence-200/u);

        const followUpArtifact = readJson(materialized.artifact_path);
        const materializedItems = followUpArtifact.items as Array<Record<string, unknown>>;
        assert.equal(materializedItems.length, itemCount);
        assert.equal(materializedItems[199].source_item_id, 'F-200');
        assert.deepEqual(materializedItems[199].evidence_locations, ['src/gates/review/grouped-evidence-200.ts:10']);
        assert.equal((followUpArtifact.source_validation as Record<string, unknown>).artifact_sha256, validationArtifactSha256);
        assert.equal((followUpArtifact.source_disposition as Record<string, unknown>).artifact_sha256, dispositionArtifactSha256);
        assert.equal((followUpArtifact.source_receipt as Record<string, unknown>).receipt_sha256, fileSha256(artifacts.receiptPath));

        const stableMaterializationItems = (items: unknown): string => JSON.stringify(
            (Array.isArray(items) ? items : []).map((item) => Object.fromEntries(
                Object.entries(item as Record<string, unknown>)
                    .filter(([key]) => key !== 'materialization_status')
            ))
        );
        const firstMaterializationItems = stableMaterializationItems(followUpArtifact.items);
        const rerunStartedAt = process.hrtime.bigint();
        const rerun = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });
        const rerunElapsedMs = Number(process.hrtime.bigint() - rerunStartedAt) / 1_000_000;
        assert.equal(rerun.status, 'ALREADY_MATERIALIZED', rerun.output_lines.join('\n'));
        assert.ok(rerunElapsedMs < 10_000, `grouped materialization rerun took ${rerunElapsedMs.toFixed(1)}ms`);
        assert.equal(stableMaterializationItems(readJson(materialized.artifact_path).items), firstMaterializationItems);
    });

    it('uses the canonical compile timeline timestamp when the artifact timestamp differs', () => {
        const repoRoot = makeRepo();
        const timelineTimestamp = '2026-07-17T12:30:00.000Z';
        seedGroupedPreflight(repoRoot, timelineTimestamp, '2026-07-17T12:30:00.999Z');
        const artifacts = seedReviewArtifacts(repoRoot);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'MATERIALIZED', result.violations.join('\n'));
        const artifact = readJson(result.artifact_path);
        assert.equal(
            (artifact.materialization_policy as Record<string, unknown>).compile_gate_timestamp,
            timelineTimestamp
        );
    });

    it('blocks explicit grouped mode when its current compile-cycle binding is missing', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
        const artifacts = seedReviewArtifacts(repoRoot);
        fs.rmSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${TASK_ID}-compile-gate.json`),
            { force: true }
        );

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => violation.includes('current materialization cycle is incomplete')),
            result.violations.join('\n')
        );
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifact = readJson(result.artifact_path);
        assert.equal((artifact.materialization_policy as Record<string, unknown>).mode, 'grouped_by_parent');
    });

    it('blocks grouped materialization until every current required review lane is complete', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const preflight = readJson(preflightPath);
        preflight.required_reviews = { code: true, test: true };
        writeJson(preflightPath, preflight);
        const compileGatePath = path.join(reviewsRoot, `${TASK_ID}-compile-gate.json`);
        const compileGate = readJson(compileGatePath);
        compileGate.preflight_hash_sha256 = fileSha256(preflightPath);
        writeJson(compileGatePath, compileGate);
        const artifacts = seedReviewArtifacts(repoRoot);

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => violation.includes("required review lane 'test' is not complete")),
            result.violations.join('\n')
        );
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks direct grouped materialization when ready review artifacts lack independent attestation', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const preflight = readJson(preflightPath);
        preflight.required_reviews = { code: true };
        writeJson(preflightPath, preflight);
        const compileGatePath = path.join(reviewsRoot, `${TASK_ID}-compile-gate.json`);
        const compileGate = readJson(compileGatePath);
        compileGate.preflight_hash_sha256 = fileSha256(preflightPath);
        writeJson(compileGatePath, compileGate);
        const artifacts = seedReviewArtifacts(repoRoot, { includeGroupedAttestation: false });

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => (
                violation.includes("required review lane 'code'")
                && violation.includes('independently attested evidence')
            )),
            result.violations.join('\n')
        );
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
    });

    it('blocks grouped materialization for a lane outside current required_reviews', () => {
        const repoRoot = makeRepo();
        seedGroupedPreflight(repoRoot);
        const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        const preflightPath = path.join(reviewsRoot, `${TASK_ID}-preflight.json`);
        const preflight = readJson(preflightPath);
        preflight.required_reviews = { code: true };
        writeJson(preflightPath, preflight);
        const compileGatePath = path.join(reviewsRoot, `${TASK_ID}-compile-gate.json`);
        const compileGate = readJson(compileGatePath);
        compileGate.preflight_hash_sha256 = fileSha256(preflightPath);
        writeJson(compileGatePath, compileGate);
        seedReviewArtifacts(repoRoot);
        const testArtifacts = seedReviewArtifacts(repoRoot, { reviewType: 'test' });

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: 'test',
            dispositionArtifactPath: testArtifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED');
        assert.ok(
            result.violations.some((violation) => violation.includes("lane 'test' is not configured in current required_reviews")),
            result.violations.join('\n')
        );
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
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

    it('blocks mixed fix_now and follow-up dispositions before mutating TASK.md', () => {
        const repoRoot = makeRepo();
        const artifacts = seedReviewArtifacts(repoRoot, { includeFixNowFinding: true });
        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskBefore = fs.readFileSync(taskPath, 'utf8');

        const result = materializeReviewFindingsFollowUpTasks({
            repoRoot,
            taskId: TASK_ID,
            reviewType: REVIEW_TYPE,
            dispositionArtifactPath: artifacts.dispositionArtifactPath
        });

        assert.equal(result.status, 'BLOCKED', result.output_lines.join('\n'));
        assert.deepEqual(result.created_task_ids, []);
        assert.deepEqual(result.reused_task_ids, []);
        assert.equal(fs.readFileSync(taskPath, 'utf8'), taskBefore);
        assert.equal(taskRows(repoRoot).some((row) => row.taskId === `${TASK_ID}-F1`), false);
        const artifact = readJson(result.artifact_path);
        const artifactItems = artifact.items as Array<Record<string, unknown>>;
        const followUpItem = artifactItems.find((item) => item.source_item_id === 'F-001');
        const fixNowItem = artifactItems.find((item) => item.source_item_id === 'F-002');
        assert.equal(followUpItem?.materialization_status, 'blocked');
        assert.equal(followUpItem?.task_id, null);
        assert.equal(fixNowItem?.materialization_status, 'requires_fix_now');
        assert.equal(fixNowItem?.task_id, null);
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
