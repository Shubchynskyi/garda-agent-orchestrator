import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    abortRuntimeMutationGeneration,
    beginRuntimeMutationGeneration,
    commitRuntimeMutationGeneration,
    readRuntimeMutationGeneration,
    RuntimeMutationGenerationError,
    withRuntimeMutationGeneration
} from '../../../src/gate-runtime/runtime-mutation-generation';
import {
    getReviewArtifactLockPath,
    writeReviewArtifactsWithRollback,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review/review-artifacts';
import { resolveIndexLockPath } from '../../../src/gate-runtime/review/reviews-index';
import {
    appendTaskEvent,
    appendTaskEventAsync
} from '../../../src/gate-runtime/timeline/task-events';

const mutableTaskEventIoWrite = require('../../../src/gate-runtime/timeline/task-events-io-write') as {
    appendTaskEventLineSync: typeof import('../../../src/gate-runtime/timeline/task-events-io-write').appendTaskEventLineSync;
    appendTaskEventLineAsync: typeof import('../../../src/gate-runtime/timeline/task-events-io-write').appendTaskEventLineAsync;
};

function createTempRoot(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function generationDirectory(root: string): string {
    return path.join(root, 'runtime', '.runtime-mutation-generation');
}

function generationHeadPath(root: string): string {
    return path.join(generationDirectory(root), 'head.json');
}

function generationAnchorPath(root: string): string {
    return path.join(root, 'runtime', '.runtime-mutation-generation.anchor.json');
}

function resolveGenerationModulePath(): string {
    return path.resolve(__dirname, '../../../src/gate-runtime/runtime-mutation-generation.js');
}

function runGenerationWorker(
    modulePath: string,
    root: string,
    startSignalPath: string,
    mutationCount: number
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const workerScript = [
            "const fs = require('node:fs');",
            "const { withRuntimeMutationGeneration } = require(process.argv[1]);",
            'const root = process.argv[2];',
            'const startSignalPath = process.argv[3];',
            'const mutationCount = Number.parseInt(process.argv[4], 10);',
            'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
            'while (!fs.existsSync(startSignalPath)) { Atomics.wait(sleeper, 0, 0, 2); }',
            'for (let index = 0; index < mutationCount; index += 1) {',
            "  withRuntimeMutationGeneration(root, 'contention-test', () => undefined);",
            '}'
        ].join('\n');
        const child = spawn(process.execPath, [
            '--input-type=commonjs',
            '--eval',
            workerScript,
            modulePath,
            root,
            startSignalPath,
            String(mutationCount)
        ], {
            stdio: ['ignore', 'ignore', 'pipe']
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });
        child.once('error', reject);
        child.once('close', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `generation worker exited with code ${code}`));
        });
    });
}

