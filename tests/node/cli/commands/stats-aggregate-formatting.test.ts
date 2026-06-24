import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildAggregateStats,
    formatAggregateStatsJson,
    formatAggregateStatsText,
    formatTaskStatsText,
    formatTaskStatsJson,
    type TaskStatsResult,
    type AggregateStatsResult
} from '../../../../src/cli/commands/stats';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

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



function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}





test('buildAggregateStats aggregates across multiple tasks', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
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
        writeEvent(eventsRoot, 'T-506-1', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-07T09:00:00Z'
        });

        const agg = buildAggregateStats(tmpDir, eventsRoot, reviewsRoot);
        assert.equal(agg.tasks_analyzed, 3);
        assert.equal(agg.total_events, 7);
        assert.equal(agg.total_gate_pass, 3);
        assert.equal(agg.total_gate_fail, 1);
        assert.equal(agg.per_task.length, 3);
        assert.equal(agg.per_task[0].task_id, 'T-001');
        assert.equal(agg.per_task[1].task_id, 'T-002');
        assert.equal(agg.per_task[2].task_id, 'T-506-1');
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
            total_estimated_saved_chars: 2000,
            total_raw_char_count: 8000,
            total_output_char_count: 6000,
            total_estimated_saved_tokens: 500,
            total_raw_token_count_estimate: 2000,
            chars_savings_percent: 25,
            savings_percent: 25,
            breakdown: [
                {
                    label: 'compile gate output',
                    estimated_saved_chars: 1200,
                    estimated_saved_tokens: 300,
                    raw_char_count: 4800,
                    output_char_count: 3600,
                    raw_token_count_estimate: 1200
                },
                {
                    label: 'code review context',
                    estimated_saved_chars: 800,
                    estimated_saved_tokens: 200,
                    raw_char_count: 3200,
                    output_char_count: 2400,
                    raw_token_count_estimate: 800
                }
            ],
            visible_summary_line: 'Suppressed output: ~2000 chars (~25%) (compile gate output ~1200 chars + code review context ~800 chars). Suppressed output estimate: ~500 tokens.'
        }
    };

    const text = stripAnsi(formatTaskStatsText(stats));
    assert.ok(text.includes('Task: T-042'));
    assert.ok(text.includes('Events: 12'));
    assert.ok(text.includes('10m 0s'));
    assert.ok(text.includes('8 passed, 1 failed'));
    assert.ok(text.includes('FULL_PATH'));
    assert.ok(text.includes('code, test'));
    assert.ok(text.includes('Token Economy:'));
    assert.ok(text.includes('~500'));
});

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
            total_estimated_saved_chars: 0,
            total_raw_char_count: 0,
            total_output_char_count: 0,
            total_estimated_saved_tokens: 0,
            total_raw_token_count_estimate: 0,
            chars_savings_percent: null,
            savings_percent: null,
            breakdown: [],
            visible_summary_line: null
        }
    };
    const json = formatTaskStatsJson(stats);
    const parsed = JSON.parse(json);
    assert.equal(parsed.task_id, 'T-001');
});

test('formatAggregateStatsText includes header and per-task lines', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 2,
        total_events: 10,
        total_wall_clock_seconds: 1200,
        total_gate_pass: 8,
        total_gate_fail: 1,
        total_estimated_saved_chars: 4000,
        total_raw_char_count: 16000,
        aggregate_chars_savings_percent: 25,
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
                    total_estimated_saved_chars: 2000,
                    total_raw_char_count: 8000,
                    total_output_char_count: 6000,
                    total_estimated_saved_tokens: 500,
                    total_raw_token_count_estimate: 2000,
                    chars_savings_percent: 25,
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
                    total_estimated_saved_chars: 2000,
                    total_raw_char_count: 8000,
                    total_output_char_count: 6000,
                    total_estimated_saved_tokens: 500,
                    total_raw_token_count_estimate: 2000,
                    chars_savings_percent: 25,
                    savings_percent: 25,
                    breakdown: [],
                    visible_summary_line: null
                }
            }
        ]
    };

    const text = stripAnsi(formatAggregateStatsText(agg));
    assert.ok(text.includes('GARDA_STATS'));
    assert.ok(text.includes('Tasks analyzed: 2'));
    assert.ok(text.includes('Total suppressed output: ~4000 chars (~25%)'));
    assert.ok(text.includes('Total suppressed output estimate: ~1000 tokens'));
    assert.ok(text.includes('T-001'));
    assert.ok(text.includes('T-002'));
});

