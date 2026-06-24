import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildTaskStats,
    formatAggregateStatsJson,
    formatAggregateStatsText,
    formatTaskStatsText,
    formatTaskStatsJson,
    type TaskStatsResult,
    type AggregateStatsResult
} from '../../../../src/cli/commands/stats';
import { handleStats } from '../../../../src/cli/commands/debug-command';

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

function captureConsoleLog(action: () => void): string {
    const captured: string[] = [];
    const originalLog = console.log;
    try {
        console.log = (...args: unknown[]): void => {
            captured.push(args.map((arg) => String(arg)).join(' '));
        };
        action();
    } finally {
        console.log = originalLog;
    }
    return stripAnsi(captured.join('\n'));
}

function withColorEnv<T>(env: { NO_COLOR?: string | undefined; FORCE_COLOR?: string | undefined }, action: () => T): T {
    const previousNoColor = process.env.NO_COLOR;
    const previousForceColor = process.env.FORCE_COLOR;
    try {
        if (env.NO_COLOR === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = env.NO_COLOR;
        }
        if (env.FORCE_COLOR === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = env.FORCE_COLOR;
        }
        return action();
    } finally {
        if (previousNoColor === undefined) {
            delete process.env.NO_COLOR;
        } else {
            process.env.NO_COLOR = previousNoColor;
        }
        if (previousForceColor === undefined) {
            delete process.env.FORCE_COLOR;
        } else {
            process.env.FORCE_COLOR = previousForceColor;
        }
    }
}

function hasAnsi(value: string): boolean {
    return /\x1B\[[0-9;?]*[ -/]*[@-~]/.test(value);
}

function makeStats(overrides: Partial<TaskStatsResult> = {}): TaskStatsResult {
    return {
        task_id: 'T-123',
        events_count: 2,
        first_event_utc: '2026-04-05T10:00:00.000Z',
        last_event_utc: '2026-04-05T10:01:00.000Z',
        wall_clock_seconds: 60,
        gate_pass_count: 1,
        gate_fail_count: 1,
        path_mode: 'FULL_PATH',
        required_reviews: ['code'],
        changed_files_count: 1,
        changed_lines_total: 10,
        requested_depth: 1,
        effective_depth: 2,
        depth_escalated: true,
        review_attempt_summary: null,
        budget_forecast: null,
        budget_comparison: null,
        token_economy: {
            total_estimated_saved_chars: 1600,
            total_raw_char_count: 2000,
            total_output_char_count: 400,
            total_estimated_saved_tokens: 400,
            total_raw_token_count_estimate: 500,
            chars_savings_percent: 80,
            savings_percent: 80,
            breakdown: [
                {
                    label: 'compile gate output',
                    estimated_saved_chars: 1600,
                    estimated_saved_tokens: 400,
                    raw_char_count: 2000,
                    output_char_count: 400,
                    raw_token_count_estimate: 500
                }
            ],
            visible_summary_line: 'Suppressed output: ~1600 chars (~80%) (compile gate output ~1600 chars). Suppressed output estimate: ~400 tokens.'
        },
        ...overrides
    };
}

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

test('handleStats accepts positional task id as --task-id alias', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-100', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:00:00Z'
        });

        const text = captureConsoleLog(() => {
            handleStats([
                'T-100',
                '--target-root', tmpDir,
                '--events-root', eventsRoot,
                '--reviews-root', reviewsRoot
            ], { name: 'garda-agent-orchestrator', version: '1.0.0' });
        });

        assert.ok(text.includes('Task: T-100'));
        assert.ok(text.includes('Events: 1'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handleStats rejects duplicate positional and flag task ids', () => {
    assert.throws(
        () => handleStats(['T-100', '--task-id', 'T-101'], { name: 'garda-agent-orchestrator', version: '1.0.0' }),
        /Use either positional task id or --task-id/
    );
});

test('handleStats help documents positional task stats usage', () => {
    const text = captureConsoleLog(() => {
        handleStats(['help'], { name: 'garda-agent-orchestrator', version: '1.0.0' });
    });

    assert.ok(text.includes('garda stats "<task-id>"'));
    assert.ok(text.includes('garda stats "T-001"'));
    assert.ok(text.includes('Use a positional task id or --task-id'));
});

test('formatTaskStatsText colorizes human output only when color is enabled', () => {
    const stats = makeStats();

    const colored = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatTaskStatsText(stats));
    assert.equal(hasAnsi(colored), true);
    assert.ok(stripAnsi(colored).includes('Task: T-123'));
    assert.ok(stripAnsi(colored).includes('Gates: 1 passed, 1 failed'));

    const plain = withColorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => formatTaskStatsText(stats));
    assert.equal(hasAnsi(plain), false);
    assert.ok(plain.includes('Task: T-123'));
    assert.ok(plain.includes('Gates: 1 passed, 1 failed'));
});

test('formatAggregateStatsText colorizes human output only when color is enabled', () => {
    const aggregate: AggregateStatsResult = {
        tasks_analyzed: 1,
        total_events: 2,
        total_wall_clock_seconds: 60,
        total_gate_pass: 1,
        total_gate_fail: 1,
        total_estimated_saved_chars: 1600,
        total_raw_char_count: 2000,
        aggregate_chars_savings_percent: 80,
        total_estimated_saved_tokens: 400,
        total_raw_token_count_estimate: 500,
        aggregate_savings_percent: 80,
        per_task: [makeStats()]
    };

    const colored = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatAggregateStatsText(aggregate));
    assert.equal(hasAnsi(colored), true);
    assert.ok(stripAnsi(colored).includes('GARDA_STATS'));
    assert.ok(stripAnsi(colored).includes('T-123: 2 events'));

    const plain = withColorEnv({ NO_COLOR: '1', FORCE_COLOR: '1' }, () => formatAggregateStatsText(aggregate));
    assert.equal(hasAnsi(plain), false);
    assert.ok(plain.includes('GARDA_STATS'));
    assert.ok(plain.includes('T-123: 2 events'));
});

test('stats JSON formatters remain uncolored in color mode', () => {
    const stats = makeStats();
    const aggregate: AggregateStatsResult = {
        tasks_analyzed: 1,
        total_events: 2,
        total_wall_clock_seconds: 60,
        total_gate_pass: 1,
        total_gate_fail: 1,
        total_estimated_saved_chars: 1600,
        total_raw_char_count: 2000,
        aggregate_chars_savings_percent: 80,
        total_estimated_saved_tokens: 400,
        total_raw_token_count_estimate: 500,
        aggregate_savings_percent: 80,
        per_task: [stats]
    };

    const taskJson = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatTaskStatsJson(stats));
    assert.equal(hasAnsi(taskJson), false);
    assert.equal(JSON.parse(taskJson).task_id, 'T-123');

    const aggregateJson = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatAggregateStatsJson(aggregate));
    assert.equal(hasAnsi(aggregateJson), false);
    assert.equal(JSON.parse(aggregateJson).per_task[0].task_id, 'T-123');
});

