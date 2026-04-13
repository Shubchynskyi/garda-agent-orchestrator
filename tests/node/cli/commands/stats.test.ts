import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildTaskStats,
    buildAggregateStats,
    formatTaskStatsText,
    formatTaskStatsJson,
    formatAggregateStatsText,
    formatAggregateStatsJson,
    type TaskStatsResult,
    type AggregateStatsResult
} from '../../../../src/cli/commands/stats';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-stats-test-'));
}

function scaffold(tmpDir: string): { eventsRoot: string; reviewsRoot: string } {
    const bundleRoot = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'runtime');
    const eventsRoot = path.join(bundleRoot, 'task-events');
    const reviewsRoot = path.join(bundleRoot, 'reviews');
    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    return { eventsRoot, reviewsRoot };
}

function writeEvent(eventsRoot: string, taskId: string, event: Record<string, unknown>): void {
    const filePath = path.join(eventsRoot, `${taskId}.jsonl`);
    fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// buildTaskStats — empty
// ---------------------------------------------------------------------------

test('buildTaskStats returns zeros for a task with no events', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        const stats = buildTaskStats('T-999', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.task_id, 'T-999');
        assert.equal(stats.events_count, 0);
        assert.equal(stats.first_event_utc, null);
        assert.equal(stats.last_event_utc, null);
        assert.equal(stats.wall_clock_seconds, null);
        assert.equal(stats.gate_pass_count, 0);
        assert.equal(stats.gate_fail_count, 0);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildTaskStats — with events
// ---------------------------------------------------------------------------

test('buildTaskStats computes wall clock and gate counts from events', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:00:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'RULE_PACK_LOADED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:01:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:02:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'PREFLIGHT_CLASSIFIED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:03:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'REVIEW_PHASE_STARTED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:04:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:05:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'COMPILE_GATE_FAILED',
            outcome: 'FAIL',
            timestamp_utc: '2026-04-05T10:06:00Z'
        });
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'COMPLETION_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:10:00Z'
        });

        const stats = buildTaskStats('T-100', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.events_count, 8);
        assert.equal(stats.wall_clock_seconds, 600); // 10 minutes
        assert.equal(stats.gate_pass_count, 4);
        assert.equal(stats.gate_fail_count, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildTaskStats — with preflight data
// ---------------------------------------------------------------------------

test('buildTaskStats reads path_mode and required_reviews from preflight', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-200', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T12:00:00Z'
        });

        fs.writeFileSync(
            path.join(reviewsRoot, 'T-200-preflight.json'),
            JSON.stringify({
                mode: 'FULL_PATH',
                required_reviews: { code: true, db: false, test: true },
                changed_files: ['src/a.ts', 'src/b.ts'],
                metrics: { changed_lines_total: 42 }
            }),
            'utf8'
        );

        const stats = buildTaskStats('T-200', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.path_mode, 'FULL_PATH');
        assert.deepEqual(stats.required_reviews, ['code', 'test']);
        assert.equal(stats.changed_files_count, 2);
        assert.equal(stats.changed_lines_total, 42);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildTaskStats — token economy from event details
// ---------------------------------------------------------------------------

test('buildTaskStats extracts token savings from event output_telemetry', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-300', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:00:00Z',
            details: {
                output_telemetry: {
                    raw_token_count_estimate: 500,
                    filtered_token_count_estimate: 100,
                    estimated_saved_tokens: 400
                }
            }
        });

        const stats = buildTaskStats('T-300', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 400);
        assert.equal(stats.token_economy.total_raw_token_count_estimate, 500);
        assert.equal(stats.token_economy.savings_percent, 80);
        assert.ok(stats.token_economy.visible_summary_line);
        assert.ok(stats.token_economy.visible_summary_line!.includes('~400'));
        assert.ok(stats.token_economy.visible_summary_line!.includes('~80%'));
        assert.equal(stats.token_economy.breakdown.length, 1);
        assert.equal(stats.token_economy.breakdown[0].label, 'compile gate output');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildAggregateStats
// ---------------------------------------------------------------------------

