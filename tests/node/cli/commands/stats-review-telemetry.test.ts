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

test('buildTaskStats includes review attempt counts from existing review evidence', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-454', {
            event_type: 'REVIEW_RECORDED',
            outcome: 'FAIL',
            timestamp_utc: '2026-04-05T10:00:00Z',
            details: writeReviewAttemptSnapshot(reviewsRoot, 'T-454', 'code', 'REVIEW FAILED')
        });
        writeEvent(eventsRoot, 'T-454', {
            event_type: 'REVIEW_RECORDED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:01:00Z',
            details: writeReviewAttemptSnapshot(reviewsRoot, 'T-454', 'code', 'REVIEW PASSED')
        });
        writeEvent(eventsRoot, 'T-454', {
            event_type: 'REVIEW_RECORDED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:02:00Z',
            details: writeReviewAttemptSnapshot(reviewsRoot, 'T-454', 'test', 'TEST REVIEW PASSED', true)
        });

        const stats = buildTaskStats('T-454', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.review_attempt_summary?.total_attempts, 3);
        assert.deepEqual(stats.review_attempt_summary?.review_types, [
            { review_type: 'code', total_attempts: 2, pass_count: 1, fail_count: 1, reused_count: 0, missing_or_invalid_count: 0 },
            { review_type: 'test', total_attempts: 1, pass_count: 1, fail_count: 0, reused_count: 1, missing_or_invalid_count: 0 }
        ]);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('formatTaskStatsText shows review attempt counts while aggregate text remains unchanged', () => {
    const reviewAttemptSummary = {
        total_attempts: 3,
        source_mode: 'task_events' as const,
        visible_summary_line: 'Review attempts: total=3; code(pass=1, fail=1, reused=0, missing/invalid=0); test(pass=1, fail=0, reused=1, missing/invalid=0)',
        review_types: [
            { review_type: 'code', total_attempts: 2, pass_count: 1, fail_count: 1, reused_count: 0, missing_or_invalid_count: 0 },
            { review_type: 'test', total_attempts: 1, pass_count: 1, fail_count: 0, reused_count: 1, missing_or_invalid_count: 0 }
        ]
    };
    const stats = makeStats({ task_id: 'T-454', review_attempt_summary: reviewAttemptSummary });
    const text = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatTaskStatsText(stats));
    const plainText = stripAnsi(text);
    assert.ok(plainText.includes('Review Attempts:'));
    assert.ok(plainText.includes('Total: 3'));
    assert.ok(plainText.includes('code: 1 pass 1 fail 0 reused 0 missing/invalid'));
    assert.ok(plainText.includes('test: 1 pass 0 fail 1 reused 0 missing/invalid'));

    const json = withColorEnv({ NO_COLOR: undefined, FORCE_COLOR: '1' }, () => formatTaskStatsJson(stats));
    assert.equal(hasAnsi(json), false);
    assert.equal(JSON.parse(json).review_attempt_summary.review_types[0].review_type, 'code');

    const aggregateText = formatAggregateStatsText({
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
    });
    assert.equal(stripAnsi(aggregateText).includes('Review Attempts:'), false);
});

