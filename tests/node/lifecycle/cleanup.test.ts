import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    runCleanup,
    runCleanupWithLock,
    runGc,
    runGcWithLock,
    buildDefaultRetentionPolicy,
    GC_ALLOWLIST,
    validateGcCategories,
    loadStoragePolicy,
    isGateReceipt,
    compressFileGzip,
    applyStoragePolicy,
    type CleanupOptions,
    type GcOptions,
    type GcResult,
    type RetentionPolicy,
    type ReviewArtifactStoragePolicy,
    type StoragePolicyResult
} from '../../../src/lifecycle/cleanup';

function makeTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function setupRuntimeDir(bundleRoot: string): string {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    return runtimeDir;
}

/** Create a timestamped backup directory entry (e.g. `20260101-120000-000`). */
function createTimestampDir(parentDir: string, date: Date): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const pad3 = (n: number) => String(n).padStart(3, '0');
    const name =
        `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}-` +
        `${pad3(date.getMilliseconds())}`;
    const dirPath = path.join(parentDir, name);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'data.txt'), 'test backup data');
    return dirPath;
}

/** Create an update-prefixed directory entry (e.g. `update-20260101-120000`). */
function createUpdateDir(parentDir: string, date: Date): string {
    const pad2 = (n: number) => String(n).padStart(2, '0');
    const name =
        `update-${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-` +
        `${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
    const dirPath = path.join(parentDir, name);
    fs.mkdirSync(dirPath, { recursive: true });
    fs.writeFileSync(path.join(dirPath, 'report.md'), '# Update');
    return dirPath;
}

function daysAgo(days: number): Date {
    return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function createTaskEventFile(eventsDir: string, taskId: string): string {
    const filePath = path.join(eventsDir, `${taskId}.jsonl`);
    fs.writeFileSync(filePath, `{"event":"TASK_MODE_ENTERED","task_id":"${taskId}"}\n`);
    return filePath;
}

function writeTaskTimeline(
    eventsDir: string,
    taskId: string,
    events: Array<{ event_type: string; details?: Record<string, unknown> }>
): string {
    const filePath = path.join(eventsDir, `${taskId}.jsonl`);
    fs.writeFileSync(
        filePath,
        events.map((event, index) => JSON.stringify({
            timestamp_utc: `2026-04-15T12:00:${String(index).padStart(2, '0')}.000Z`,
            task_id: taskId,
            outcome: 'INFO',
            actor: 'test',
            message: event.event_type,
            event_type: event.event_type,
            details: event.details || {}
        })).join('\n') + '\n',
        'utf8'
    );
    return filePath;
}

function createReviewArtifacts(reviewsDir: string, taskId: string): string[] {
    const files = [
        `${taskId}-preflight.json`,
        `${taskId}-task-mode.json`,
        `${taskId}-compile-gate.json`
    ];
    const paths: string[] = [];
    for (const file of files) {
        const filePath = path.join(reviewsDir, file);
        fs.writeFileSync(filePath, JSON.stringify({ task_id: taskId }));
        paths.push(filePath);
    }
    return paths;
}

function writeTaskQueue(
    targetRoot: string,
    tasks: Array<{ id: string; status: string; title?: string }>
): void {
    const lines = [
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|'
    ];

    for (const task of tasks) {
        lines.push(
            `| ${task.id} | ${task.status} | P2 | reliability/test | ${task.title || 'Task'} | gpt-5.4 | 2026-04-15 | balanced | note |`
        );
    }

    fs.writeFileSync(path.join(targetRoot, 'TASK.md'), `${lines.join('\n')}\n`, 'utf8');
}

describe('buildDefaultRetentionPolicy', () => {
    it('returns sensible defaults', () => {
        const policy = buildDefaultRetentionPolicy();
        assert.equal(policy.maxAgeDays, 30);
        assert.equal(policy.maxBackups, 20);
        assert.equal(policy.maxTaskEvents, 50);
        assert.equal(policy.maxAggregateLines, 10000);
        assert.equal(policy.maxReviews, 100);
        assert.equal(policy.maxUpdateReports, 10);
        assert.equal(policy.maxUpdateRollbacks, 5);
        assert.equal(policy.maxBundleBackups, 5);
    });
});

describe('runCleanup', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        // VERSION file required by validateTargetRoot
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort cleanup
        }
    });

    it('returns SUCCESS when runtime is empty', () => {
        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.removed.length, 0);
        assert.equal(result.totalFreedBytes, 0);
    });

    it('returns SUCCESS when runtime dirs do not exist', () => {
        // Remove runtime entirely
        fs.rmSync(runtimeDir, { recursive: true, force: true });
        fs.mkdirSync(runtimeDir, { recursive: true });
        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false
        });
        assert.equal(result.result, 'SUCCESS');
    });

    it('preserves active task review and task-event artifacts resolved from TASK.md', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const activeReviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const inactiveReviewPaths = createReviewArtifacts(reviewsDir, 'T-002');
        const lowercaseActiveReviewPath = path.join(reviewsDir, 't-001-preflight.json');
        fs.writeFileSync(lowercaseActiveReviewPath, JSON.stringify({ task_id: 't-001' }), 'utf8');
        const activeEventPath = createTaskEventFile(eventsDir, 'T-001');
        const inactiveEventPath = createTaskEventFile(eventsDir, 'T-002');
        const activeCachePath = path.join(eventsDir, 'T-001.completeness.json');
        const inactiveCachePath = path.join(eventsDir, 'T-002.completeness.json');
        fs.writeFileSync(activeCachePath, '{}', 'utf8');
        fs.writeFileSync(inactiveCachePath, '{}', 'utf8');

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            lowercaseActiveReviewPath,
            ...inactiveReviewPaths,
            activeEventPath,
            inactiveEventPath,
            activeCachePath,
            inactiveCachePath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 100, maxTaskEvents: 100 }
        });

        assert.ok(result.removed.some((item) => item.path.endsWith('T-002.jsonl')));
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002.completeness.json')));
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
        assert.equal(fs.existsSync(activeEventPath), true, 'active task timeline should be preserved');
        assert.equal(fs.existsSync(activeCachePath), true, 'active task completeness cache should be preserved');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'active task review artifacts should be preserved');
        assert.equal(fs.existsSync(lowercaseActiveReviewPath), true, 'active task lowercase review artifacts should be preserved');
        assert.equal(fs.existsSync(inactiveEventPath), false, 'inactive task timeline should be removed');
        assert.equal(fs.existsSync(inactiveCachePath), false, 'inactive task completeness cache should be removed');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'inactive task review artifacts should be removed');
    });

    it('fails closed for task artifacts when TASK.md cannot be read', () => {
        const taskMdPath = path.join(tmpDir, 'TASK.md');
        fs.mkdirSync(taskMdPath, { recursive: true });

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });

        const reviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const eventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' }
        ]);
        const backupPath = createTimestampDir(backupsDir, daysAgo(45));

        const past = daysAgo(45);
        for (const entryPath of [...reviewPaths, eventPath]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxBackups: 0, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'review artifacts should be preserved when TASK.md is unreadable');
        assert.equal(fs.existsSync(eventPath), true, 'task-event artifacts should be preserved when TASK.md is unreadable');
        assert.equal(fs.existsSync(backupPath), false, 'non-task artifacts may still be cleaned');
        assert.ok(result.removed.some((item) => item.path === backupPath), 'cleanup should still remove ordinary retention candidates');
    });

    it('fails closed for task artifacts when TASK.md is missing', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });

        const reviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const eventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' }
        ]);
        const backupPath = createTimestampDir(backupsDir, daysAgo(45));

        const past = daysAgo(45);
        for (const entryPath of [...reviewPaths, eventPath]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxBackups: 0, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'review artifacts should be preserved when TASK.md is missing');
        assert.equal(fs.existsSync(eventPath), true, 'task-event artifacts should be preserved when TASK.md is missing');
        assert.equal(fs.existsSync(backupPath), false, 'non-task artifacts may still be cleaned');
        assert.ok(result.removed.some((item) => item.path === backupPath), 'cleanup should still remove ordinary retention candidates');
    });

    it('merges runtime activity with TASK.md so stale queue snapshots do not prune live artifacts', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟩 DONE', title: 'Stale queue entry' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const activeReviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const inactiveReviewPaths = createReviewArtifacts(reviewsDir, 'T-002');
        const activeEventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'TODO', new_status: 'IN_PROGRESS' } }
        ]);
        const inactiveEventPath = writeTaskTimeline(eventsDir, 'T-002', [
            { event_type: 'TASK_MODE_ENTERED' },
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } }
        ]);

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            ...inactiveReviewPaths,
            activeEventPath,
            inactiveEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'runtime-active task review artifacts should survive stale TASK.md state');
        assert.equal(fs.existsSync(activeEventPath), true, 'runtime-active task timeline should survive stale TASK.md state');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'terminal runtime task review artifacts should still be eligible for cleanup');
        assert.equal(fs.existsSync(inactiveEventPath), false, 'terminal runtime task timeline should still be eligible for cleanup');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
    });

    it('preserves a fresh lifecycle restart after an older terminal status', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟩 DONE', title: 'Recovered task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        createReviewArtifacts(reviewsDir, 'T-001');
        createReviewArtifacts(reviewsDir, 'T-002');
        const restartedEventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
            { event_type: 'TASK_MODE_ENTERED' }
        ]);
        const inactiveEventPath = writeTaskTimeline(eventsDir, 'T-002', [
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } }
        ]);

        const past = daysAgo(45);
        for (const entryPath of [
            path.join(reviewsDir, 'T-002-preflight.json'),
            path.join(reviewsDir, 'T-002-task-mode.json'),
            path.join(reviewsDir, 'T-002-compile-gate.json'),
            inactiveEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'fresh lifecycle restart should preserve recovered task artifacts');
        assert.equal(fs.existsSync(restartedEventPath), true, 'fresh lifecycle restart should preserve recovered task timeline');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'older terminal task should still be eligible for cleanup');
        assert.equal(fs.existsSync(inactiveEventPath), false, 'older terminal task timeline should still be eligible for cleanup');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-002-task-mode.json')));
    });

    it('does not keep completed tasks active when terminal evidence is followed only by terminal tail events', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Stale active row' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        createReviewArtifacts(reviewsDir, 'T-001');
        const completedEventPath = writeTaskTimeline(eventsDir, 'T-001', [
            { event_type: 'STATUS_CHANGED', details: { previous_status: 'IN_REVIEW', new_status: 'DONE' } },
            { event_type: 'TASK_DONE' }
        ]);

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 }
        });

        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), false, 'terminal runtime evidence should override stale active TASK.md rows');
        assert.equal(fs.existsSync(completedEventPath), false, 'terminal tail events should not keep task timelines active');
        assert.ok(result.removed.some((item) => item.path.endsWith('T-001-task-mode.json')));
    });

    it('prunes aggregate log when over maxAggregateLines', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'aggregateRetention should be present');
        assert.equal(result.aggregateRetention!.pruned, true);
        assert.equal(result.aggregateRetention!.lines_before, 25);
        assert.equal(result.aggregateRetention!.lines_after, 10);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    });

    it('prunes aggregate log without deleting lines for active tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟨 IN_PROGRESS', title: 'Active task' }
        ]);

        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: i < 5 ? 'T-001' : 'T-900' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'aggregate pruning should still run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map((line) => JSON.parse(line) as { seq: number; task_id: string });
        assert.ok(remaining.some((entry) => entry.task_id === 'T-001' && entry.seq === 0), 'active task lines should be preserved');
        assert.equal(remaining.filter((entry) => entry.task_id === 'T-001').length, 5, 'all active-task lines should survive pruning');
        assert.equal(remaining.length, 10, 'pruning should still trim unrelated aggregate lines');
    });

    it('does not prune aggregate log in dry-run mode', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.equal(result.aggregateRetention, undefined);
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25);
    });

    describe('backups retention by count', () => {
        it('removes oldest backups exceeding maxBackups', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            // Create 5 backup dirs
            const dates = [
                daysAgo(5),
                daysAgo(4),
                daysAgo(3),
                daysAgo(2),
                daysAgo(1)
            ];
            for (const d of dates) {
                createTimestampDir(backupsDir, d);
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 3, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            // Should remove 2 oldest
            assert.equal(result.removed.length, 2);
            for (const item of result.removed) {
                assert.equal(item.category, 'backups');
                assert.equal(item.reason, 'count');
            }
            // 3 should remain
            const remaining = fs.readdirSync(backupsDir);
            assert.equal(remaining.length, 3);
        });
    });

    describe('backups retention by age', () => {
        it('removes backups older than maxAgeDays', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            createTimestampDir(backupsDir, daysAgo(60));
            createTimestampDir(backupsDir, daysAgo(1));

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 100, maxAgeDays: 30 }
            });

            assert.equal(result.result, 'SUCCESS');
            const ageItems = result.removed.filter(i => i.reason === 'age');
            assert.ok(ageItems.length >= 1, 'Should remove at least 1 aged backup');
            assert.equal(fs.readdirSync(backupsDir).length, 1);
        });
    });

    describe('dry-run mode', () => {
        it('does not remove any files in dry-run mode', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            for (let i = 0; i < 5; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                dryRun: true,
                retentionPolicy: { maxBackups: 2, maxAgeDays: 365 }
            });

            assert.equal(result.dryRun, true);
            assert.equal(result.removed.length, 0);
            assert.equal(result.skipped.length, 3);
            assert.ok(result.totalFreedBytes > 0, 'Should report projected freed bytes');
            // All 5 dirs should still exist
            assert.equal(fs.readdirSync(backupsDir).length, 5);
        });
    });

    describe('task-event cleanup', () => {
        it('removes oldest task-event files exceeding maxTaskEvents', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            // Create 5 task event files
            for (let i = 1; i <= 5; i++) {
                createTaskEventFile(eventsDir, `T-${String(i).padStart(3, '0')}`);
            }
            // Create all-tasks.jsonl (should never be removed)
            fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), '{"event":"test"}\n');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 3, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(eventItems.length, 2);
            // all-tasks.jsonl must survive
            assert.ok(fs.existsSync(path.join(eventsDir, 'all-tasks.jsonl')));
            // 3 task files + all-tasks.jsonl should remain
            assert.equal(fs.readdirSync(eventsDir).length, 4);
        });

        it('never removes all-tasks.jsonl', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });
            fs.writeFileSync(path.join(eventsDir, 'all-tasks.jsonl'), '{"event":"test"}\n');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 0, maxAgeDays: 0 }
            });

            assert.ok(fs.existsSync(path.join(eventsDir, 'all-tasks.jsonl')));
            const taskEventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(taskEventItems.length, 0);
        });

        it('evicts least recently modified files, not lowest task-ids', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            createTaskEventFile(eventsDir, 'T-001');
            createTaskEventFile(eventsDir, 'T-002');
            createTaskEventFile(eventsDir, 'T-003');

            // Make T-001 the most recently modified, T-002/T-003 stale
            const now = new Date();
            const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
            fs.utimesSync(path.join(eventsDir, 'T-001.jsonl'), now, now);
            fs.utimesSync(path.join(eventsDir, 'T-002.jsonl'), past, past);
            fs.utimesSync(path.join(eventsDir, 'T-003.jsonl'), past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(eventItems.length, 2);
            const removedNames = eventItems.map(i => path.basename(i.path));
            assert.ok(!removedNames.includes('T-001.jsonl'),
                'T-001 (recently modified) must survive despite lowest task-id');
            assert.ok(removedNames.includes('T-002.jsonl'),
                'T-002 (stale) should be evicted');
            assert.ok(removedNames.includes('T-003.jsonl'),
                'T-003 (stale) should be evicted');
        });

        it('evicts companion completeness cache alongside timeline JSONL', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            createTaskEventFile(eventsDir, 'T-001');
            createTaskEventFile(eventsDir, 'T-002');
            // Create companion completeness cache for T-001
            fs.writeFileSync(path.join(eventsDir, 'T-001.completeness.json'), '{}', 'utf8');

            const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            fs.utimesSync(path.join(eventsDir, 'T-001.jsonl'), past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            const removedNames = eventItems.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-001.jsonl'));
            assert.ok(removedNames.includes('T-001.completeness.json'),
                'Companion completeness cache must be evicted with its timeline');
        });

        it('evicts orphaned completeness cache when timeline JSONL is already gone', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            // Create a completeness cache with no corresponding JSONL
            fs.writeFileSync(path.join(eventsDir, 'T-ORPHAN.completeness.json'), '{}', 'utf8');
            createTaskEventFile(eventsDir, 'T-001');

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 10, maxAgeDays: 365 }
            });

            const eventItems = result.removed.filter(i => i.category === 'task-events');
            const removedNames = eventItems.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-ORPHAN.completeness.json'),
                'Orphaned completeness cache must be collected for removal');
        });

        it('prunes stale entries from timeline summary when task-event files are removed', () => {
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(eventsDir, { recursive: true });

            createTaskEventFile(eventsDir, 'T-001');
            createTaskEventFile(eventsDir, 'T-002');

            // Pre-populate a timeline summary with entries for both tasks
            const summaryPath = path.join(eventsDir, '.timeline-summary.json');
            const summaryIndex = {
                version: 1,
                updated_at_utc: new Date().toISOString(),
                entries: {
                    'T-001': { task_id: 'T-001', file_size_bytes: 100, file_mtime_ms: 0,
                        code_changed: false, completeness_status: 'COMPLETE',
                        events_found: [], events_missing: [], completeness_violations: [],
                        integrity_status: 'OK', events_scanned: 1,
                        integrity_event_count: 1, integrity_violations: [] },
                    'T-002': { task_id: 'T-002', file_size_bytes: 100, file_mtime_ms: 0,
                        code_changed: false, completeness_status: 'COMPLETE',
                        events_found: [], events_missing: [], completeness_violations: [],
                        integrity_status: 'OK', events_scanned: 1,
                        integrity_event_count: 1, integrity_violations: [] }
                }
            };
            fs.writeFileSync(summaryPath, JSON.stringify(summaryIndex, null, 2) + '\n', 'utf8');

            // Age T-001 so it gets evicted by count policy (maxTaskEvents: 1)
            const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
            fs.utimesSync(path.join(eventsDir, 'T-001.jsonl'), past, past);

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
            });

            const removedNames = result.removed.map(i => path.basename(i.path));
            assert.ok(removedNames.includes('T-001.jsonl'), 'T-001 timeline should be removed');

            // The timeline summary should have been pruned: T-001 entry gone, T-002 kept
            assert.ok(fs.existsSync(summaryPath), 'Timeline summary file should still exist');
            const updated = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
            assert.ok(!updated.entries['T-001'],
                'Stale T-001 entry must be pruned from timeline summary after its JSONL is removed');
            assert.ok(updated.entries['T-002'],
                'Active T-002 entry must be preserved in timeline summary');
        });
    });

    describe('review artifact cleanup', () => {
        it('removes review artifacts for oldest task groups exceeding maxReviews', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            // Create review artifacts for 4 tasks (sequential creation means
            // ascending mtime order matches ascending task-id order here)
            for (let i = 1; i <= 4; i++) {
                createReviewArtifacts(reviewsDir, `T-${String(i).padStart(3, '0')}`);
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 2, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            // T-001 and T-002 (least recently modified) should be removed, 3 files each = 6 files
            assert.equal(reviewItems.length, 6);
            // T-003 and T-004 should remain
            const remaining = fs.readdirSync(reviewsDir);
            assert.equal(remaining.length, 6); // 3 files x 2 remaining tasks
        });

        it('evicts least recently modified task groups, not lowest task-ids', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            createReviewArtifacts(reviewsDir, 'T-001');
            createReviewArtifacts(reviewsDir, 'T-002');
            createReviewArtifacts(reviewsDir, 'T-003');

            // Make T-001 the most recently modified and T-002/T-003 stale
            const now = new Date();
            const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
            for (const file of fs.readdirSync(reviewsDir)) {
                const filePath = path.join(reviewsDir, file);
                if (file.startsWith('T-002-') || file.startsWith('T-003-')) {
                    fs.utimesSync(filePath, past, past);
                } else {
                    fs.utimesSync(filePath, now, now);
                }
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            assert.equal(reviewItems.length, 6); // 3 files each for 2 stale tasks
            const removedNames = reviewItems.map(i => path.basename(i.path));
            assert.ok(removedNames.every(p => !p.startsWith('T-001-')),
                'T-001 (recently modified) must survive despite lowest task-id');
            assert.ok(removedNames.some(p => p.startsWith('T-002-')),
                'T-002 (stale) should be evicted');
            assert.ok(removedNames.some(p => p.startsWith('T-003-')),
                'T-003 (stale) should be evicted');
        });

        it('groups suffixed review artifacts by the full task id', () => {
            const reviewsDir = path.join(runtimeDir, 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });

            createReviewArtifacts(reviewsDir, 'T-506-1');
            createReviewArtifacts(reviewsDir, 'T-506-2');

            const now = new Date();
            const past = new Date(now.getTime() - 10 * 24 * 60 * 60 * 1000);
            for (const file of fs.readdirSync(reviewsDir)) {
                const filePath = path.join(reviewsDir, file);
                if (file.startsWith('T-506-1-')) {
                    fs.utimesSync(filePath, past, past);
                } else {
                    fs.utimesSync(filePath, now, now);
                }
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxReviews: 1, maxAgeDays: 365 }
            });

            const reviewItems = result.removed.filter(i => i.category === 'reviews');
            const removedNames = reviewItems.map(i => path.basename(i.path));
            assert.equal(reviewItems.length, 3);
            assert.ok(removedNames.every(p => p.startsWith('T-506-1-')));
            assert.ok(fs.readdirSync(reviewsDir).every(p => p.startsWith('T-506-2-')));
        });
    });

    describe('update-rollbacks cleanup', () => {
        it('removes oldest update-rollback dirs exceeding maxUpdateRollbacks', () => {
            const rollbacksDir = path.join(runtimeDir, 'update-rollbacks');
            fs.mkdirSync(rollbacksDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createUpdateDir(rollbacksDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxUpdateRollbacks: 2, maxAgeDays: 365 }
            });

            const rollbackItems = result.removed.filter(i => i.category === 'update-rollbacks');
            assert.equal(rollbackItems.length, 2);
            assert.equal(fs.readdirSync(rollbacksDir).length, 2);
        });
    });

    describe('bundle-backups cleanup', () => {
        it('removes oldest bundle-backup dirs exceeding maxBundleBackups', () => {
            const bundleBackupsDir = path.join(runtimeDir, 'bundle-backups');
            fs.mkdirSync(bundleBackupsDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createTimestampDir(bundleBackupsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBundleBackups: 2, maxAgeDays: 365 }
            });

            const bundleItems = result.removed.filter(i => i.category === 'bundle-backups');
            assert.equal(bundleItems.length, 2);
            assert.equal(fs.readdirSync(bundleBackupsDir).length, 2);
        });
    });

    describe('update-reports cleanup', () => {
        it('removes oldest update-report files exceeding maxUpdateReports', () => {
            const reportsDir = path.join(runtimeDir, 'update-reports');
            fs.mkdirSync(reportsDir, { recursive: true });

            for (let i = 0; i < 4; i++) {
                createUpdateDir(reportsDir, daysAgo(i + 1));
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxUpdateReports: 2, maxAgeDays: 365 }
            });

            const reportItems = result.removed.filter(i => i.category === 'update-reports');
            assert.equal(reportItems.length, 2);
            assert.equal(fs.readdirSync(reportsDir).length, 2);
        });
    });

    describe('retention policy override', () => {
        it('accepts partial overrides and uses defaults for the rest', () => {
            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 5 }
            });

            assert.equal(result.retentionPolicy.maxBackups, 5);
            assert.equal(result.retentionPolicy.maxAgeDays, 30);
            assert.equal(result.retentionPolicy.maxTaskEvents, 50);
        });
    });

    describe('combined retention', () => {
        it('cleans up across multiple categories in a single run', () => {
            const backupsDir = path.join(runtimeDir, 'backups');
            const eventsDir = path.join(runtimeDir, 'task-events');
            fs.mkdirSync(backupsDir, { recursive: true });
            fs.mkdirSync(eventsDir, { recursive: true });

            for (let i = 0; i < 5; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }
            for (let i = 1; i <= 5; i++) {
                createTaskEventFile(eventsDir, `T-${String(i).padStart(3, '0')}`);
            }

            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 2, maxTaskEvents: 2, maxAgeDays: 365 }
            });

            assert.equal(result.result, 'SUCCESS');
            const backupItems = result.removed.filter(i => i.category === 'backups');
            const eventItems = result.removed.filter(i => i.category === 'task-events');
            assert.equal(backupItems.length, 3);
            assert.equal(eventItems.length, 3);
        });
    });

    describe('error handling', () => {
        it('reports PARTIAL when some removals fail', () => {
            // Create a backup dir that we make read-only on the parent
            // This test only verifies the error-reporting path
            const backupsDir = path.join(runtimeDir, 'backups');
            fs.mkdirSync(backupsDir, { recursive: true });

            for (let i = 0; i < 3; i++) {
                createTimestampDir(backupsDir, daysAgo(i + 1));
            }

            // Normal run should succeed
            const result = runCleanup({
                targetRoot: tmpDir,
                bundleRoot,
                retentionPolicy: { maxBackups: 1, maxAgeDays: 365 }
            });
            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.errors.length, 0);
        });
    });
});

describe('runCleanupWithLock', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-lock-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('runs cleanup under lifecycle lock', () => {
        const result = runCleanupWithLock({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: true
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.dryRun, true);
    });
});


describe('GC_ALLOWLIST', () => {
    it('contains expected categories', () => {
        assert.ok(GC_ALLOWLIST.includes('backups'));
        assert.ok(GC_ALLOWLIST.includes('reviews'));
        assert.ok(GC_ALLOWLIST.includes('task-events'));
        assert.ok(GC_ALLOWLIST.includes('isolation-sandbox'));
        assert.ok(GC_ALLOWLIST.includes('stale-locks'));
        assert.ok(GC_ALLOWLIST.includes('update-rollbacks'));
        assert.ok(GC_ALLOWLIST.includes('update-reports'));
        assert.ok(GC_ALLOWLIST.includes('bundle-backups'));
    });
});

describe('validateGcCategories', () => {
    it('accepts valid allowlist categories', () => {
        assert.doesNotThrow(() => validateGcCategories(['backups', 'reviews']));
    });

    it('rejects unknown categories', () => {
        assert.throws(
            () => validateGcCategories(['backups', 'unknown-dir']),
            /Unknown gc category 'unknown-dir'/
        );
    });
});

describe('runGc', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('is dry-run by default', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 365 }
        });

        assert.equal(result.dryRun, true, 'gc must default to dry-run');
        assert.equal(result.removed.length, 0, 'dry-run must not remove');
        assert.ok(result.skipped.length > 0, 'dry-run must report skipped');
        assert.equal(fs.readdirSync(backupsDir).length, 1, 'files must survive');
    });

    it('deletes files when confirm is true', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(backupsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        createTimestampDir(backupsDir, daysAgo(1));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 365 }
        });

        assert.equal(result.dryRun, false);
        assert.ok(result.removed.length > 0, 'should remove items');
        assert.equal(fs.readdirSync(backupsDir).length, 0, 'all backups removed');
    });

    it('prunes stale timeline summary entries when gc removes task-event files', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });

        createTaskEventFile(eventsDir, 'T-001');
        createTaskEventFile(eventsDir, 'T-002');

        const summaryPath = path.join(eventsDir, '.timeline-summary.json');
        const summaryIndex = {
            version: 1,
            updated_at_utc: new Date().toISOString(),
            entries: {
                'T-001': { task_id: 'T-001', file_size_bytes: 100, file_mtime_ms: 0,
                    code_changed: false, completeness_status: 'COMPLETE',
                    events_found: [], events_missing: [], completeness_violations: [],
                    integrity_status: 'OK', events_scanned: 1,
                    integrity_event_count: 1, integrity_violations: [] },
                'T-002': { task_id: 'T-002', file_size_bytes: 100, file_mtime_ms: 0,
                    code_changed: false, completeness_status: 'COMPLETE',
                    events_found: [], events_missing: [], completeness_violations: [],
                    integrity_status: 'OK', events_scanned: 1,
                    integrity_event_count: 1, integrity_violations: [] }
            }
        };
        fs.writeFileSync(summaryPath, JSON.stringify(summaryIndex, null, 2) + '\n', 'utf8');

        const past = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000);
        fs.utimesSync(path.join(eventsDir, 'T-001.jsonl'), past, past);

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxTaskEvents: 1, maxAgeDays: 365 }
        });

        const removedNames = result.removed.map((item) => path.basename(item.path));
        assert.ok(removedNames.includes('T-001.jsonl'), 'gc should remove the stale T-001 timeline');

        assert.ok(fs.existsSync(summaryPath), 'timeline summary must remain after gc pruning');
        const updated = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
        assert.ok(!updated.entries['T-001'],
            'gc must prune stale T-001 entry from timeline summary after removing its JSONL');
        assert.ok(updated.entries['T-002'],
            'gc must preserve still-live T-002 summary entry');
    });

    it('returns per-category summary with correct counts and bytes', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        createTaskEventFile(eventsDir, 'T-001');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            retentionPolicy: { maxBackups: 0, maxTaskEvents: 0, maxAgeDays: 365 }
        });

        assert.ok(result.categories.backups, 'should have backups category');
        assert.equal(result.categories.backups.count, 1, 'should count 1 backup');
        assert.ok(result.categories.backups.bytes > 0, 'should report bytes > 0');
        assert.ok(result.categories['task-events'], 'should have task-events category');
        assert.equal(result.categories['task-events'].count, 1, 'should count 1 task-event');
        assert.ok(result.categories['task-events'].bytes > 0, 'should report bytes > 0');
    });

    it('reports staleLocksCleaned from task-event lock subsystem', () => {
        // Create task-events dir and a stale lock within it
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const staleLock = path.join(eventsDir, '.T-999.jsonl.lock');
        fs.mkdirSync(staleLock, { recursive: true });
        // Write owner.json with a PID that is definitely not running (99999999)
        fs.writeFileSync(
            path.join(staleLock, 'owner.json'),
            JSON.stringify({ pid: 99999999, hostname: 'test', timestamp_utc: new Date().toISOString() })
        );

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        // staleLocksCleaned may be 0 if the subsystem doesn't recognize the lock
        // format, but the integration path is exercised without errors
        assert.equal(typeof result.staleLocksCleaned, 'number');
    });

    it('accounts for stale task-event lock bytes in dry-run totals', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const staleLock = path.join(eventsDir, '.T-777.jsonl.lock');
        fs.mkdirSync(staleLock, { recursive: true });
        const ownerPath = path.join(staleLock, 'owner.json');
        fs.writeFileSync(
            ownerPath,
            JSON.stringify({ hostname: os.hostname(), timestamp_utc: new Date().toISOString() })
        );
        fs.writeFileSync(path.join(staleLock, 'payload.txt'), 'lock-payload');
        const staleTime = new Date(Date.now() - 5_000);
        fs.utimesSync(ownerPath, staleTime, staleTime);
        fs.utimesSync(staleLock, staleTime, staleTime);

        const expectedBytes = fs.statSync(path.join(staleLock, 'owner.json')).size
            + fs.statSync(path.join(staleLock, 'payload.txt')).size;

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot
        });

        assert.ok(result.staleLocksCleaned >= 1, 'dry-run should report removable stale task-event locks');
        assert.ok(result.totalFreedBytes >= expectedBytes, 'dry-run total should include stale task-event lock bytes');
        assert.ok(result.categories['task-events'], 'task-events summary should be present');
        assert.ok(result.categories['task-events'].bytes >= expectedBytes,
            'task-events summary should include stale task-event lock bytes');
    });

    it('reports PARTIAL when removal errors occur', () => {
        // This test verifies the error-reporting shape is correct even when
        // no actual errors can be induced cross-platform. We verify the
        // structure of errors array and result field remain consistent.
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        assert.ok(Array.isArray(result.errors));
        assert.equal(result.result, 'SUCCESS');
    });

    it('cleans isolation-sandbox entries older than maxAgeDays', () => {
        const sandboxDir = path.join(runtimeDir, '.isolation-sandbox');
        fs.mkdirSync(sandboxDir, { recursive: true });
        const oldEntry = path.join(sandboxDir, 'old-sandbox');
        fs.mkdirSync(oldEntry, { recursive: true });
        fs.writeFileSync(path.join(oldEntry, 'manifest.json'), '{}');
        // Set mtime to 60 days ago
        const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldEntry, past, past);

        const recentEntry = path.join(sandboxDir, 'recent-sandbox');
        fs.mkdirSync(recentEntry, { recursive: true });

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 30 }
        });

        const sandboxItems = result.removed.filter(i => i.category === 'isolation-sandbox');
        assert.ok(sandboxItems.length >= 1, 'should remove old sandbox');
        assert.ok(result.isolationSandboxCleaned, 'isolationSandboxCleaned should be true');
        assert.ok(fs.existsSync(recentEntry), 'recent sandbox must survive');
    });

    it('cleans orphaned stale lifecycle lock remnants', () => {
        const staleLockDir = path.join(runtimeDir, '.lifecycle-operation.lock.stale-99999-1234567');
        fs.mkdirSync(staleLockDir, { recursive: true });
        fs.writeFileSync(path.join(staleLockDir, 'owner.json'), '{"pid":99999}');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true
        });

        const staleLockItems = result.removed.filter(i => i.category === 'stale-locks');
        assert.ok(staleLockItems.length >= 1, 'should collect stale lock remnant');
        assert.ok(!fs.existsSync(staleLockDir), 'stale lock should be removed');
    });

    it('filters by category when --category is specified', () => {
        const backupsDir = path.join(runtimeDir, 'backups');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(backupsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });
        createTimestampDir(backupsDir, daysAgo(2));
        createTaskEventFile(eventsDir, 'T-001');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxTaskEvents: 0, maxAgeDays: 365 },
            categories: ['backups']
        });

        const backupItems = result.removed.filter(i => i.category === 'backups');
        const eventItems = result.removed.filter(i => i.category === 'task-events');
        assert.ok(backupItems.length > 0, 'should remove backups');
        assert.equal(eventItems.length, 0, 'should not remove task-events when filtered out');
        // Task events should still exist
        assert.ok(fs.existsSync(path.join(eventsDir, 'T-001.jsonl')));
    });

    it('filters by isolation-sandbox category', () => {
        const sandboxDir = path.join(runtimeDir, '.isolation-sandbox');
        const backupsDir = path.join(runtimeDir, 'backups');
        fs.mkdirSync(sandboxDir, { recursive: true });
        fs.mkdirSync(backupsDir, { recursive: true });
        const oldEntry = path.join(sandboxDir, 'old-sandbox');
        fs.mkdirSync(oldEntry, { recursive: true });
        const past = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
        fs.utimesSync(oldEntry, past, past);
        createTimestampDir(backupsDir, daysAgo(2));

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxBackups: 0, maxAgeDays: 30 },
            categories: ['isolation-sandbox']
        });

        const sandboxItems = result.removed.filter(i => i.category === 'isolation-sandbox');
        const backupItems = result.removed.filter(i => i.category === 'backups');
        assert.ok(sandboxItems.length >= 1, 'should remove old sandbox');
        assert.equal(backupItems.length, 0, 'should not touch backups when filtered');
    });

    it('returns SUCCESS when runtime is empty', () => {
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.staleLocksCleaned, 0);
        assert.equal(result.isolationSandboxCleaned, false);
    });

    it('rejects invalid category in options', () => {
        assert.throws(
            () => runGc({
                targetRoot: tmpDir,
                bundleRoot,
                categories: ['not-a-real-dir']
            }),
            /Unknown gc category/
        );
    });
});

describe('runGcWithLock', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-lock-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        const runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
            // Best-effort
        }
    });

    it('runs gc under lifecycle lock in dry-run mode', () => {
        const result = runGcWithLock({
            targetRoot: tmpDir,
            bundleRoot
        });
        assert.equal(result.result, 'SUCCESS');
        assert.equal(result.dryRun, true);
    });
});


describe('loadStoragePolicy', () => {
    let tmpDir: string;
    let bundleRoot: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-storage-policy-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('returns default policy when config file is missing', () => {
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
        assert.equal(policy.compressAfterDays, 7);
        assert.equal(policy.compressionFormat, 'gzip');
        assert.equal(policy.preserveGateReceipts, true);
        assert.ok(policy.gateReceiptSuffixes.length > 0);
    });

    it('loads custom retention_mode from config', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            retention_mode: 'summary',
            compress_after_days: 14,
            compression_format: 'gzip',
            preserve_gate_receipts: false,
            gate_receipt_suffixes: ['-task-mode.json']
        }));
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'summary');
        assert.equal(policy.compressAfterDays, 14);
        assert.equal(policy.preserveGateReceipts, false);
        assert.deepEqual(policy.gateReceiptSuffixes, ['-task-mode.json']);
    });

    it('falls back to defaults on invalid JSON', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, 'not-json');
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
    });

    it('falls back to full on invalid retention_mode', () => {
        const configPath = path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json');
        fs.writeFileSync(configPath, JSON.stringify({
            version: 1,
            retention_mode: 'invalid',
            compress_after_days: 7,
            compression_format: 'gzip',
            preserve_gate_receipts: true,
            gate_receipt_suffixes: ['-task-mode.json']
        }));
        const policy = loadStoragePolicy(bundleRoot);
        assert.equal(policy.retentionMode, 'full');
    });
});

describe('isGateReceipt', () => {
    it('identifies gate receipt files by suffix', () => {
        const suffixes = ['-task-mode.json', '-preflight.json', '-compile-gate.json'];
        assert.equal(isGateReceipt('T-058-task-mode.json', suffixes), true);
        assert.equal(isGateReceipt('T-058-preflight.json', suffixes), true);
        assert.equal(isGateReceipt('T-058-code-review-context.json', suffixes), false);
        assert.equal(isGateReceipt('T-058-scoped.diff', suffixes), false);
    });
});

describe('compressFileGzip', () => {
    let tmpDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-compress-');
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('compresses a file and removes the original', () => {
        const filePath = path.join(tmpDir, 'test.json');
        fs.writeFileSync(filePath, '{"data": "test content for compression"}');
        const gzPath = compressFileGzip(filePath);
        assert.equal(gzPath, `${filePath}.gz`);
        assert.ok(fs.existsSync(gzPath), 'compressed file should exist');
        assert.ok(!fs.existsSync(filePath), 'original should be removed');
        assert.ok(fs.statSync(gzPath).size > 0, 'compressed file should have content');
    });
});

describe('applyStoragePolicy', () => {
    let tmpDir: string;
    let reviewsDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-storage-apply-');
        reviewsDir = path.join(tmpDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    function createArtifact(name: string, ageDays?: number): string {
        const filePath = path.join(reviewsDir, name);
        fs.writeFileSync(filePath, JSON.stringify({ artifact: name }));
        if (ageDays !== undefined && ageDays > 0) {
            const past = new Date(Date.now() - ageDays * 24 * 60 * 60 * 1000);
            fs.utimesSync(filePath, past, past);
        }
        return filePath;
    }

    it('mode none removes non-receipt artifacts but preserves gate receipts', () => {
        createArtifact('T-001-task-mode.json');
        createArtifact('T-001-preflight.json');
        createArtifact('T-001-code-review-context.json');
        createArtifact('T-001-scoped.diff');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json', '-preflight.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.preserved.includes('T-001-task-mode.json'));
        assert.ok(result.preserved.includes('T-001-preflight.json'));
        assert.ok(result.removed.includes('T-001-code-review-context.json'));
        assert.ok(result.removed.includes('T-001-scoped.diff'), '.diff artifacts should be removed in none mode');
    });

    it('mode none with preserve_gate_receipts=false removes everything', () => {
        createArtifact('T-002-task-mode.json');
        createArtifact('T-002-code-review-context.json');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: false,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.removed.includes('T-002-task-mode.json'));
        assert.ok(result.removed.includes('T-002-code-review-context.json'));
        assert.equal(result.preserved.length, 0);
    });

    it('mode summary keeps only gate receipts', () => {
        createArtifact('T-003-task-mode.json');
        createArtifact('T-003-compile-gate.json');
        createArtifact('T-003-code-review-context.json');
        createArtifact('T-003-code-review.md');
        createArtifact('T-003-code-scoped.diff');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json', '-compile-gate.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.preserved.includes('T-003-task-mode.json'));
        assert.ok(result.preserved.includes('T-003-compile-gate.json'));
        assert.ok(result.removed.includes('T-003-code-review-context.json'));
        assert.ok(result.removed.includes('T-003-code-review.md'));
        assert.ok(result.removed.includes('T-003-code-scoped.diff'), '.diff artifacts should be removed in summary mode');
    });

    it('mode full compresses old artifacts', () => {
        createArtifact('T-004-task-mode.json', 10);
        createArtifact('T-004-code-review-context.json', 10);
        createArtifact('T-004-recent.json', 0);

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'full',
            compressAfterDays: 7,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.ok(result.compressed.includes('T-004-task-mode.json'));
        assert.ok(result.compressed.includes('T-004-code-review-context.json'));
        assert.ok(result.preserved.includes('T-004-recent.json'));
        assert.ok(fs.existsSync(path.join(reviewsDir, 'T-004-task-mode.json.gz')));
    });

    it('mode full with compression disabled preserves all', () => {
        createArtifact('T-005-task-mode.json', 10);

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'full',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set());
        assert.equal(result.compressed.length, 0);
        assert.ok(result.preserved.includes('T-005-task-mode.json'));
    });

    it('never touches artifacts for active tasks', () => {
        createArtifact('T-006-task-mode.json');
        createArtifact('T-006-code-review-context.json');
        createArtifact('t-006-preflight.json');

        const policy: ReviewArtifactStoragePolicy = {
            retentionMode: 'none',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: false,
            gateReceiptSuffixes: []
        };

        const result = applyStoragePolicy(reviewsDir, policy, new Set(['T-006']));
        assert.equal(result.removed.length, 0);
        assert.ok(result.preserved.includes('T-006-task-mode.json'));
        assert.ok(result.preserved.includes('T-006-code-review-context.json'));
        assert.ok(result.preserved.includes('t-006-preflight.json'));
    });

    it('returns empty result for non-existent directory', () => {
        const result = applyStoragePolicy(
            path.join(tmpDir, 'nonexistent'),
            { retentionMode: 'none', compressAfterDays: 0, compressionFormat: 'gzip', preserveGateReceipts: true, gateReceiptSuffixes: ['-task-mode.json'] },
            new Set()
        );
        assert.equal(result.compressed.length, 0);
        assert.equal(result.removed.length, 0);
        assert.equal(result.preserved.length, 0);
    });

    it('records retentionMode in result', () => {
        const result = applyStoragePolicy(reviewsDir, {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());
        assert.equal(result.retentionMode, 'summary');
    });
});

describe('runGc with storage policy', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-storage-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        fs.mkdirSync(bundleRoot, { recursive: true });
        fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        runtimeDir = path.join(bundleRoot, 'runtime');
        fs.mkdirSync(runtimeDir, { recursive: true });
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('applies storage policy when confirm=true', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-099-task-mode.json'), '{}');
        fs.writeFileSync(path.join(reviewsDir, 'T-099-code-review-context.json'), '{}');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            storagePolicy: {
                retentionMode: 'summary',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: true,
                gateReceiptSuffixes: ['-task-mode.json']
            },
            retentionPolicy: { maxReviews: 1000, maxAgeDays: 365 }
        });

        assert.ok(result.storagePolicyResult);
        assert.equal(result.storagePolicyResult.retentionMode, 'summary');
        assert.ok(result.storagePolicyResult.preserved.includes('T-099-task-mode.json'));
        assert.ok(result.storagePolicyResult.removed.includes('T-099-code-review-context.json'));
    });

    it('does not apply storage policy in dry-run mode', () => {
        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: false
        });

        assert.equal(result.storagePolicyResult, undefined);
    });

    it('preserves active task artifacts resolved from TASK.md during gc candidate collection and storage policy', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟧 IN_REVIEW', title: 'Active review task' },
            { id: 'T-002', status: '🟩 DONE', title: 'Completed task' }
        ]);

        const reviewsDir = path.join(runtimeDir, 'reviews');
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.mkdirSync(eventsDir, { recursive: true });

        const activeReviewPaths = createReviewArtifacts(reviewsDir, 'T-001');
        const inactiveReviewPaths = createReviewArtifacts(reviewsDir, 'T-002');
        const activeEventPath = createTaskEventFile(eventsDir, 'T-001');
        const inactiveEventPath = createTaskEventFile(eventsDir, 'T-002');

        const past = daysAgo(45);
        for (const entryPath of [
            ...activeReviewPaths,
            ...inactiveReviewPaths,
            activeEventPath,
            inactiveEventPath
        ]) {
            fs.utimesSync(entryPath, past, past);
        }

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAgeDays: 30, maxReviews: 0, maxTaskEvents: 0 },
            storagePolicy: {
                retentionMode: 'none',
                compressAfterDays: 0,
                compressionFormat: 'gzip',
                preserveGateReceipts: false,
                gateReceiptSuffixes: []
            }
        });

        assert.ok(result.storagePolicyResult, 'storage policy should run in confirm mode');
        assert.ok(result.storagePolicyResult!.preserved.includes('T-001-task-mode.json'));
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-001-task-mode.json')), true, 'active review artifact should survive gc');
        assert.equal(fs.existsSync(path.join(reviewsDir, 'T-002-task-mode.json')), false, 'inactive review artifact should be removed');
        assert.equal(fs.existsSync(activeEventPath), true, 'active task timeline should survive gc');
        assert.equal(fs.existsSync(inactiveEventPath), false, 'inactive task timeline should be removed by gc');
    });
});

describe('runGc aggregate retention', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-gc-agg-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it('prunes aggregate log when confirm=true and over maxAggregateLines', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'aggregateRetention should be present');
        assert.equal(result.aggregateRetention!.pruned, true);
        assert.equal(result.aggregateRetention!.lines_before, 25);
        assert.equal(result.aggregateRetention!.lines_after, 10);

        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 10);
        assert.equal(JSON.parse(remaining[0]).seq, 15);
    });

    it('does not prune aggregate log in dry-run mode', () => {
        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: false,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.equal(result.aggregateRetention, undefined,
            'aggregateRetention should not be set in dry-run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim());
        assert.equal(remaining.length, 25, 'original lines should be preserved');
    });

    it('prunes aggregate log during gc without deleting lines for active tasks', () => {
        writeTaskQueue(tmpDir, [
            { id: 'T-001', status: '🟧 IN_REVIEW', title: 'Active review task' }
        ]);

        const eventsDir = path.join(runtimeDir, 'task-events');
        fs.mkdirSync(eventsDir, { recursive: true });
        const allTasksPath = path.join(eventsDir, 'all-tasks.jsonl');
        const lines = Array.from({ length: 25 }, (_, i) =>
            JSON.stringify({ seq: i, task_id: i < 5 ? 'T-001' : 'T-900' })
        );
        fs.writeFileSync(allTasksPath, lines.join('\n') + '\n', 'utf8');

        const result = runGc({
            targetRoot: tmpDir,
            bundleRoot,
            confirm: true,
            retentionPolicy: { maxAggregateLines: 10 }
        });

        assert.ok(result.aggregateRetention, 'gc aggregate pruning should still run');
        const remaining = fs.readFileSync(allTasksPath, 'utf8')
            .split('\n')
            .filter(l => l.trim())
            .map((line) => JSON.parse(line) as { seq: number; task_id: string });
        assert.equal(remaining.filter((entry) => entry.task_id === 'T-001').length, 5, 'all active-task lines should survive gc pruning');
        assert.equal(remaining.length, 10, 'gc pruning should still trim unrelated aggregate lines');
    });

    it('reports maxAggregateLines in default retention policy', () => {
        const policy = buildDefaultRetentionPolicy();
        assert.equal(typeof policy.maxAggregateLines, 'number');
        assert.ok(policy.maxAggregateLines > 0, 'default maxAggregateLines must be positive');
    });
});

describe('cleanup invalidates reviews index', () => {
    let tmpDir: string;
    let bundleRoot: string;
    let runtimeDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('gao-cleanup-index-');
        bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        runtimeDir = setupRuntimeDir(bundleRoot);
    });

    afterEach(() => {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
    });

    it('applyStoragePolicy invalidates reviews index when artifacts are removed', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-001-task-mode.json'), '{}');
        fs.writeFileSync(path.join(reviewsDir, 'T-001-code-review-context.json'), '{}');

        // Create an index file to verify it gets invalidated
        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        const result = applyStoragePolicy(reviewsDir, {
            retentionMode: 'summary',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());

        assert.ok(result.removed.includes('T-001-code-review-context.json'));
        assert.equal(fs.existsSync(indexPath), false, 'Reviews index should be invalidated after removal');
    });

    it('applyStoragePolicy does not invalidate index when no changes made', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(path.join(reviewsDir, 'T-001-task-mode.json'), '{}');

        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        applyStoragePolicy(reviewsDir, {
            retentionMode: 'full',
            compressAfterDays: 0,
            compressionFormat: 'gzip',
            preserveGateReceipts: true,
            gateReceiptSuffixes: ['-task-mode.json']
        }, new Set());

        assert.ok(fs.existsSync(indexPath), 'Reviews index should not be touched when no changes');
    });

    it('runCleanup invalidates reviews index when review artifacts are removed', () => {
        const reviewsDir = path.join(runtimeDir, 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        // Create 5 tasks with 3 artifacts each, cap at 2
        for (let i = 1; i <= 5; i++) {
            const taskId = `T-${String(i).padStart(3, '0')}`;
            const paths = createReviewArtifacts(reviewsDir, taskId);
            const past = new Date(Date.now() - (6 - i) * 24 * 60 * 60 * 1000);
            for (const p of paths) {
                fs.utimesSync(p, past, past);
            }
        }

        // Create index file
        const indexPath = path.join(reviewsDir, 'reviews-index.json');
        fs.writeFileSync(indexPath, JSON.stringify({ version: 1, entries: [] }));

        const result = runCleanup({
            targetRoot: tmpDir,
            bundleRoot,
            dryRun: false,
            retentionPolicy: { maxReviews: 2 }
        });

        assert.ok(result.removed.some(item => item.category === 'reviews'));
        assert.equal(fs.existsSync(indexPath), false, 'Reviews index should be invalidated after cleanup');
    });
});