test('buildAggregateStats aggregates across multiple tasks', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);

        // Task 1
        writeEvent(eventsRoot, 'T-001', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:00:00Z'
        });
        writeEvent(eventsRoot, 'T-001', {
            event_type: 'RULE_PACK_LOADED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:01:00Z'
        });
        writeEvent(eventsRoot, 'T-001', {
            event_type: 'COMPLETION_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:05:00Z'
        });

        // Task 2
        writeEvent(eventsRoot, 'T-002', {
            event_type: 'REVIEW_PHASE_STARTED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-06T09:00:00Z'
        });
        writeEvent(eventsRoot, 'T-002', {
            event_type: 'PREFLIGHT_CLASSIFIED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-06T09:01:00Z'
        });
        writeEvent(eventsRoot, 'T-002', {
            event_type: 'COMPILE_GATE_FAILED',
            outcome: 'FAIL',
            timestamp_utc: '2026-04-06T09:02:00Z'
        });

        const agg = buildAggregateStats(tmpDir, eventsRoot, reviewsRoot);
        assert.equal(agg.tasks_analyzed, 2);
        assert.equal(agg.total_events, 6);
        assert.equal(agg.total_gate_pass, 3);
        assert.equal(agg.total_gate_fail, 1);
        assert.equal(agg.per_task.length, 2);
        assert.equal(agg.per_task[0].task_id, 'T-001');
        assert.equal(agg.per_task[1].task_id, 'T-002');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildAggregateStats returns empty results for no task files', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot } = scaffold(tmpDir);
        const agg = buildAggregateStats(tmpDir, eventsRoot);
        assert.equal(agg.tasks_analyzed, 0);
        assert.equal(agg.total_events, 0);
        assert.equal(agg.per_task.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// formatTaskStatsText
// ---------------------------------------------------------------------------

test('formatTaskStatsText produces readable output', () => {
    const stats: TaskStatsResult = {
        task_id: 'T-042',
        events_count: 12,
        first_event_utc: '2026-04-05T10:00:00.000Z',
        last_event_utc: '2026-04-05T10:10:00.000Z',
        wall_clock_seconds: 600,
        gate_pass_count: 8,
        gate_fail_count: 1,
        path_mode: 'FULL_PATH',
        required_reviews: ['code', 'test'],
        changed_files_count: 3,
        changed_lines_total: 120,
        requested_depth: 2,
        effective_depth: 2,
        depth_escalated: false,
        budget_forecast: null,
        budget_comparison: null,
        token_economy: {
            total_estimated_saved_tokens: 500,
            total_raw_token_count_estimate: 2000,
            savings_percent: 25,
            breakdown: [
                { label: 'compile gate output', estimated_saved_tokens: 300, raw_token_count_estimate: 1200 },
                { label: 'code review context', estimated_saved_tokens: 200, raw_token_count_estimate: 800 }
            ],
            visible_summary_line: 'Saved tokens: ~500 (~25%) (300 compile gate output + 200 code review context).'
        }
    };

    const text = formatTaskStatsText(stats);
    assert.ok(text.includes('Task: T-042'));
    assert.ok(text.includes('Events: 12'));
    assert.ok(text.includes('10m 0s'));
    assert.ok(text.includes('8 passed, 1 failed'));
    assert.ok(text.includes('FULL_PATH'));
    assert.ok(text.includes('code, test'));
    assert.ok(text.includes('Token Economy:'));
    assert.ok(text.includes('~500'));
});

// ---------------------------------------------------------------------------
// formatTaskStatsJson
// ---------------------------------------------------------------------------

test('formatTaskStatsJson produces valid JSON', () => {
    const stats: TaskStatsResult = {
        task_id: 'T-001',
        events_count: 2,
        first_event_utc: null,
        last_event_utc: null,
        wall_clock_seconds: null,
        gate_pass_count: 0,
        gate_fail_count: 0,
        path_mode: null,
        required_reviews: [],
        changed_files_count: 0,
        changed_lines_total: 0,
        requested_depth: null,
        effective_depth: null,
        depth_escalated: false,
        budget_forecast: null,
        budget_comparison: null,
        token_economy: {
            total_estimated_saved_tokens: 0,
            total_raw_token_count_estimate: 0,
            savings_percent: null,
            breakdown: [],
            visible_summary_line: null
        }
    };
    const json = formatTaskStatsJson(stats);
    const parsed = JSON.parse(json);
    assert.equal(parsed.task_id, 'T-001');
});

// ---------------------------------------------------------------------------
// formatAggregateStatsText
// ---------------------------------------------------------------------------

test('formatAggregateStatsText includes header and per-task lines', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 2,
        total_events: 10,
        total_wall_clock_seconds: 1200,
        total_gate_pass: 8,
        total_gate_fail: 1,
        total_estimated_saved_tokens: 1000,
        total_raw_token_count_estimate: 4000,
        aggregate_savings_percent: 25,
        per_task: [
            {
                task_id: 'T-001',
                events_count: 5,
                first_event_utc: null,
                last_event_utc: null,
                wall_clock_seconds: 600,
                gate_pass_count: 4,
                gate_fail_count: 0,
                path_mode: null,
                required_reviews: [],
                changed_files_count: 0,
                changed_lines_total: 0,
                requested_depth: null,
                effective_depth: null,
                depth_escalated: false,
                budget_forecast: null,
                budget_comparison: null,
                token_economy: {
                    total_estimated_saved_tokens: 500,
                    total_raw_token_count_estimate: 2000,
                    savings_percent: 25,
                    breakdown: [],
                    visible_summary_line: null
                }
            },
            {
                task_id: 'T-002',
                events_count: 5,
                first_event_utc: null,
                last_event_utc: null,
                wall_clock_seconds: 600,
                gate_pass_count: 4,
                gate_fail_count: 1,
                path_mode: null,
                required_reviews: [],
                changed_files_count: 0,
                changed_lines_total: 0,
                requested_depth: null,
                effective_depth: null,
                depth_escalated: false,
                budget_forecast: null,
                budget_comparison: null,
                token_economy: {
                    total_estimated_saved_tokens: 500,
                    total_raw_token_count_estimate: 2000,
                    savings_percent: 25,
                    breakdown: [],
                    visible_summary_line: null
                }
            }
        ]
    };

    const text = formatAggregateStatsText(agg);
    assert.ok(text.includes('GARDA_STATS'));
    assert.ok(text.includes('Tasks analyzed: 2'));
    assert.ok(text.includes('Total saved tokens: ~1000'));
    assert.ok(text.includes('T-001'));
    assert.ok(text.includes('T-002'));
});