test('buildAggregateStats keeps aggregate per-task JSON stable without review attempt summaries', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-454', {
            event_type: 'REVIEW_RECORDED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T10:00:00Z',
            details: writeReviewAttemptSnapshot(reviewsRoot, 'T-454', 'code', 'REVIEW PASSED')
        });

        const taskStats = buildTaskStats('T-454', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(taskStats.review_attempt_summary?.total_attempts, 1);

        const aggregate = buildAggregateStats(tmpDir, eventsRoot, reviewsRoot);
        assert.equal(aggregate.per_task[0].task_id, 'T-454');
        assert.equal(aggregate.per_task[0].review_attempt_summary, null);
        const aggregateJson = formatAggregateStatsJson(aggregate);
        assert.equal(Object.hasOwn(JSON.parse(aggregateJson).per_task[0], 'review_attempt_summary'), false);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

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
                    raw_char_count: 2000,
                    filtered_char_count: 400,
                    estimated_saved_chars: 1600,
                    raw_token_count_estimate: 500,
                    filtered_token_count_estimate: 100,
                    estimated_saved_tokens: 400
                }
            }
        });

        const stats = buildTaskStats('T-300', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 1600);
        assert.equal(stats.token_economy.total_raw_char_count, 2000);
        assert.equal(stats.token_economy.chars_savings_percent, 80);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 400);
        assert.equal(stats.token_economy.total_raw_token_count_estimate, 500);
        assert.equal(stats.token_economy.savings_percent, 80);
        assert.ok(stats.token_economy.visible_summary_line);
        assert.ok(stats.token_economy.visible_summary_line!.includes('Suppressed output: ~1600 chars'));
        assert.ok(stats.token_economy.visible_summary_line!.includes('~80%'));
        assert.equal(stats.token_economy.breakdown.length, 1);
        assert.equal(stats.token_economy.breakdown[0].label, 'compile gate output');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats labels full-suite validation telemetry separately', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-301', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00Z',
            details: {
                output_telemetry: {
                    raw_char_count: 1500,
                    filtered_char_count: 450,
                    estimated_saved_chars: 1050,
                    raw_token_count_estimate: 420,
                    filtered_token_count_estimate: 120,
                    estimated_saved_tokens: 300
                }
            }
        });

        const stats = buildTaskStats('T-301', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 1050);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 300);
        assert.equal(stats.token_economy.breakdown.length, 1);
        assert.equal(stats.token_economy.breakdown[0].label, 'full-suite validation output');
        assert.ok(stats.token_economy.visible_summary_line!.includes('full-suite validation output ~1050 chars'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats excludes stale full-suite telemetry from an older cycle', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-301B-compile-gate.json'),
            JSON.stringify({
                timestamp_utc: '2026-04-05T14:00:00Z',
                preflight_path: path.join(reviewsRoot, 'T-301B-preflight.json'),
                preflight_hash_sha256: 'current-cycle'
            }),
            'utf8'
        );

        writeEvent(eventsRoot, 'T-301B', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00Z',
            details: {
                cycle_binding: {
                    preflight_path: path.join(reviewsRoot, 'T-301B-preflight.json'),
                    preflight_sha256: 'older-cycle',
                    compile_gate_timestamp: '2026-04-05T13:30:00Z'
                },
                output_telemetry: {
                    raw_char_count: 1500,
                    filtered_char_count: 450,
                    estimated_saved_chars: 1050,
                    raw_token_count_estimate: 420,
                    filtered_token_count_estimate: 120,
                    estimated_saved_tokens: 300
                }
            }
        });

        const stats = buildTaskStats('T-301B', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 0);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 0);
        assert.equal(stats.token_economy.breakdown.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats keeps current-cycle compile and full-suite telemetry when the compile artifact trails the compile event', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        const preflightPath = path.join(reviewsRoot, 'T-301C-preflight.json');
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-301C-compile-gate.json'),
            JSON.stringify({
                timestamp_utc: '2026-04-05T14:00:00.400Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            }),
            'utf8'
        );

        writeEvent(eventsRoot, 'T-301C', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:00:00.000Z',
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
        });
        writeEvent(eventsRoot, 'T-301C', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00.000Z',
            details: {
                cycle_binding: {
                    preflight_path: preflightPath,
                    preflight_sha256: 'current-cycle',
                    compile_gate_timestamp: '2026-04-05T14:00:00.000Z'
                },
                output_telemetry: {
                    raw_char_count: 1500,
                    filtered_char_count: 450,
                    estimated_saved_chars: 1050,
                    raw_token_count_estimate: 420,
                    filtered_token_count_estimate: 120,
                    estimated_saved_tokens: 300
                }
            }
        });

        const stats = buildTaskStats('T-301C', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 1182);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 333);
        assert.equal(stats.token_economy.breakdown.length, 2);
        assert.ok(stats.token_economy.visible_summary_line!.includes('compile gate output ~132 chars'));
        assert.ok(stats.token_economy.visible_summary_line!.includes('full-suite validation output ~1050 chars'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats keeps token-only legacy contributions visible inside char-first summaries', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-302', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00Z',
            details: {
                output_telemetry: {
                    raw_char_count: 1500,
                    filtered_char_count: 450,
                    estimated_saved_chars: 1050,
                    raw_token_count_estimate: 420,
                    filtered_token_count_estimate: 120,
                    estimated_saved_tokens: 300
                }
            }
        });
        writeEvent(eventsRoot, 'T-302', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:06:00Z',
            details: {
                raw_token_count_estimate: 50,
                filtered_token_count_estimate: 17,
                estimated_saved_tokens: 33
            }
        });

        const stats = buildTaskStats('T-302', tmpDir, eventsRoot, reviewsRoot);
        assert.ok(stats.token_economy.visible_summary_line!.includes('Suppressed output (char-aware subset): ~1050 chars'));
        assert.ok(stats.token_economy.visible_summary_line!.includes('full-suite validation output ~1050 chars'));
        assert.ok(stats.token_economy.visible_summary_line!.includes('compile gate output suppressed output estimate ~33 tokens'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats counts full-suite validation events as gate pass/fail outcomes', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-302B', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:00:00Z'
        });
        writeEvent(eventsRoot, 'T-302B', {
            event_type: 'FULL_SUITE_VALIDATION_WARNED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:01:00Z'
        });
        writeEvent(eventsRoot, 'T-302B', {
            event_type: 'FULL_SUITE_VALIDATION_SKIPPED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:02:00Z'
        });
        writeEvent(eventsRoot, 'T-302B', {
            event_type: 'FULL_SUITE_VALIDATION_FAILED',
            outcome: 'FAIL',
            timestamp_utc: '2026-04-05T14:03:00Z'
        });

        const stats = buildTaskStats('T-302B', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.gate_pass_count, 3);
        assert.equal(stats.gate_fail_count, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats uses the provided reviewsRoot and keeps only the latest full-suite attempt per cycle', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot } = scaffold(tmpDir);
        const customReviewsRoot = path.join(tmpDir, 'custom-reviews');
        fs.mkdirSync(customReviewsRoot, { recursive: true });
        const firstArtifactPath = path.join(customReviewsRoot, 'T-302C-full-suite-validation-first.json');
        const secondArtifactPath = path.join(customReviewsRoot, 'T-302C-full-suite-validation-second.json');
        const preflightPath = path.join(customReviewsRoot, 'T-302C-preflight.json');
        fs.writeFileSync(
            path.join(customReviewsRoot, 'T-302C-compile-gate.json'),
            JSON.stringify({
                timestamp_utc: '2026-04-05T14:00:00Z',
                preflight_path: preflightPath,
                preflight_hash_sha256: 'current-cycle'
            }),
            'utf8'
        );

        writeEvent(eventsRoot, 'T-302C', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00Z',
            details: {
                artifact_path: firstArtifactPath,
                cycle_binding: {
                    preflight_path: preflightPath,
                    preflight_sha256: 'current-cycle',
                    compile_gate_timestamp: '2026-04-05T14:00:00Z'
                },
                output_telemetry: {
                    raw_char_count: 600,
                    filtered_char_count: 200,
                    estimated_saved_chars: 400,
                    raw_token_count_estimate: 150,
                    filtered_token_count_estimate: 50,
                    estimated_saved_tokens: 100
                }
            }
        });
        writeEvent(eventsRoot, 'T-302C', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:06:00Z',
            details: {
                artifact_path: secondArtifactPath,
                cycle_binding: {
                    preflight_path: preflightPath,
                    preflight_sha256: 'current-cycle',
                    compile_gate_timestamp: '2026-04-05T14:00:00Z'
                },
                output_telemetry: {
                    raw_char_count: 1200,
                    filtered_char_count: 300,
                    estimated_saved_chars: 900,
                    raw_token_count_estimate: 300,
                    filtered_token_count_estimate: 75,
                    estimated_saved_tokens: 225
                }
            }
        });

        const stats = buildTaskStats('T-302C', tmpDir, eventsRoot, customReviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 900);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 225);
        assert.equal(stats.token_economy.breakdown.length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats normalizes full-suite cycle keys so relative and absolute preflight paths dedupe', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot } = scaffold(tmpDir);
        const customReviewsRoot = path.join(tmpDir, 'custom-reviews');
        fs.mkdirSync(customReviewsRoot, { recursive: true });
        const absolutePreflightPath = path.join(customReviewsRoot, 'T-302D-preflight.json');
        const relativePreflightPath = path.relative(tmpDir, absolutePreflightPath);

        fs.writeFileSync(
            path.join(customReviewsRoot, 'T-302D-compile-gate.json'),
            JSON.stringify({
                timestamp_utc: '2026-04-05T14:00:00Z',
                preflight_path: absolutePreflightPath
            }),
            'utf8'
        );

        writeEvent(eventsRoot, 'T-302D', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:05:00Z',
            details: {
                cycle_binding: {
                    preflight_path: relativePreflightPath,
                    compile_gate_timestamp: '2026-04-05T14:00:00Z'
                },
                output_telemetry: {
                    raw_char_count: 500,
                    filtered_char_count: 150,
                    estimated_saved_chars: 350,
                    raw_token_count_estimate: 125,
                    filtered_token_count_estimate: 38,
                    estimated_saved_tokens: 87
                }
            }
        });
        writeEvent(eventsRoot, 'T-302D', {
            event_type: 'FULL_SUITE_VALIDATION_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:06:00Z',
            details: {
                cycle_binding: {
                    preflight_path: absolutePreflightPath,
                    compile_gate_timestamp: '2026-04-05T14:00:00Z'
                },
                output_telemetry: {
                    raw_char_count: 1200,
                    filtered_char_count: 300,
                    estimated_saved_chars: 900,
                    raw_token_count_estimate: 300,
                    filtered_token_count_estimate: 75,
                    estimated_saved_tokens: 225
                }
            }
        });

        const stats = buildTaskStats('T-302D', tmpDir, eventsRoot, customReviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 900);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 225);
        assert.equal(stats.token_economy.breakdown.length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats ignores stale review-context artifacts until the current cycle rebuilds them', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-302E-compile-gate.json'),
            JSON.stringify({
                timestamp_utc: '2026-04-05T14:00:00Z',
                preflight_path: path.join(reviewsRoot, 'T-302E-preflight.json'),
                preflight_hash_sha256: 'current-cycle'
            }),
            'utf8'
        );
        fs.writeFileSync(
            path.join(reviewsRoot, 'T-302E-code-review-context.json'),
            JSON.stringify({
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
            }),
            'utf8'
        );

        writeEvent(eventsRoot, 'T-302E', {
            event_type: 'REVIEW_PHASE_STARTED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:01:00Z',
            details: {
                review_type: 'code',
                output_path: path.join(reviewsRoot, 'T-302E-code-review-context.json')
            }
        });
        writeEvent(eventsRoot, 'T-302E', {
            event_type: 'COMPILE_GATE_PASSED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T14:06:00Z',
            details: {
                output_telemetry: {
                    raw_char_count: 96,
                    filtered_char_count: 34,
                    estimated_saved_chars: 62,
                    raw_token_count_estimate: 24,
                    filtered_token_count_estimate: 8,
                    estimated_saved_tokens: 16
                }
            }
        });

        const stats = buildTaskStats('T-302E', tmpDir, eventsRoot, reviewsRoot);
        assert.equal(stats.token_economy.total_estimated_saved_chars, 62);
        assert.equal(stats.token_economy.total_estimated_saved_tokens, 16);
        assert.equal(stats.token_economy.breakdown.length, 1);
        assert.equal(stats.token_economy.breakdown[0].label, 'compile gate output');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildTaskStats picks up review-context savings from review artifacts', () => {
    const tmpDir = makeTmpDir();
    try {
        const { eventsRoot, reviewsRoot } = scaffold(tmpDir);
        writeEvent(eventsRoot, 'T-400', {
            event_type: 'TASK_MODE_ENTERED',
            outcome: 'PASS',
            timestamp_utc: '2026-04-05T15:00:00Z'
        });
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

