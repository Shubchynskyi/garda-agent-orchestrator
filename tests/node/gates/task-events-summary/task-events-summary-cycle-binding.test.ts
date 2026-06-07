import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    parseTimestamp,
    formatTimestamp,
    auditCommandCompactness,
    auditGateCommand,
    getCommandAuditFromDetails,
    buildCompactLatestCycleTaskEventsSummary,
    buildTaskEventsSummary,
    formatTaskEventsSummaryText,
    getOutputTelemetryFromPayload,
    taskCycleScopeBindingsMatch,
    TaskEventsSummaryResult
} from '../../../../src/gates/task-events-summary';
import { runTaskEventsSummaryCommand } from '../../../../src/cli/commands/gate-flows/task/task-summary-flow';

describe('gates/task-events-summary', () => {
    describe('taskCycleScopeBindingsMatch', () => {
        it('rejects same-scope evidence that is not bound to a prior compile timestamp', () => {
            const scopeBinding = {
                changed_files_sha256: '1'.repeat(64),
                scope_sha256: '2'.repeat(64),
                scope_content_sha256: '3'.repeat(64)
            };

            assert.equal(taskCycleScopeBindingsMatch({
                preflight_path: 'preflight.json',
                preflight_sha256: 'new-cycle',
                compile_gate_timestamp: '2024-01-15T10:00:00Z',
                scope_binding: scopeBinding
            }, {
                preflight_path: 'preflight.json',
                preflight_sha256: 'old-cycle',
                compile_gate_timestamp: null,
                scope_binding: scopeBinding
            }), false);
        });
    });

    describe('public task-events summary module boundary', () => {
        it('keeps noisy-command auditing and compact latest-cycle summaries available from the public barrel', () => {
            const noisyAudit = auditCommandCompactness('git status');
            assert.equal(noisyAudit.warning_count, 1);
            assert.deepEqual(noisyAudit.matched_categories, ['git']);

            const summary = {
                event_contract: {
                    schema_version: 2,
                    legacy_schema_versions: [1],
                    current_schema_event_count: 1,
                    legacy_schema_event_count: 0,
                    unknown_schema_version_count: 0
                },
                task_id: 'T-297',
                source_path: '/events/T-297.jsonl',
                events_count: 2,
                parse_errors: 0,
                integrity: {
                    status: 'PASS',
                    integrity_event_count: 2,
                    legacy_event_count: 0,
                    violations: []
                },
                command_policy_warnings: [],
                command_policy_warning_count: 0,
                first_event_utc: '2024-01-15T10:00:00.000Z',
                last_event_utc: '2024-01-15T10:01:00.000Z',
                token_economy: null,
                timeline: [
                    {
                        index: 1,
                        timestamp_utc: '2024-01-15T10:00:00.000Z',
                        schema_version: 2,
                        event_source: 'task-events',
                        event_type: 'TASK_MODE_ENTERED',
                        outcome: 'PASS',
                        actor: 'gate',
                        message: 'Task mode entered.',
                        lifecycle_phase: 'startup',
                        health_state: 'neutral',
                        terminal_outcome: 'none',
                        normalized_from_legacy: false,
                        unknown_schema_version: false,
                        details: null
                    },
                    {
                        index: 2,
                        timestamp_utc: '2024-01-15T10:01:00.000Z',
                        schema_version: 2,
                        event_source: 'task-events',
                        event_type: 'COMPILE_GATE_FAILED',
                        outcome: 'FAIL',
                        actor: 'gate',
                        message: 'Compile failed.',
                        lifecycle_phase: 'validation',
                        health_state: 'failed',
                        terminal_outcome: 'none',
                        normalized_from_legacy: false,
                        unknown_schema_version: false,
                        details: null
                    }
                ]
            } as unknown as TaskEventsSummaryResult;

            const compact = buildCompactLatestCycleTaskEventsSummary(summary);
            assert.equal(compact.latest_cycle.status, 'BLOCKED');
            assert.equal(compact.latest_cycle.blocking_reason?.gate, 'compile-gate');
            assert.equal(formatTaskEventsSummaryText(summary).includes('COMPILE_GATE_FAILED'), true);
        });
    });


    describe('buildTaskEventsSummary', () => {
        function createTaskEvents(tmpDir: string, taskId: string, events: Array<Record<string, unknown>>) {
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const filePath = path.join(eventsDir, `${taskId}.jsonl`);
            const lines = events.map(e => JSON.stringify(e));
            fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
            return eventsDir;
        }

        it('builds summary from task events', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-001',
                    event_type: 'PREFLIGHT_CLASSIFIED',
                    outcome: 'INFO',
                    actor: 'gate',
                    message: 'Preflight completed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-001',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.'
                }
            ];
            const eventsRoot = createTaskEvents(tmpDir, 'T-001', events);
            const summary = buildTaskEventsSummary({ taskId: 'T-001', eventsRoot });
            assert.equal(summary.task_id, 'T-001');
            assert.equal(summary.events_count, 2);
            assert.equal(summary.parse_errors, 0);
            assert.equal(summary.timeline.length, 2);
            assert.equal(summary.timeline[0].event_type, 'PREFLIGHT_CLASSIFIED');
            assert.equal(summary.timeline[1].event_type, 'COMPILE_GATE_PASSED');
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('surfaces validation-chain warnings through aggregated task summary details', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004',
                    event_type: 'SHELL_COMMAND_EXECUTED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Direct compiled test consumer launched outside guarded workflow.',
                    details: {
                        command_text: 'node.exe --test .node-build\\tests\\node\\materialization\\install.test.js',
                        command_mode: 'scan'
                    }
                }
            ];
            const eventsRoot = createTaskEvents(tmpDir, 'T-004', events);
            const summary = buildTaskEventsSummary({ taskId: 'T-004', eventsRoot });
            assert.equal(summary.command_policy_warning_count, 1);
            assert.ok(summary.command_policy_warnings.some((warning) => warning.includes('Direct `.node-build` test consumer')));
            assert.ok(summary.timeline[0].command_policy_audit);
            assert.deepEqual(summary.timeline[0].command_policy_audit?.matched_categories, ['validation_chain']);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('handles empty events file', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsRoot = createTaskEvents(tmpDir, 'T-002', []);
            // Remove the file and create an empty one
            const filePath = path.join(eventsRoot, 'T-002.jsonl');
            fs.writeFileSync(filePath, '\n', 'utf8');
            const summary = buildTaskEventsSummary({ taskId: 'T-002', eventsRoot });
            assert.equal(summary.events_count, 0);
            assert.equal(summary.timeline.length, 0);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('throws for missing events file', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            assert.throws(() => buildTaskEventsSummary({ taskId: 'T-999', eventsRoot: eventsDir }), /not found/);
            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('aggregates measurable token savings from command output and review context artifacts', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const reviewContextPath = path.join(reviewsDir, 'T-003-code-review-context.json');
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const reviewEvidencePath = path.join(reviewsDir, 'T-003-review-gate.json');
            fs.writeFileSync(reviewEvidencePath, JSON.stringify({
                output_telemetry: {
                    raw_char_count: 72,
                    filtered_char_count: 24,
                    estimated_saved_chars: 48,
                    raw_token_count_estimate: 18,
                    filtered_token_count_estimate: 6,
                    estimated_saved_tokens: 12
                },
                artifact_evidence: {
                    checked: [{
                        review: 'code',
                        review_context_path: reviewContextPath.replace(/\\/g, '/')
                    }]
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-003',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-003',
                    event_type: 'REVIEW_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed.',
                    details: {
                        review_evidence_path: reviewEvidencePath.replace(/\\/g, '/')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-003.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-003', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 660);
            assert.equal(summary.token_economy!.total_raw_char_count, 992);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 165);
            assert.equal(summary.token_economy!.total_raw_token_count_estimate, 248);
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output: ~660 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /code review context ~480 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~132 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /review gate output ~48 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output estimate: ~165 tokens/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('labels full-suite validation telemetry separately from generic gate output', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 420);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 105);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('excludes stale full-suite telemetry when the current cycle binding no longer matches', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: path.join(reviewsDir, 'T-004B-preflight.json'),
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-004B',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        cycle_binding: {
                            preflight_path: path.join(reviewsDir, 'T-004B-preflight.json'),
                            preflight_sha256: 'older-cycle',
                            compile_gate_timestamp: '2024-01-15T09:30:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004B', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 0);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 0);
            assert.equal(summary.token_economy!.breakdown.length, 0);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps older full-suite telemetry after a no-scope-change compile recovery', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004C-preflight.json');
            const changedFilesSha = '1'.repeat(64);
            const scopeSha = '2'.repeat(64);
            const scopeContentSha = '3'.repeat(64);
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004C-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'new-cycle',
                    preflight_changed_files_sha256: changedFilesSha,
                    preflight_scope_sha256: scopeSha,
                    preflight_scope_content_sha256: scopeContentSha
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T09:45:00Z',
                    task_id: 'T-004C',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed before a no-change closeout recovery compile.',
                    details: {
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'old-cycle',
                            compile_gate_timestamp: '2024-01-15T09:30:00Z',
                            scope_binding: {
                                changed_files_sha256: changedFilesSha,
                                scope_sha256: scopeSha,
                                scope_content_sha256: scopeContentSha
                            }
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile recovery with unchanged tracked scope.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'new-cycle',
                        preflight_changed_files_sha256: changedFilesSha,
                        preflight_scope_sha256: scopeSha,
                        preflight_scope_content_sha256: scopeContentSha
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004C', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 420);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 105);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps current-cycle compile and full-suite telemetry when the compile artifact is written after the compile event', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004B-runtime-order-preflight.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-runtime-order-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00.400Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-runtime-order',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'current-cycle',
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00.000Z',
                    task_id: 'T-004B-runtime-order',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed for the current cycle.',
                    details: {
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00.000Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-runtime-order.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-runtime-order',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 552);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 138);
            assert.equal(summary.token_economy!.breakdown.length, 2);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~132 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('counts current-cycle review-context telemetry directly from REVIEW_PHASE_STARTED output_path', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const preflightPath = path.join(reviewsDir, 'T-004B-review-phase-preflight.json');
            const reviewContextPath = path.join(reviewsDir, 'T-004B-review-phase-code-review-context.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-004B-review-phase-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00.400Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-review-phase',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        preflight_path: preflightPath,
                        preflight_hash_sha256: 'current-cycle'
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00.000Z',
                    task_id: 'T-004B-review-phase',
                    event_type: 'REVIEW_PHASE_STARTED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review phase started for the current cycle.',
                    details: {
                        review_type: 'code',
                        output_path: reviewContextPath
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-review-phase.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-review-phase',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 480);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 120);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /code review context ~480 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('uses the canonical review-type registry for fallback review-context discovery when no compile cycle exists', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const reviewContextPath = path.join(reviewsDir, 'T-004B-fallback-dependency-review-context.json');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'dependency',
                rule_context: {
                    summary: {
                        original_char_count: 300,
                        output_char_count: 180,
                        estimated_saved_chars: 120,
                        original_token_count_estimate: 75,
                        output_token_count_estimate: 45,
                        estimated_saved_tokens: 30
                    }
                }
            }, null, 2), 'utf8');

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    task_id: 'T-004B-fallback',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Task mode entered before any compile cycle.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004B-fallback.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-004B-fallback',
                eventsRoot: eventsDir,
                repoRoot: tmpDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 120);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 30);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /dependency review context ~120 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('excludes stale compile and review-context telemetry after a newer compile cycle starts', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const reviewContextPath = path.join(reviewsDir, 'T-004C-code-review-context.json');
            fs.writeFileSync(reviewContextPath, JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_char_count: 720,
                        output_char_count: 240,
                        estimated_saved_chars: 480,
                        original_token_count_estimate: 180,
                        output_token_count_estimate: 60,
                        estimated_saved_tokens: 120
                    }
                }
            }, null, 2), 'utf8');

            const reviewEvidencePath = path.join(reviewsDir, 'T-004C-review-gate.json');
            fs.writeFileSync(reviewEvidencePath, JSON.stringify({
                output_telemetry: {
                    raw_char_count: 72,
                    filtered_char_count: 24,
                    estimated_saved_chars: 48,
                    raw_token_count_estimate: 18,
                    filtered_token_count_estimate: 6,
                    estimated_saved_tokens: 12
                },
                artifact_evidence: {
                    checked: [{
                        review: 'code',
                        review_context_path: reviewContextPath.replace(/\\/g, '/')
                    }]
                }
            }, null, 2), 'utf8');

            fs.writeFileSync(
                path.join(reviewsDir, 'T-004C-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: path.join(reviewsDir, 'T-004C-preflight.json'),
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the earlier cycle.',
                    details: {
                        raw_char_count: 200,
                        filtered_char_count: 68,
                        estimated_saved_chars: 132,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-004C',
                    event_type: 'REVIEW_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed for the earlier cycle.',
                    details: {
                        review_evidence_path: reviewEvidencePath.replace(/\\/g, '/')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:06:00Z',
                    task_id: 'T-004C',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed for the current cycle.',
                    details: {
                        raw_char_count: 96,
                        filtered_char_count: 34,
                        estimated_saved_chars: 62,
                        raw_token_count_estimate: 24,
                        filtered_token_count_estimate: 8,
                        estimated_saved_tokens: 16
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-004C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-004C', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 62);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 16);
            assert.equal(summary.token_economy!.breakdown.length, 1);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output ~62 chars/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('keeps token-only legacy contributions visible inside char-first summaries', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-005',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-005',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 17,
                        estimated_saved_tokens: 33
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-005.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({ taskId: 'T-005', eventsRoot: eventsDir, repoRoot: tmpDir });
            assert.match(summary.token_economy!.visible_summary_line!, /Suppressed output \(char-aware subset\): ~420 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /full-suite validation output ~420 chars/);
            assert.match(summary.token_economy!.visible_summary_line!, /compile gate output suppressed output estimate ~33 tokens/);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('uses the provided reviewsRoot and keeps only the latest full-suite attempt per cycle', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            const reviewsDir = path.join(tmpDir, 'custom-reviews');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.mkdirSync(reviewsDir, { recursive: true });

            const firstArtifactPath = path.join(reviewsDir, 'T-006-full-suite-validation-first.json');
            const secondArtifactPath = path.join(reviewsDir, 'T-006-full-suite-validation-second.json');
            const preflightPath = path.join(reviewsDir, 'T-006-preflight.json');
            fs.writeFileSync(
                path.join(reviewsDir, 'T-006-compile-gate.json'),
                JSON.stringify({
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    preflight_path: preflightPath,
                    preflight_hash_sha256: 'current-cycle'
                }),
                'utf8'
            );

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:05:00Z',
                    task_id: 'T-006',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed.',
                    details: {
                        artifact_path: firstArtifactPath,
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 600,
                            filtered_char_count: 180,
                            estimated_saved_chars: 420,
                            raw_token_count_estimate: 150,
                            filtered_token_count_estimate: 45,
                            estimated_saved_tokens: 105
                        }
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:06:00Z',
                    task_id: 'T-006',
                    event_type: 'FULL_SUITE_VALIDATION_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Full suite passed again.',
                    details: {
                        artifact_path: secondArtifactPath,
                        cycle_binding: {
                            preflight_path: preflightPath,
                            preflight_sha256: 'current-cycle',
                            compile_gate_timestamp: '2024-01-15T10:00:00Z'
                        },
                        output_telemetry: {
                            raw_char_count: 1000,
                            filtered_char_count: 220,
                            estimated_saved_chars: 780,
                            raw_token_count_estimate: 250,
                            filtered_token_count_estimate: 55,
                            estimated_saved_tokens: 195
                        }
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-006.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const summary = buildTaskEventsSummary({
                taskId: 'T-006',
                eventsRoot: eventsDir,
                repoRoot: tmpDir,
                reviewsRoot: reviewsDir
            });
            assert.equal(summary.token_economy!.total_estimated_saved_chars, 780);
            assert.equal(summary.token_economy!.total_estimated_saved_tokens, 195);
            assert.equal(summary.token_economy!.breakdown.length, 1);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

    });
});