// ---------------------------------------------------------------------------
// formatAggregateStatsJson
// ---------------------------------------------------------------------------

test('formatAggregateStatsJson produces valid JSON', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 0,
        total_events: 0,
        total_wall_clock_seconds: 0,
        total_gate_pass: 0,
        total_gate_fail: 0,
        total_estimated_saved_tokens: 0,
        total_raw_token_count_estimate: 0,
        aggregate_savings_percent: null,
        per_task: []
    };
    const json = formatAggregateStatsJson(agg);
    const parsed = JSON.parse(json);
    assert.equal(parsed.tasks_analyzed, 0);
});

// ---------------------------------------------------------------------------
// Token economy — review context from artifact
// ---------------------------------------------------------------------------

test('buildTaskStats picks up review-context savings from review artifacts', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-400', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T15:00:00Z'
        });

        // Write a review-context artifact with savings
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-400-code-review-context.json'),
            JSON.stringify({
                review_type: 'code',
                rule_context: {
                    summary: {
                        original_token_count_estimate: 1000,
                        output_token_count_estimate: 200,
                        estimated_saved_tokens: 800
                    }
                }
            }),
            'utf8'
        );

        const stats = buildTaskStats('T-400', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 800);
        assert.equal(stats.token_economy.breakdown.length, 1);
        assert.equal(stats.token_economy.breakdown[0].label, 'code review context');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Wall clock formatting edge cases
// ---------------------------------------------------------------------------

test('formatTaskStatsText handles null wall_clock_seconds', () => {
    const stats: TaskStatsResult = {
        task_id: 'T-500',
        events_count: 0,
        first_event_utc: null,
        last_event_utc: null,
        wall_clock_seconds: null,
        gate_pass_count: 0,
        gate_fail_count: 0,
        path_mode: null,
        required_reviews: [],
        changed_files_count: 0,
        changed_lines_total: 0,
        requested_depth: null,
        effective_depth: null,
        depth_escalated: false,
        budget_forecast: null,
        budget_comparison: null,
        token_economy: {
            total_estimated_saved_tokens: 0,
            total_raw_token_count_estimate: 0,
            savings_percent: null,
            breakdown: [],
            visible_summary_line: null
        }
    };
    const text = formatTaskStatsText(stats);
    assert.ok(text.includes('Duration: (unknown)'));
    assert.ok(text.includes('no savings recorded'));
});

test('formatTaskStatsText formats hours correctly', () => {
    const stats: TaskStatsResult = {
        task_id: 'T-600',
        events_count: 1,
        first_event_utc: null,
        last_event_utc: null,
        wall_clock_seconds: 3661, // 1h 1m 1s
        gate_pass_count: 0,
        gate_fail_count: 0,
        path_mode: null,
        required_reviews: [],
        changed_files_count: 0,
        changed_lines_total: 0,
        requested_depth: null,
        effective_depth: null,
        depth_escalated: false,
        budget_forecast: null,
        budget_comparison: null,
        token_economy: {
            total_estimated_saved_tokens: 0,
            total_raw_token_count_estimate: 0,
            savings_percent: null,
            breakdown: [],
            visible_summary_line: null
        }
    };
    const text = formatTaskStatsText(stats);
    assert.ok(text.includes('1h 1m 1s'));
});

// ---------------------------------------------------------------------------
// Budget forecast and depth escalation from preflight
// ---------------------------------------------------------------------------

