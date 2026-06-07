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
    describe('buildTaskEventsSummary', () => {
        function createTaskEvents(tmpDir: string, taskId: string, events: Array<Record<string, unknown>>) {
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            const filePath = path.join(eventsDir, `${taskId}.jsonl`);
            const lines = events.map(e => JSON.stringify(e));
            fs.writeFileSync(filePath, lines.join('\n') + '\n', 'utf8');
            return eventsDir;
        }

        it('builds a bounded compact latest-cycle contract without full timeline details', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T09:00:00Z',
                    task_id: 'T-007',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Earlier cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T09:01:00Z',
                    task_id: 'T-007',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Earlier compile failed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'old-compile.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-007',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.',
                    details: {
                        artifact_path: path.join(tmpDir, 'task-mode.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-007',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Compile gate passed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'compile.json'),
                        raw_char_count: 200,
                        filtered_char_count: 100,
                        estimated_saved_chars: 100,
                        raw_token_count_estimate: 50,
                        filtered_token_count_estimate: 25,
                        estimated_saved_tokens: 25,
                        verbose_payload: 'x'.repeat(1000)
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-007.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const fullSummary = buildTaskEventsSummary({ taskId: 'T-007', eventsRoot: eventsDir, repoRoot: tmpDir });
            const compactSummary = buildCompactLatestCycleTaskEventsSummary(fullSummary);

            assert.equal(compactSummary.schema_version, 2);
            assert.equal(compactSummary.mode, 'compact_latest_cycle');
            assert.equal(compactSummary.event_contract.schema_version, 2);
            assert.equal(compactSummary.event_contract.current_schema_event_count, 0);
            assert.equal(compactSummary.event_contract.legacy_schema_event_count, 4);
            assert.equal(compactSummary.latest_cycle.status, 'IN_PROGRESS');
            assert.equal(compactSummary.latest_cycle.health_state, 'healthy');
            assert.equal(compactSummary.latest_cycle.terminal_outcome, 'none');
            assert.equal(compactSummary.latest_cycle.cycle_event_count, 2);
            assert.equal(compactSummary.latest_cycle.start_index, 3);
            assert.equal(compactSummary.latest_cycle.blocking_reason, null);
            assert.deepEqual(
                compactSummary.latest_cycle.gate_outcomes.map((item) => item.gate),
                ['enter-task-mode', 'compile-gate']
            );
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/compile.json')));
            assert.equal(compactSummary.token_economy?.total_estimated_saved_chars, 100);
            assert.equal(JSON.stringify(compactSummary).includes('verbose_payload'), false);
            assert.equal('timeline' in compactSummary, false);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('tracks mixed legacy, current, and unknown schema event counts in the public contract summary', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-007A',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Legacy event without explicit schema.'
                },
                {
                    schema_version: 2,
                    event_source: 'task-events',
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-007A',
                    event_type: 'COMPILE_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Current public schema event.',
                    public_metadata: {
                        lifecycle_phase: 'validation',
                        status_signal: 'pass',
                        health_state: 'healthy',
                        terminal_outcome: 'none'
                    }
                },
                {
                    schema_version: 7,
                    event_source: 'task-events',
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-007A',
                    event_type: 'COMPLETION_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Unknown future schema event.',
                    public_metadata: {
                        lifecycle_phase: 'terminal',
                        status_signal: 'pass',
                        health_state: 'healthy',
                        terminal_outcome: 'done'
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-007A.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const fullSummary = buildTaskEventsSummary({ taskId: 'T-007A', eventsRoot: eventsDir, repoRoot: tmpDir });
            const compactSummary = buildCompactLatestCycleTaskEventsSummary(fullSummary);

            assert.equal(fullSummary.event_contract.schema_version, 2);
            assert.equal(fullSummary.event_contract.current_schema_event_count, 1);
            assert.equal(fullSummary.event_contract.legacy_schema_event_count, 1);
            assert.equal(fullSummary.event_contract.unknown_schema_version_count, 1);
            assert.equal(compactSummary.event_contract.current_schema_event_count, 1);
            assert.equal(compactSummary.event_contract.legacy_schema_event_count, 1);
            assert.equal(compactSummary.event_contract.unknown_schema_version_count, 1);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('reports the latest-cycle blocker from the latest gate outcome', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Compile gate failed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008',
                    event_type: 'REVIEW_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Review gate failed before compile was retried.'
                },
                {
                    timestamp_utc: '2024-01-15T10:03:00Z',
                    task_id: 'T-008',
                    event_type: 'COMPILE_GATE_FAILED',
                    outcome: 'FAIL',
                    actor: 'gate',
                    message: 'Compile gate failed again.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'failed');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'compile-gate');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.event_type, 'COMPILE_GATE_FAILED');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.message, 'Compile gate failed again.');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('preserves blocked health state when informational events appear after the blocking gate', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008A',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008A',
                    event_type: 'PROJECT_MEMORY_IMPACT_BLOCKED',
                    outcome: 'BLOCKED',
                    actor: 'gate',
                    message: 'Project memory blocked closeout.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008A',
                    event_type: 'NO_OP_RECORDED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Operator left an informational breadcrumb.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008A.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008A', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'blocked');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'project-memory-impact');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('preserves completion terminal outcome when later non-terminal events are appended', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008D',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008D',
                    event_type: 'COMPLETION_GATE_PASSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Completion gate passed.'
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008D',
                    event_type: 'NO_OP_RECORDED',
                    outcome: 'INFO',
                    actor: 'agent',
                    message: 'Final informational note.'
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008D.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008D', eventsRoot: eventsDir, repoRoot: tmpDir })
            );

            assert.equal(compactSummary.latest_cycle.status, 'PASS');
            assert.equal(compactSummary.latest_cycle.health_state, 'healthy');
            assert.equal(compactSummary.latest_cycle.terminal_outcome, 'done');

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('includes override-approved review gates in compact latest-cycle outcomes', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008B',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008B',
                    event_type: 'REVIEW_GATE_PASSED_WITH_OVERRIDE',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Review gate passed with override.',
                    details: {
                        artifact_path: path.join(tmpDir, 'review-gate.json')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008B.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008B', eventsRoot: eventsDir, repoRoot: tmpDir })
            );
            const reviewGate = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'required-reviews-check'
            );

            assert.ok(reviewGate);
            assert.equal(reviewGate.status, 'PASS');
            assert.equal(reviewGate.event_type, 'REVIEW_GATE_PASSED_WITH_OVERRIDE');
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/review-gate.json')));

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('maps actual doc-impact and project-memory lifecycle events to compact gate outcomes', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const eventsDir = path.join(tmpDir, 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            const events = [
                {
                    timestamp_utc: '2024-01-15T10:00:00Z',
                    task_id: 'T-008C',
                    event_type: 'TASK_MODE_ENTERED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Latest cycle started.'
                },
                {
                    timestamp_utc: '2024-01-15T10:01:00Z',
                    task_id: 'T-008C',
                    event_type: 'DOC_IMPACT_ASSESSED',
                    outcome: 'PASS',
                    actor: 'gate',
                    message: 'Doc impact assessed.',
                    details: {
                        artifact_path: path.join(tmpDir, 'doc-impact.json')
                    }
                },
                {
                    timestamp_utc: '2024-01-15T10:02:00Z',
                    task_id: 'T-008C',
                    event_type: 'PROJECT_MEMORY_IMPACT_BLOCKED',
                    outcome: 'BLOCKED',
                    actor: 'gate',
                    message: 'Project memory impact blocked completion.',
                    details: {
                        artifact_path: path.join(tmpDir, 'project-memory-impact.json')
                    }
                }
            ];
            fs.writeFileSync(
                path.join(eventsDir, 'T-008C.jsonl'),
                events.map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const compactSummary = buildCompactLatestCycleTaskEventsSummary(
                buildTaskEventsSummary({ taskId: 'T-008C', eventsRoot: eventsDir, repoRoot: tmpDir })
            );
            const docImpact = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'doc-impact-gate'
            );
            const projectMemory = compactSummary.latest_cycle.gate_outcomes.find(
                (item) => item.gate === 'project-memory-impact'
            );

            assert.ok(docImpact);
            assert.equal(docImpact.status, 'PASS');
            assert.equal(docImpact.event_type, 'DOC_IMPACT_ASSESSED');
            assert.ok(projectMemory);
            assert.equal(projectMemory.status, 'FAIL');
            assert.equal(projectMemory.event_type, 'PROJECT_MEMORY_IMPACT_BLOCKED');
            assert.equal(compactSummary.latest_cycle.status, 'BLOCKED');
            assert.equal(compactSummary.latest_cycle.health_state, 'blocked');
            assert.equal(compactSummary.latest_cycle.blocking_reason?.gate, 'project-memory-impact');
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/doc-impact.json')));
            assert.ok(compactSummary.latest_cycle.evidence_references.some((item) => item.endsWith('/project-memory-impact.json')));

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });

        it('renders compact latest-cycle CLI output as JSON without changing legacy --as-json', () => {
            const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'task-summary-'));
            const repoRoot = path.join(tmpDir, 'repo');
            const eventsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(
                path.join(eventsDir, 'T-009.jsonl'),
                [
                    {
                        timestamp_utc: '2024-01-15T10:00:00Z',
                        task_id: 'T-009',
                        event_type: 'TASK_MODE_ENTERED',
                        outcome: 'PASS',
                        actor: 'gate',
                        message: 'Task mode entered.'
                    }
                ].map(e => JSON.stringify(e)).join('\n') + '\n',
                'utf8'
            );

            const legacy = JSON.parse(runTaskEventsSummaryCommand({
                taskId: 'T-009',
                repoRoot,
                asJson: true
            }).rendered);
            const compact = JSON.parse(runTaskEventsSummaryCommand({
                taskId: 'T-009',
                repoRoot,
                compactLatestCycle: true
            }).rendered);

            assert.ok(Array.isArray(legacy.timeline));
            assert.equal(compact.mode, 'compact_latest_cycle');
            assert.equal(compact.schema_version, 2);
            assert.equal('timeline' in compact, false);

            fs.rmSync(tmpDir, { recursive: true, force: true });
        });
    });

    describe('formatTaskEventsSummaryText', () => {
        it('formats summary as human-readable text', () => {
            const summary = {
                event_contract: {
                    schema_version: 2,
                    legacy_schema_versions: [1],
                    current_schema_event_count: 0,
                    legacy_schema_event_count: 1,
                    unknown_schema_version_count: 0
                },
                task_id: 'T-001',
                source_path: '/events/T-001.jsonl',
                events_count: 1,
                parse_errors: 0,
                integrity: {
                    status: 'PASS',
                    integrity_event_count: 1,
                    legacy_event_count: 0,
                    violations: []
                },
                command_policy_warnings: [],
                command_policy_warning_count: 0,
                token_economy: {
                    visible_summary_line: 'Suppressed output: ~132 chars (~66%) (compile gate output ~132 chars). Suppressed output estimate: ~33 tokens.'
                },
                first_event_utc: '2024-01-15T10:00:00.000Z',
                last_event_utc: '2024-01-15T10:00:00.000Z',
                timeline: [{
                    index: 1,
                    timestamp_utc: '2024-01-15T10:00:00.000Z',
                    schema_version: 1,
                    event_source: 'task-events',
                    event_type: 'PREFLIGHT_CLASSIFIED',
                    outcome: 'INFO',
                    actor: 'gate',
                    message: 'Done.',
                    lifecycle_phase: 'preflight',
                    health_state: 'neutral',
                    terminal_outcome: 'none',
                    normalized_from_legacy: true,
                    unknown_schema_version: false
                }]
            };
            const text = formatTaskEventsSummaryText(summary as unknown as TaskEventsSummaryResult);
            assert.ok(text.includes('Task: T-001'));
            assert.ok(text.includes('Events: 1'));
            assert.ok(text.includes('IntegrityStatus: PASS'));
            assert.ok(text.includes('Suppressed output: ~132 chars (~66%) (compile gate output ~132 chars). Suppressed output estimate: ~33 tokens.'));
            assert.ok(text.includes('PREFLIGHT_CLASSIFIED'));
            assert.ok(text.includes('Timeline:'));
        });
    });

    describe('getOutputTelemetryFromPayload', () => {
        it('extracts telemetry from nested output_telemetry payloads', () => {
            const result = getOutputTelemetryFromPayload({
                output_telemetry: {
                    raw_token_count_estimate: 20,
                    filtered_token_count_estimate: 10,
                    estimated_saved_tokens: 10
                }
            });

            assert.equal(result!.raw_token_count_estimate, 20);
            assert.equal(result!.output_token_count_estimate, 10);
            assert.equal(result!.estimated_saved_tokens, 10);
            assert.equal(result!.baseline_known, true);
        });
    });
});