test('formatAggregateStatsText keeps token-only per-task notes visible', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 1,
        total_events: 3,
        total_wall_clock_seconds: 60,
        total_gate_pass: 2,
        total_gate_fail: 0,
        total_estimated_saved_chars: 0,
        total_raw_char_count: 0,
        aggregate_chars_savings_percent: null,
        total_estimated_saved_tokens: 33,
        total_raw_token_count_estimate: 50,
        aggregate_savings_percent: 66,
        per_task: [
            {
                task_id: 'T-LEGACY',
                events_count: 3,
                first_event_utc: null,
                last_event_utc: null,
                wall_clock_seconds: 60,
                gate_pass_count: 2,
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
                    total_estimated_saved_chars: 0,
                    total_raw_char_count: 0,
                    total_output_char_count: 0,
                    total_estimated_saved_tokens: 33,
                    total_raw_token_count_estimate: 50,
                    chars_savings_percent: null,
                    savings_percent: 66,
                    breakdown: [],
                    visible_summary_line: 'Suppressed output estimate: ~33 tokens (~66%) (compile gate output suppressed output estimate ~33 tokens).'
                }
            }
        ]
    };

    const text = stripAnsi(formatAggregateStatsText(agg));
    assert.ok(text.includes('Total suppressed output: unavailable (legacy token-only artifacts)'));
    assert.ok(text.includes('Total suppressed output estimate: ~33 tokens'));
    assert.ok(text.includes('T-LEGACY: 3 events, 1m 0s, suppressed output estimate ~33 tokens'));
});

test('formatAggregateStatsText marks partial char coverage for mixed aggregate history', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 2,
        total_events: 8,
        total_wall_clock_seconds: 180,
        total_gate_pass: 6,
        total_gate_fail: 0,
        total_estimated_saved_chars: 2000,
        total_raw_char_count: 8000,
        aggregate_chars_savings_percent: null,
        total_estimated_saved_tokens: 533,
        total_raw_token_count_estimate: 2050,
        aggregate_savings_percent: 26,
        per_task: [
            {
                task_id: 'T-MIXED',
                events_count: 5,
                first_event_utc: null,
                last_event_utc: null,
                wall_clock_seconds: 120,
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
                    total_estimated_saved_chars: 2000,
                    total_raw_char_count: 8000,
                    total_output_char_count: 6000,
                    total_estimated_saved_tokens: 500,
                    total_raw_token_count_estimate: 2000,
                    chars_savings_percent: null,
                    savings_percent: 25,
                    breakdown: [],
                    visible_summary_line: 'Suppressed output (char-aware subset): ~2000 chars (compile gate output ~1200 chars + legacy review gate output suppressed output estimate ~200 tokens). Suppressed output estimate: ~500 tokens.'
                }
            },
            {
                task_id: 'T-LEGACY',
                events_count: 3,
                first_event_utc: null,
                last_event_utc: null,
                wall_clock_seconds: 60,
                gate_pass_count: 2,
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
                    total_estimated_saved_chars: 0,
                    total_raw_char_count: 0,
                    total_output_char_count: 0,
                    total_estimated_saved_tokens: 33,
                    total_raw_token_count_estimate: 50,
                    chars_savings_percent: null,
                    savings_percent: 66,
                    breakdown: [],
                    visible_summary_line: 'Suppressed output estimate: ~33 tokens (~66%) (compile gate output suppressed output estimate ~33 tokens).'
                }
            }
        ]
    };

    const text = stripAnsi(formatAggregateStatsText(agg));
    assert.ok(text.includes('Total suppressed output (char-aware subset): ~2000 chars'));
    assert.ok(text.includes('T-MIXED: 5 events, 2m 0s, ~2000 chars suppressed (char-aware subset; suppressed output estimate ~500 tokens)'));
    assert.ok(text.includes('T-LEGACY: 3 events, 1m 0s, suppressed output estimate ~33 tokens'));
});

test('formatAggregateStatsJson produces valid JSON', () => {
    const agg: AggregateStatsResult = {
        tasks_analyzed: 0,
        total_events: 0,
        total_wall_clock_seconds: 0,
        total_gate_pass: 0,
        total_gate_fail: 0,
        total_estimated_saved_chars: 0,
        total_raw_char_count: 0,
        aggregate_chars_savings_percent: null,
        total_estimated_saved_tokens: 0,
        total_raw_token_count_estimate: 0,
        aggregate_savings_percent: null,
        per_task: []
    };
    const json = formatAggregateStatsJson(agg);
    const parsed = JSON.parse(json);
    assert.equal(parsed.tasks_analyzed, 0);
});