test('buildTaskStats reads budget_forecast and depth_escalation from preflight', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-700', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-06T10:00:00Z'
        });

        // Write preflight with budget_forecast and depth_escalation
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-700-preflight.json'),
            JSON.stringify({
                mode: 'FULL_PATH',
                required_reviews: { code: true, db: false },
                changed_files: ['src/a.ts', 'src/b.ts'],
                metrics: { changed_lines_total: 80 },
                budget_forecast: {
                    requested_depth: 1,
                    effective_depth: 2,
                    depth_escalated: true,
                    total_forecast_tokens: 2000,
                    effective_forecast_tokens: 1400,
                    token_economy_active_for_depth: true,
                    forecast_savings_estimate: 600,
                    required_reviews: ['code'],
                    review_budget_estimates: [],
                    compile_gate_estimated_tokens: 380,
                    total_estimated_review_tokens: 1620,
                    token_economy_enabled: true
                },
                depth_escalation: {
                    requested_depth: 1,
                    effective_depth: 2,
                    escalated: true,
                    escalation_reason: 'full_path_minimum_depth_2',
                    escalation_triggers: ['full_path_minimum_depth_2']
                }
            }),
            'utf8'
        );

        const stats = buildTaskStats('T-700', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.requested_depth, 1);
        assert.equal(stats.effective_depth, 2);
        assert.equal(stats.depth_escalated, true);
        assert.ok(stats.budget_forecast != null);
        assert.equal(stats.budget_forecast!.total_forecast_tokens, 2000);
        assert.ok(stats.budget_comparison != null);
        assert.equal(stats.budget_comparison!.forecast_total_tokens, 2000);
        assert.equal(stats.budget_comparison!.depth_escalated, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats falls back to task-mode artifact for depth when preflight has none', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-701', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-06T11:00:00Z'
        });

        // Write preflight without budget_forecast
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-701-preflight.json'),
            JSON.stringify({
                mode: 'FULL_PATH',
                required_reviews: { code: true },
                changed_files: ['src/x.ts'],
                metrics: { changed_lines_total: 20 }
            }),
            'utf8'
        );

        // Write task-mode artifact with depth info
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-701-task-mode.json'),
            JSON.stringify({
                requested_depth: 2,
                effective_depth: 3
            }),
            'utf8'
        );

        const stats = buildTaskStats('T-701', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.requested_depth, 2);
        assert.equal(stats.effective_depth, 3);
        assert.equal(stats.depth_escalated, true);
        assert.equal(stats.budget_forecast, null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatTaskStatsText renders depth and budget forecast when present', () => {
    const stats: TaskStatsResult = {
        task_id: 'T-800',
        events_count: 5,
        first_event_utc: '2026-04-06T12:00:00.000Z',
        last_event_utc: '2026-04-06T12:05:00.000Z',
        wall_clock_seconds: 300,
        gate_pass_count: 4,
        gate_fail_count: 0,
        path_mode: 'FULL_PATH',
        required_reviews: ['code'],
        changed_files_count: 3,
        changed_lines_total: 100,
        requested_depth: 1,
        effective_depth: 2,
        depth_escalated: true,
        budget_forecast: {
            timestamp_utc: '2026-04-06T12:00:00.000Z',
            task_id: 'T-800',
            requested_depth: 1,
            effective_depth: 2,
            depth_escalated: true,
            path_mode: 'FULL_PATH',
            changed_files_count: 3,
            changed_lines_total: 100,
            required_reviews: ['code'],
            review_budget_estimates: [{ review_type: 'code', estimated_tokens: 1280, basis: 'heuristic_base_plus_scope' }],
            total_estimated_review_tokens: 1280,
            compile_gate_estimated_tokens: 420,
            total_forecast_tokens: 1700,
            token_economy_enabled: true,
            token_economy_active_for_depth: true,
            forecast_savings_estimate: 595,
            effective_forecast_tokens: 1105
        },
        budget_comparison: {
            task_id: 'T-800',
            forecast_total_tokens: 1700,
            actual_total_saved_tokens: 400,
            actual_total_raw_tokens: 1500,
            forecast_accuracy_ratio: 0.88,
            requested_depth: 1,
            effective_depth: 2,
            depth_escalated: true,
            summary_line: 'depth: 1->2 (escalated), forecast: ~1700 tokens, actual raw: ~1500 tokens, saved: ~400 tokens, accuracy: 0.88x'
        },
        token_economy: {
            total_estimated_saved_tokens: 400,
            total_raw_token_count_estimate: 1500,
            savings_percent: 27,
            breakdown: [
                { label: 'compile gate output', estimated_saved_tokens: 400, raw_token_count_estimate: 1500 }
            ],
            visible_summary_line: 'Saved tokens: ~400 (~27%) (400 compile gate output).'
        }
    };
    const text = formatTaskStatsText(stats);
    assert.ok(text.includes('Depth: 1 -> 2 (escalated)'));
    assert.ok(text.includes('Budget Forecast:'));
    assert.ok(text.includes('Total forecast: ~1700'));
    assert.ok(text.includes('Effective forecast: ~1105'));
    assert.ok(text.includes('accuracy: 0.88x'));
});