test('runtime mutation generation fails closed when missing and while a mutation is active', () => {
    const root = createTempRoot('garda-runtime-generation-state-');
    try {
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        const ticket = beginRuntimeMutationGeneration(root, 'test-write');
        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
        );
        const afterAbort = abortRuntimeMutationGeneration(ticket);
        assert.equal(afterAbort.generation, 0);
        assert.equal(readRuntimeMutationGeneration(root).generation, 0);

        const committedTicket = beginRuntimeMutationGeneration(root, 'test-write');
        const afterCommit = commitRuntimeMutationGeneration(committedTicket);
        assert.equal(afterCommit.generation, 1);
        assert.equal(readRuntimeMutationGeneration(root).generation, 1);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('failed runtime mutation callbacks do not advance generation', () => {
    const root = createTempRoot('garda-runtime-generation-failure-');
    try {
        assert.throws(
            () => withRuntimeMutationGeneration(root, 'failed-write', () => {
                throw new Error('injected write failure');
            }),
            /injected write failure/
        );
        const snapshot = readRuntimeMutationGeneration(root);
        assert.equal(snapshot.generation, 0);
        assert.equal(snapshot.transition_sequence, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation recovers an interrupted BEGIN before head or anchor publication', () => {
    for (const interruptionPoint of ['before-head', 'before-anchor'] as const) {
        const root = createTempRoot(`garda-runtime-generation-${interruptionPoint}-`);
        try {
            withRuntimeMutationGeneration(root, 'seed', () => undefined);
            const committedHead = fs.readFileSync(generationHeadPath(root), 'utf8');
            const committedAnchor = fs.readFileSync(generationAnchorPath(root), 'utf8');

            beginRuntimeMutationGeneration(root, `interrupted-${interruptionPoint}`);
            if (interruptionPoint === 'before-head') {
                fs.writeFileSync(generationHeadPath(root), committedHead, 'utf8');
            }
            fs.writeFileSync(generationAnchorPath(root), committedAnchor, 'utf8');

            const recovered = readRuntimeMutationGeneration(root);
            assert.equal(recovered.generation, 1);
            assert.equal(recovered.transition_sequence, 2);

            withRuntimeMutationGeneration(root, 'after-recovery', () => undefined);
            const afterRecovery = readRuntimeMutationGeneration(root);
            assert.equal(afterRecovery.generation, 2);
            assert.equal(afterRecovery.transition_sequence, 4);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    }
});

test('runtime mutation generation fails closed after all journal files are removed', () => {
    const root = createTempRoot('garda-runtime-generation-removed-');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        for (const fileName of fs.readdirSync(generationDirectory(root))) {
            fs.rmSync(path.join(generationDirectory(root), fileName));
        }

        assert.throws(
            () => readRuntimeMutationGeneration(root),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
        assert.throws(
            () => beginRuntimeMutationGeneration(root, 'must-not-reinitialize'),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
        assert.deepEqual(fs.readdirSync(generationDirectory(root)), []);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('runtime mutation generation rejects corrupt, rolled-back, missing-anchor, and symlinked journal state', () => {
    const corruptRoot = createTempRoot('garda-runtime-generation-corrupt-');
    const rollbackRoot = createTempRoot('garda-runtime-generation-rollback-');
    const completeRollbackRoot = createTempRoot('garda-runtime-generation-complete-rollback-');
    const missingAnchorRoot = createTempRoot('garda-runtime-generation-missing-anchor-');
    const symlinkRoot = createTempRoot('garda-runtime-generation-symlink-');
    try {
        withRuntimeMutationGeneration(corruptRoot, 'seed', () => undefined);
        fs.writeFileSync(generationHeadPath(corruptRoot), '{invalid-json\n', 'utf8');
        assert.throws(
            () => readRuntimeMutationGeneration(corruptRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        const rollbackTicket = beginRuntimeMutationGeneration(rollbackRoot, 'seed');
        const previousHead = fs.readFileSync(generationHeadPath(rollbackRoot), 'utf8');
        commitRuntimeMutationGeneration(rollbackTicket);
        fs.writeFileSync(generationHeadPath(rollbackRoot), previousHead, 'utf8');
        assert.throws(
            () => readRuntimeMutationGeneration(rollbackRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        withRuntimeMutationGeneration(completeRollbackRoot, 'first-snapshot', () => undefined);
        const completeSnapshot = new Map(
            fs.readdirSync(generationDirectory(completeRollbackRoot)).map((fileName): [string, string] => [
                fileName,
                fs.readFileSync(path.join(generationDirectory(completeRollbackRoot), fileName), 'utf8')
            ])
        );
        withRuntimeMutationGeneration(completeRollbackRoot, 'newer-snapshot', () => undefined);
        for (const [fileName, content] of completeSnapshot) {
            fs.writeFileSync(path.join(generationDirectory(completeRollbackRoot), fileName), content, 'utf8');
        }
        assert.throws(
            () => readRuntimeMutationGeneration(completeRollbackRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );

        withRuntimeMutationGeneration(missingAnchorRoot, 'seed', () => undefined);
        fs.rmSync(generationAnchorPath(missingAnchorRoot));
        assert.throws(
            () => readRuntimeMutationGeneration(missingAnchorRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        withRuntimeMutationGeneration(symlinkRoot, 'seed', () => undefined);
        const journalDirectory = generationDirectory(symlinkRoot);
        const realJournalDirectory = `${journalDirectory}-target`;
        fs.renameSync(journalDirectory, realJournalDirectory);
        fs.symlinkSync(realJournalDirectory, journalDirectory, 'junction');
        assert.throws(
            () => readRuntimeMutationGeneration(symlinkRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'CORRUPT'
        );
    } finally {
        fs.rmSync(corruptRoot, { recursive: true, force: true });
        fs.rmSync(rollbackRoot, { recursive: true, force: true });
        fs.rmSync(completeRollbackRoot, { recursive: true, force: true });
        fs.rmSync(missingAnchorRoot, { recursive: true, force: true });
        fs.rmSync(symlinkRoot, { recursive: true, force: true });
    }
});

test('runtime mutation generation preserves every concurrent process commit', async () => {
    const root = createTempRoot('garda-runtime-generation-contention-');
    const startSignalPath = path.join(root, 'start.signal');
    const workerCount = 4;
    const mutationsPerWorker = 6;
    try {
        const workers = Array.from({ length: workerCount }, () => runGenerationWorker(
            resolveGenerationModulePath(),
            root,
            startSignalPath,
            mutationsPerWorker
        ));
        fs.writeFileSync(startSignalPath, 'start\n', 'utf8');
        await Promise.all(workers);

        const snapshot = readRuntimeMutationGeneration(root);
        assert.equal(snapshot.generation, workerCount * mutationsPerWorker);
        assert.equal(snapshot.transition_sequence, workerCount * mutationsPerWorker * 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('task-event and nested review-artifact writers advance the shared generation', () => {
    const root = createTempRoot('garda-runtime-generation-writers-');
    try {
        const appendResult = appendTaskEvent(
            root,
            'T-GENERATION',
            'test',
            'PASS',
            'generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(appendResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(root).generation, 1);

        const nestedReviewPath = path.join(root, 'runtime', 'reviews', 'nested', 'T-GENERATION-code.md');
        writeReviewArtifactText(nestedReviewPath, 'CODE REVIEW PASSED\n');
        assert.equal(readRuntimeMutationGeneration(root).generation, 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('custom task-event roots advance the journal that owns the canonical event tree', async () => {
    const repoRoot = createTempRoot('garda-runtime-generation-custom-event-repo-');
    const eventOwnerRoot = createTempRoot('garda-runtime-generation-custom-event-owner-');
    const eventsRoot = path.join(eventOwnerRoot, 'runtime', 'task-events');
    try {
        const syncResult = appendTaskEvent(
            repoRoot,
            'T-GENERATION-CUSTOM-SYNC',
            'test',
            'PASS',
            'custom event-root sync integration test',
            null,
            { eventsRoot, passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(syncResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(eventOwnerRoot).generation, 1);
        assert.throws(
            () => readRuntimeMutationGeneration(repoRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );

        const asyncResult = await appendTaskEventAsync(
            repoRoot,
            'T-GENERATION-CUSTOM-ASYNC',
            'test',
            'PASS',
            'custom event-root async integration test',
            null,
            { eventsRoot, passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(asyncResult?.canonical_committed, true);
        assert.equal(readRuntimeMutationGeneration(eventOwnerRoot).generation, 2);
        assert.throws(
            () => readRuntimeMutationGeneration(repoRoot),
            (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'MISSING'
        );
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(eventOwnerRoot, { recursive: true, force: true });
    }
});

test('async task-event writes commit once and abort cleanly after canonical append failure', async () => {
    const root = createTempRoot('garda-runtime-generation-async-events-');
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    try {
        const success = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC',
            'test',
            'PASS',
            'async generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(success?.canonical_committed, true);
        const afterSuccess = readRuntimeMutationGeneration(root);
        assert.equal(afterSuccess.generation, 1);

        fs.mkdirSync(path.join(eventsRoot, 'T-GENERATION-ASYNC-FAIL.jsonl'));
        const failure = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC-FAIL',
            'test',
            'FAIL',
            'injected canonical append failure',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );

        assert.equal(failure?.canonical_committed, false);
        assert.equal(failure?.warnings.length, 1);
        assert.match(failure?.warnings[0] ?? '', /task-event append failed/i);
        const afterFailure = readRuntimeMutationGeneration(root);
        assert.equal(afterFailure.generation, afterSuccess.generation);
        assert.equal(afterFailure.transition_sequence, afterSuccess.transition_sequence + 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('sync task-event writes abort cleanly after canonical append failure', () => {
    const root = createTempRoot('garda-runtime-generation-sync-events-');
    const eventsRoot = path.join(root, 'runtime', 'task-events');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(path.join(eventsRoot, 'T-GENERATION-SYNC-FAIL.jsonl'), { recursive: true });

        const failure = appendTaskEvent(
            root,
            'T-GENERATION-SYNC-FAIL',
            'test',
            'FAIL',
            'injected synchronous canonical append failure',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );

        assert.equal(failure?.canonical_committed, false);
        assert.equal(failure?.warnings.length, 1);
        assert.match(failure?.warnings[0] ?? '', /task-event append failed/i);
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(after.transition_sequence, before.transition_sequence + 2);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('task-event writers commit generation after post-canonical processing failure', async () => {
    const root = createTempRoot('garda-runtime-generation-post-canonical-events-');
    const originalSync = mutableTaskEventIoWrite.appendTaskEventLineSync;
    const originalAsync = mutableTaskEventIoWrite.appendTaskEventLineAsync;
    try {
        mutableTaskEventIoWrite.appendTaskEventLineSync = (...args) => {
            originalSync(...args);
            throw new Error('injected sync post-canonical processing failure');
        };
        const syncResult = appendTaskEvent(
            root,
            'T-GENERATION-SYNC-POST-CANONICAL',
            'test',
            'PASS',
            'sync post-canonical generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(syncResult?.canonical_committed, true);
        assert.equal(syncResult?.commit_status, 'committed_with_derived_index_failure');
        assert.match(syncResult?.derived_warnings[0] ?? '', /post-canonical processing failure/i);
        const afterSync = readRuntimeMutationGeneration(root);
        assert.equal(afterSync.generation, 1);

        mutableTaskEventIoWrite.appendTaskEventLineSync = originalSync;
        mutableTaskEventIoWrite.appendTaskEventLineAsync = async (...args) => {
            await originalAsync(...args);
            throw new Error('injected async post-canonical processing failure');
        };
        const asyncResult = await appendTaskEventAsync(
            root,
            'T-GENERATION-ASYNC-POST-CANONICAL',
            'test',
            'PASS',
            'async post-canonical generation integration test',
            null,
            { passThru: true, lowNoiseRuntimeWrites: true }
        );
        assert.equal(asyncResult?.canonical_committed, true);
        assert.equal(asyncResult?.commit_status, 'committed_with_derived_index_failure');
        assert.match(asyncResult?.derived_warnings[0] ?? '', /post-canonical processing failure/i);
        const afterAsync = readRuntimeMutationGeneration(root);
        assert.equal(afterAsync.generation, afterSync.generation + 1);
    } finally {
        mutableTaskEventIoWrite.appendTaskEventLineSync = originalSync;
        mutableTaskEventIoWrite.appendTaskEventLineAsync = originalAsync;
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a failed review-artifact write aborts without publishing a generation', () => {
    const root = createTempRoot('garda-runtime-generation-review-failure-');
    const reviewPath = path.join(root, 'runtime', 'reviews', 'T-FAILED-code.md');
    const lockPath = getReviewArtifactLockPath(reviewPath);
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }), 'utf8');

        assert.throws(
            () => writeReviewArtifactText(reviewPath, 'SHOULD NOT PERSIST\n', {
                lockTimeoutMs: 25,
                lockRetryMs: 2
            }),
            /file lock/
        );
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(fs.existsSync(reviewPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('a required review-index failure restores the artifact and aborts its generation', () => {
    const root = createTempRoot('garda-runtime-generation-review-index-failure-');
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    const reviewPath = path.join(reviewsDir, 'T-FAILED-INDEX-code.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);
    try {
        fs.mkdirSync(reviewsDir, { recursive: true });
        fs.writeFileSync(reviewPath, 'ORIGINAL REVIEW\n', 'utf8');
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const before = readRuntimeMutationGeneration(root);
        fs.mkdirSync(indexLockPath, { recursive: true });
        fs.writeFileSync(path.join(indexLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }), 'utf8');

        assert.throws(
            () => writeReviewArtifactText(reviewPath, 'SHOULD ROLL BACK\n', {
                lockTimeoutMs: 25,
                lockRetryMs: 2,
                requireIndexUpdate: true
            }),
            /Review artifact index update failed/
        );
        const after = readRuntimeMutationGeneration(root);
        assert.equal(after.generation, before.generation);
        assert.equal(after.transition_sequence, before.transition_sequence + 2);
        assert.equal(fs.readFileSync(reviewPath, 'utf8'), 'ORIGINAL REVIEW\n');
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});

test('review-artifact transactions commit one generation and abort cleanly after rollback', async () => {
    const root = createTempRoot('garda-runtime-generation-review-transaction-');
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    const existingPath = path.join(reviewsDir, 'T-TRANSACTION-code.md');
    const newPath = path.join(reviewsDir, 'T-TRANSACTION-test.md');
    try {
        withRuntimeMutationGeneration(root, 'seed', () => undefined);
        const beforeCommit = readRuntimeMutationGeneration(root);

        const callbackResult = await writeReviewArtifactsWithRollback([
            {
                artifactPath: existingPath,
                contentType: 'text',
                content: 'COMMITTED REVIEW\n'
            }
        ], async () => {
            assert.throws(
                () => readRuntimeMutationGeneration(root),
                (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
            );
            return 'committed';
        });
        assert.equal(callbackResult, 'committed');
        const afterCommit = readRuntimeMutationGeneration(root);
        assert.equal(afterCommit.generation, beforeCommit.generation + 1);
        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'COMMITTED REVIEW\n');

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: existingPath,
                    contentType: 'text',
                    content: 'ROLLED BACK REVIEW\n'
                },
                {
                    artifactPath: newPath,
                    contentType: 'text',
                    content: 'ROLLED BACK TEST REVIEW\n'
                }
            ], async () => {
                assert.throws(
                    () => readRuntimeMutationGeneration(root),
                    (error: unknown) => error instanceof RuntimeMutationGenerationError && error.code === 'BUSY'
                );
                throw new Error('injected transaction callback failure');
            }),
            /injected transaction callback failure/
        );
        const afterRollback = readRuntimeMutationGeneration(root);
        assert.equal(afterRollback.generation, afterCommit.generation);
        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'COMMITTED REVIEW\n');
        assert.equal(fs.existsSync(newPath), false);
    } finally {
        fs.rmSync(root, { recursive: true, force: true });
    }
});
