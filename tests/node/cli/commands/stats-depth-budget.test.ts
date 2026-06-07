import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildTaskStats,
    buildAggregateStats,
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

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function writeReviewAttemptSnapshot(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    verdictToken: string,
    reusedExistingReview = false
): Record<string, unknown> {
    const reviewContent = `# ${reviewType} Review\n\n## Verdict\n${verdictToken}\n`;
    const reviewArtifactSha256 = sha256(reviewContent);
    const liveReviewPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    fs.writeFileSync(liveReviewPath, reviewContent, 'utf8');
    const receiptContent = JSON.stringify({
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: `agent:${reviewType}`,
        review_artifact_sha256: reviewArtifactSha256,
        reused_existing_review: reusedExistingReview
    }, null, 2);
    const receiptSha256 = sha256(receiptContent);
    const liveReceiptPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    fs.writeFileSync(liveReceiptPath, receiptContent, 'utf8');
    const reviewArtifactSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-artifact-${reviewArtifactSha256}.md`);
    const receiptSnapshotPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt-${receiptSha256}.json`);
    fs.copyFileSync(liveReviewPath, reviewArtifactSnapshotPath);
    fs.copyFileSync(liveReceiptPath, receiptSnapshotPath);
    return {
        task_id: taskId,
        review_type: reviewType,
        reused_existing_review: reusedExistingReview,
        receipt_path: liveReceiptPath,
        receipt_sha256: receiptSha256,
        review_artifact_sha256: reviewArtifactSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256
    };
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
    const text = stripAnsi(formatTaskStatsText(stats));
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
    const text = stripAnsi(formatTaskStatsText(stats));
    assert.ok(text.includes('1h 1m 1s'));
});

test('buildTaskStats reads budget_forecast and depth_escalation from preflight', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-700', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-06T10:00:00Z'
        });
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
            total_estimated_saved_chars: 1600,
            total_raw_char_count: 6000,
            total_output_char_count: 4400,
            total_estimated_saved_tokens: 400,
            total_raw_token_count_estimate: 1500,
            chars_savings_percent: 27,
            savings_percent: 27,
            breakdown: [
                {
                    label: 'compile gate output',
                    estimated_saved_chars: 1600,
                    estimated_saved_tokens: 400,
                    raw_char_count: 6000,
                    output_char_count: 4400,
                    raw_token_count_estimate: 1500
                }
            ],
            visible_summary_line: 'Suppressed output: ~1600 chars (~27%) (compile gate output ~1600 chars). Suppressed output estimate: ~400 tokens.'
        }
    };
    const text = stripAnsi(formatTaskStatsText(stats));
    assert.ok(text.includes('Depth: 1 -> 2 (escalated)'));
    assert.ok(text.includes('Budget Forecast:'));
    assert.ok(text.includes('Total forecast: ~1700'));
    assert.ok(text.includes('Effective forecast: ~1105'));
    assert.ok(text.includes('accuracy: 0.88x'));
});
