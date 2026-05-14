import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    handleRepair,
    runRepairInspect,
    runRepairLocks,
    runRepairProtectedManifest,
    runRepairRebuildIndexes
} from '../../../src/cli/commands/repair-command';

function makeRepairFixture(): { root: string; bundleRoot: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-repair-command-'));
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    const eventsRoot = path.join(bundleRoot, 'runtime', 'task-events');
    const reviewsRoot = path.join(bundleRoot, 'runtime', 'reviews');

    fs.mkdirSync(eventsRoot, { recursive: true });
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(path.join(eventsRoot, 'T-001.jsonl'), '', 'utf8');
    fs.writeFileSync(path.join(reviewsRoot, 'T-001-code.md'), 'CODE REVIEW PASSED\n', 'utf8');

    return {
        root,
        bundleRoot,
        cleanup: () => fs.rmSync(root, { recursive: true, force: true })
    };
}

function writeStaleLock(lockPath: string): void {
    fs.mkdirSync(lockPath, { recursive: true });
    const oldDate = new Date(Date.now() - (60 * 60 * 1000));
    fs.utimesSync(lockPath, oldDate, oldDate);
}

function captureStdout(callback: () => void): string {
    const originalWrite = process.stdout.write;
    let output = '';
    process.stdout.write = ((chunk: string | Uint8Array) => {
        output += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
        return true;
    }) as typeof process.stdout.write;
    try {
        callback();
    } finally {
        process.stdout.write = originalWrite;
    }
    return output;
}

test('repair inspect reports canonical and derived runtime state without mutating files', () => {
    const fixture = makeRepairFixture();
    try {
        const result = runRepairInspect(fixture.root);

        assert.equal(result.targetRoot, path.resolve(fixture.root));
        assert.match(result.canonical_state.task_events, /runtime\/task-events\/<task-id>\.jsonl$/);
        assert.match(result.canonical_state.review_artifacts, /runtime\/reviews$/);
        assert.match(result.derived_state.timeline_summary_path, /\.timeline-summary\.json$/);
        assert.match(result.derived_state.reviews_index_path, /reviews-index\.json$/);
        assert.equal(result.protected_manifest.status, 'MISSING');
    } finally {
        fixture.cleanup();
    }
});

test('repair locks previews stale cleanup before removing task-event and review-artifact locks', () => {
    const fixture = makeRepairFixture();
    try {
        const taskLock = path.join(fixture.bundleRoot, 'runtime', 'task-events', '.T-LOCK.lock');
        const reviewLock = path.join(fixture.bundleRoot, 'runtime', 'reviews', 'T-LOCK-code.md.lock');
        const finalizationLock = path.join(fixture.bundleRoot, 'runtime', 'reviews', 'T-LOCK-completion-gate.lock');
        writeStaleLock(taskLock);
        writeStaleLock(reviewLock);
        writeStaleLock(finalizationLock);

        const inspectOnly = runRepairLocks(fixture.root, { cleanupStale: false, confirm: false });
        assert.equal(inspectOnly.cleanup_requested, false);
        assert.equal(inspectOnly.task_event_stale, 1);
        assert.equal(inspectOnly.review_artifact_stale, 1);
        assert.equal(inspectOnly.completion_finalization_stale, 1);
        assert.equal(fs.existsSync(taskLock), true);
        assert.equal(fs.existsSync(reviewLock), true);
        assert.equal(fs.existsSync(finalizationLock), true);

        const dryRun = runRepairLocks(fixture.root, { cleanupStale: true, confirm: false });
        assert.equal(dryRun.cleanup_requested, true);
        assert.equal(dryRun.dryRun, true);
        assert.deepEqual(dryRun.removed_task_event_locks, []);
        assert.deepEqual(dryRun.removed_review_artifact_locks, []);
        assert.equal(fs.existsSync(taskLock), true);
        assert.equal(fs.existsSync(reviewLock), true);
        assert.equal(fs.existsSync(finalizationLock), true);

        const applied = runRepairLocks(fixture.root, { cleanupStale: true, confirm: true });
        assert.equal(applied.dryRun, false);
        assert.deepEqual(applied.removed_task_event_locks, ['.T-LOCK.lock']);
        assert.deepEqual(applied.removed_review_artifact_locks, ['T-LOCK-code.md.lock']);
        assert.equal(fs.existsSync(taskLock), false);
        assert.equal(fs.existsSync(reviewLock), false);
        assert.equal(fs.existsSync(finalizationLock), true);
    } finally {
        fixture.cleanup();
    }
});

test('repair CLI defaults to inspect and rejects unknown actions', () => {
    const fixture = makeRepairFixture();
    try {
        const output = captureStdout(() => {
            handleRepair(['--target-root', fixture.root, '--json'], { name: 'garda', version: '1.2.3' });
        });
        const parsed = JSON.parse(output);
        assert.equal(parsed.targetRoot, path.resolve(fixture.root));
        assert.match(parsed.canonical_state.task_events, /runtime\/task-events\/<task-id>\.jsonl$/);

        assert.throws(
            () => handleRepair(['unknown-action', '--target-root', fixture.root, '--json'], { name: 'garda', version: '1.2.3' }),
            /Unknown repair action: unknown-action/
        );
    } finally {
        fixture.cleanup();
    }
});

test('repair rebuild-indexes is dry-run by default and rebuilds only with confirm', () => {
    const fixture = makeRepairFixture();
    try {
        const eventsRoot = path.join(fixture.bundleRoot, 'runtime', 'task-events');
        const reviewsRoot = path.join(fixture.bundleRoot, 'runtime', 'reviews');
        const timelineSummaryPath = path.join(eventsRoot, '.timeline-summary.json');
        const reviewsIndexPath = path.join(reviewsRoot, 'reviews-index.json');

        const dryRun = runRepairRebuildIndexes(fixture.root, false);
        assert.equal(dryRun.dryRun, true);
        assert.equal(fs.existsSync(timelineSummaryPath), false);
        assert.equal(fs.existsSync(reviewsIndexPath), false);

        const applied = runRepairRebuildIndexes(fixture.root, true);
        assert.equal(applied.dryRun, false);
        assert.equal(applied.timeline_summary_failed_tasks.length, 0);
        assert.equal(fs.existsSync(timelineSummaryPath), true);
        assert.equal(fs.existsSync(reviewsIndexPath), true);
        assert.equal(applied.reviews_index_status, 'updated');
    } finally {
        fixture.cleanup();
    }
});

test('repair protected-manifest previews before writing trusted manifest', () => {
    const fixture = makeRepairFixture();
    try {
        const manifestPath = path.join(fixture.bundleRoot, 'runtime', 'protected-control-plane-manifest.json');

        const dryRun = runRepairProtectedManifest(fixture.root, false);
        assert.equal(dryRun.dryRun, true);
        assert.equal(dryRun.written, false);
        assert.equal(fs.existsSync(manifestPath), false);

        const applied = runRepairProtectedManifest(fixture.root, true);
        assert.equal(applied.dryRun, false);
        assert.equal(applied.written, true);
        assert.equal(fs.existsSync(manifestPath), true);
    } finally {
        fixture.cleanup();
    }
});
