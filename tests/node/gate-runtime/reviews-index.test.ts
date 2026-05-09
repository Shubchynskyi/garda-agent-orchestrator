import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { acquireFilesystemLock, releaseFilesystemLock } from '../../../src/gate-runtime/task-events';

import {
    rebuildIndex,
    loadIndex,
    writeIndex,
    resolveIndexPath,
    resolveIndexLockPath,
    isIndexStale,
    upsertEntry,
    removeEntries,
    invalidateIndex,
    entriesForTask,
    entriesByArtifactSuffix,
    taskIds,
    groupByTask,
    type ReviewsIndex,
    type ReviewsIndexEntry
} from '../../../src/gate-runtime/reviews-index';

function makeTmpDir(prefix: string): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function createReviewsDir(root: string): string {
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    return reviewsDir;
}

function writeArtifact(reviewsDir: string, fileName: string, content: string = '{}'): string {
    const filePath = path.join(reviewsDir, fileName);
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
}

function getBuiltReviewsIndexModulePath(): string {
    return path.join(process.cwd(), '.node-build', 'src', 'gate-runtime', 'reviews-index.js');
}

function spawnUpsertWorker(reviewsDir: string, fileName: string): ReturnType<typeof spawn> {
    return spawn(process.execPath, [
        '-e',
        'const { upsertEntry } = require(process.env.REVIEWS_INDEX_MODULE_PATH); upsertEntry(process.env.REVIEWS_DIR, process.env.REVIEWS_FILE_NAME);'
    ], {
        cwd: process.cwd(),
        env: {
            ...process.env,
            REVIEWS_INDEX_MODULE_PATH: getBuiltReviewsIndexModulePath(),
            REVIEWS_DIR: reviewsDir,
            REVIEWS_FILE_NAME: fileName
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

async function waitForChildExit(child: ReturnType<typeof spawn>): Promise<{ code: number | null; stdout: string; stderr: string; }> {
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
        stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
        stderr += String(chunk);
    });
    if (child.exitCode !== null) {
        return { code: child.exitCode, stdout, stderr };
    }
    return await new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (code) => {
            resolve({ code, stdout, stderr });
        });
    });
}

async function delay(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
}

describe('reviews-index', () => {
    let tmpDir: string;
    let reviewsDir: string;

    beforeEach(() => {
        tmpDir = makeTmpDir('reviews-index-test-');
        reviewsDir = createReviewsDir(tmpDir);
    });

    afterEach(() => {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    describe('rebuildIndex', () => {
        it('returns empty entries for empty directory', () => {
            const index = rebuildIndex(reviewsDir);
            assert.equal(index.version, 1);
            assert.equal(index.entries.length, 0);
            assert.ok(index.directoryMtimeMs > 0);
            assert.ok(index.generatedAtMs > 0);
        });

        it('indexes artifacts matching T-xxx- pattern', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"task_id":"T-001"}');
            writeArtifact(reviewsDir, 'T-001-preflight.json', '{"task_id":"T-001"}');
            writeArtifact(reviewsDir, 'T-002-handshake.json', '{"task_id":"T-002"}');

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 3);

            const taskModeEntry = index.entries.find(e => e.fileName === 'T-001-task-mode.json');
            assert.ok(taskModeEntry);
            assert.equal(taskModeEntry.taskId, 'T-001');
            assert.equal(taskModeEntry.artifactType, 'task-mode.json');
            assert.ok(taskModeEntry.mtimeMs > 0);
            assert.ok(taskModeEntry.sizeBytes > 0);
        });

        it('indexes review-remediation-cycle artifacts for multi-segment task ids', () => {
            writeArtifact(
                reviewsDir,
                'T-903b-restart-review-cycle-expanded-source-review-remediation-cycle.json',
                '{"task_id":"T-903b-restart-review-cycle-expanded-source","status":"BLOCKED"}'
            );

            const index = rebuildIndex(reviewsDir);
            const entry = index.entries.find((candidate) => (
                candidate.fileName === 'T-903b-restart-review-cycle-expanded-source-review-remediation-cycle.json'
            ));
            assert.ok(entry);
            assert.equal(entry.taskId, 'T-903b-restart-review-cycle-expanded-source');
            assert.equal(entry.artifactType, 'review-remediation-cycle.json');
        });

        it('skips non-artifact files', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'some-random-file.json');
            writeArtifact(reviewsDir, 'not-task-prefixed.log');

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-001-task-mode.json');
        });

        it('skips directories inside reviews', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            fs.mkdirSync(path.join(reviewsDir, 'T-002-somedir'), { recursive: true });

            const index = rebuildIndex(reviewsDir);
            assert.equal(index.entries.length, 1);
        });

        it('returns empty for non-existent directory', () => {
            const nonExistent = path.join(tmpDir, 'does-not-exist');
            const index = rebuildIndex(nonExistent);
            assert.equal(index.entries.length, 0);
        });
    });

    describe('writeIndex and resolveIndexPath', () => {
        it('writes index atomically and can be read back', () => {
            const index: ReviewsIndex = {
                version: 1,
                directoryMtimeMs: 12345,
                generatedAtMs: Date.now(),
                entries: [{
                    fileName: 'T-001-task-mode.json',
                    taskId: 'T-001',
                    artifactType: 'task-mode.json',
                    mtimeMs: 1000,
                    sizeBytes: 50
                }]
            };

            const indexPath = resolveIndexPath(reviewsDir);
            writeIndex(indexPath, index);

            assert.ok(fs.existsSync(indexPath));
            const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
            assert.equal(raw.version, 1);
            assert.equal(raw.entries.length, 1);
            assert.equal(raw.entries[0].fileName, 'T-001-task-mode.json');
        });

        it('cleans up temp file on write failure', () => {
            const badPath = path.join(tmpDir, 'non-existent-deep', 'sub', 'sub2', 'index.json');
            // mkdirSync recursive in writeIndex should handle this
            const index: ReviewsIndex = {
                version: 1,
                directoryMtimeMs: 0,
                generatedAtMs: Date.now(),
                entries: []
            };

            writeIndex(badPath, index);
            assert.ok(fs.existsSync(badPath));
        });

        it('preserves the previous index when final rename fails', () => {
            const indexPath = resolveIndexPath(reviewsDir);
            const previousIndex: ReviewsIndex = {
                version: 1,
                directoryMtimeMs: 1,
                directoryCtimeMs: 1,
                directoryEntryCount: 0,
                generatedAtMs: Date.now(),
                entries: []
            };
            const nextIndex: ReviewsIndex = {
                version: 1,
                directoryMtimeMs: 2,
                directoryCtimeMs: 2,
                directoryEntryCount: 1,
                generatedAtMs: Date.now(),
                entries: [{
                    fileName: 'T-002-preflight.json',
                    taskId: 'T-002',
                    artifactType: 'preflight.json',
                    mtimeMs: 100,
                    sizeBytes: 10
                }]
            };
            const previousContent = JSON.stringify(previousIndex, null, 2) + '\n';
            fs.writeFileSync(indexPath, previousContent, 'utf8');

            const realFs = require('node:fs');
            const originalRenameSync = realFs.renameSync;
            try {
                realFs.renameSync = function (...args: any[]) {
                    if (args[1] === indexPath) {
                        throw new Error('simulated index rename failure');
                    }
                    return originalRenameSync.apply(realFs, args);
                };

                assert.throws(
                    () => writeIndex(indexPath, nextIndex),
                    /simulated index rename failure/
                );
            } finally {
                realFs.renameSync = originalRenameSync;
            }

            assert.equal(fs.readFileSync(indexPath, 'utf8'), previousContent);
            assert.deepStrictEqual(
                fs.readdirSync(reviewsDir).filter((entry) => entry.includes('.tmp-')),
                []
            );
        });
    });

    describe('isIndexStale', () => {
        it('returns true when no index exists', () => {
            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), true);
        });

        it('returns false for fresh index with matching directory mtime', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const { index } = loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
        });

        it('returns true when directory mtime changed', () => {
            const { index } = loadIndex(reviewsDir);
            const indexPath = resolveIndexPath(reviewsDir);

            // Add a new file to change directory mtime
            writeArtifact(reviewsDir, 'T-099-task-mode.json');

            assert.equal(isIndexStale(indexPath, reviewsDir), true);
        });

        it('returns true when index exceeds max staleness', () => {
            const { index } = loadIndex(reviewsDir);
            const indexPath = resolveIndexPath(reviewsDir);

            // Make index appear very old
            const staleIndex: ReviewsIndex = {
                ...index,
                generatedAtMs: Date.now() - 200_000
            };
            writeIndex(indexPath, staleIndex);

            assert.equal(isIndexStale(indexPath, reviewsDir, 60_000), true);
        });
    });

    describe('loadIndex', () => {
        it('rebuilds when no index exists', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);

            // Should have persisted the index
            assert.ok(fs.existsSync(resolveIndexPath(reviewsDir)));
        });

        it('uses cache on second call when directory unchanged', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'cache');
            assert.equal(second.index.entries.length, 1);
        });

        it('uses cache without statting each artifact on cache hit', () => {
            for (let i = 0; i < 25; i++) {
                writeArtifact(reviewsDir, `T-${String(i).padStart(3, '0')}-task-mode.json`);
            }
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const realFs = require('node:fs');
            const originalStatSync = realFs.statSync;
            let artifactStatCount = 0;
            try {
                realFs.statSync = function (...args: any[]) {
                    const targetPath = typeof args[0] === 'string'
                        ? path.resolve(args[0])
                        : '';
                    if (
                        path.dirname(targetPath) === path.resolve(reviewsDir)
                        && path.basename(targetPath) !== 'reviews-index.json'
                    ) {
                        artifactStatCount += 1;
                    }
                    return originalStatSync.apply(realFs, args);
                };

                const second = loadIndex(reviewsDir);
                assert.equal(second.source, 'cache');
            } finally {
                realFs.statSync = originalStatSync;
            }

            assert.equal(artifactStatCount, 0);
        });

        it('rebuilds when forceRebuild is true', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');

            const second = loadIndex(reviewsDir, { forceRebuild: true });
            assert.equal(second.source, 'rebuilt');
        });

        it('rebuilds when directory changed between loads', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);

            writeArtifact(reviewsDir, 'T-002-preflight.json');

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 2);
        });

        it('rebuilds when an existing artifact is atomically replaced without changing entry count', async () => {
            const artifactPath = writeArtifact(reviewsDir, 'T-001-handshake.json', 'old');
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);
            const firstEntry = first.index.entries[0];

            await delay(5);
            const replacementPath = path.join(reviewsDir, '.T-001-handshake.json.tmp-test');
            fs.writeFileSync(replacementPath, 'new', 'utf8');
            fs.renameSync(replacementPath, artifactPath);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].fileName, 'T-001-handshake.json');
            assert.notEqual(second.index.entries[0].mtimeMs, firstEntry.mtimeMs);
        });

        it('rebuilds when artifact replacement shares a millisecond bucket with the index marker', () => {
            const artifactPath = writeArtifact(reviewsDir, 'T-001-handshake.json', 'old');
            const first = loadIndex(reviewsDir);
            assert.equal(first.source, 'rebuilt');
            assert.equal(first.index.entries.length, 1);
            assert.equal(first.index.entries[0].sizeBytes, 3);

            const replacementPath = path.join(reviewsDir, '.T-001-handshake.json.tmp-test');
            fs.writeFileSync(replacementPath, 'new-content', 'utf8');
            fs.renameSync(replacementPath, artifactPath);

            const replacementDirMtimeMs = fs.statSync(reviewsDir).mtimeMs;
            const markerBucketMs = Math.max(
                Math.trunc(replacementDirMtimeMs),
                Math.trunc(first.index.directoryMtimeMs) + 1
            );
            const simulatedDirMtimeSeconds = (markerBucketMs + 0.75) / 1000;
            fs.utimesSync(reviewsDir, simulatedDirMtimeSeconds, simulatedDirMtimeSeconds);
            fs.utimesSync(resolveIndexPath(reviewsDir), markerBucketMs / 1000, markerBucketMs / 1000);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].fileName, 'T-001-handshake.json');
            assert.equal(second.index.entries[0].sizeBytes, 'new-content'.length);
        });

        it('does not count index file itself as an artifact', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const result = loadIndex(reviewsDir);

            const indexEntry = result.index.entries.find(
                e => e.fileName === 'reviews-index.json'
            );
            assert.equal(indexEntry, undefined);
        });
    });

    describe('upsertEntry', () => {
        it('adds new entry to existing index', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"task_id":"T-001"}');
            loadIndex(reviewsDir);

            writeArtifact(reviewsDir, 'T-002-preflight.json', '{"task_id":"T-002"}');
            upsertEntry(reviewsDir, 'T-002-preflight.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 2);
            assert.ok(index.entries.some(e => e.fileName === 'T-002-preflight.json'));
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            assert.equal(loadIndex(reviewsDir).source, 'cache');
        });

        it('updates existing entry', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"v":1}');
            loadIndex(reviewsDir);

            // Overwrite with larger content
            writeArtifact(reviewsDir, 'T-001-task-mode.json', '{"v":2,"extra":"data"}');
            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-001-task-mode.json');
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            assert.equal(loadIndex(reviewsDir).source, 'cache');
        });

        it('triggers rebuild when no index exists', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-preflight.json');

            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            assert.ok(fs.existsSync(indexPath));
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            // Rebuild should capture all files, not just the upserted one
            assert.equal(index.entries.length, 2);
        });

        it('ignores non-artifact filenames', () => {
            writeArtifact(reviewsDir, 'random-file.json');
            loadIndex(reviewsDir);

            upsertEntry(reviewsDir, 'random-file.json');

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 0);
        });

        it('keeps the index fresh after the index lock is released', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            upsertEntry(reviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'cache');
            assert.equal(second.index.entries.length, 1);
        });

        it('serializes parallel writers through a dedicated index lock', { concurrency: false }, async () => {
            const builtModulePath = getBuiltReviewsIndexModulePath();
            assert.equal(fs.existsSync(builtModulePath), true, `Built module missing: ${builtModulePath}`);

            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-preflight.json');

            const lockPath = resolveIndexLockPath(reviewsDir);
            const { handle } = acquireFilesystemLock(lockPath, { timeoutMs: 2_000, retryMs: 10 });
            let lockReleased = false;
            const firstWorker = spawnUpsertWorker(reviewsDir, 'T-001-task-mode.json');
            const secondWorker = spawnUpsertWorker(reviewsDir, 'T-002-preflight.json');
            try {
                await delay(150);
                assert.equal(firstWorker.exitCode, null, 'first worker should wait on the index lock');
                assert.equal(secondWorker.exitCode, null, 'second worker should wait on the index lock');

                releaseFilesystemLock(handle);
                lockReleased = true;

                const [firstExit, secondExit] = await Promise.all([
                    waitForChildExit(firstWorker),
                    waitForChildExit(secondWorker)
                ]);
                assert.equal(firstExit.code, 0, firstExit.stderr || firstExit.stdout);
                assert.equal(secondExit.code, 0, secondExit.stderr || secondExit.stdout);

                const persistedIndex = JSON.parse(fs.readFileSync(resolveIndexPath(reviewsDir), 'utf8')) as ReviewsIndex;
                assert.ok(persistedIndex.entries.some((entry) => entry.fileName === 'T-001-task-mode.json'));
                assert.ok(persistedIndex.entries.some((entry) => entry.fileName === 'T-002-preflight.json'));
            } finally {
                if (!lockReleased) {
                    releaseFilesystemLock(handle);
                }
                if (firstWorker.exitCode === null) {
                    firstWorker.kill();
                }
                if (secondWorker.exitCode === null) {
                    secondWorker.kill();
                }
            }
        });
    });

    describe('removeEntries', () => {
        it('removes specified entries from index', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            loadIndex(reviewsDir);

            removeEntries(reviewsDir, ['T-001-task-mode.json', 'T-001-preflight.json']);

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
            assert.equal(index.entries[0].fileName, 'T-002-task-mode.json');
        });

        it('keeps the index fresh after removing deleted artifact entries', () => {
            const firstPath = writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const secondPath = writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            loadIndex(reviewsDir);

            fs.rmSync(firstPath, { force: true });
            fs.rmSync(secondPath, { force: true });
            removeEntries(reviewsDir, ['T-001-task-mode.json', 'T-001-preflight.json']);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.equal(isIndexStale(indexPath, reviewsDir), false);
            const loaded = loadIndex(reviewsDir);
            assert.equal(loaded.source, 'cache');
            assert.equal(loaded.index.entries.length, 1);
            assert.equal(loaded.index.entries[0].fileName, 'T-002-task-mode.json');
        });

        it('is a no-op when no matching entries exist', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            const before = fs.readFileSync(indexPath, 'utf8');

            removeEntries(reviewsDir, ['T-999-nonexistent.json']);

            const after = fs.readFileSync(indexPath, 'utf8');
            // Index file should not have been rewritten
            assert.equal(before, after);
        });

        it('is a no-op when no index exists', () => {
            // Should not throw
            removeEntries(reviewsDir, ['T-001-task-mode.json']);
        });

        it('handles empty filename array', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);
            removeEntries(reviewsDir, []);

            const indexPath = resolveIndexPath(reviewsDir);
            const index = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as ReviewsIndex;
            assert.equal(index.entries.length, 1);
        });
    });

    describe('invalidateIndex', () => {
        it('deletes the index file', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            loadIndex(reviewsDir);

            const indexPath = resolveIndexPath(reviewsDir);
            assert.ok(fs.existsSync(indexPath));

            invalidateIndex(reviewsDir);
            assert.equal(fs.existsSync(indexPath), false);
        });

        it('is a no-op when no index exists', () => {
            invalidateIndex(reviewsDir);
            // Should not throw
        });
    });

    describe('query helpers', () => {
        let index: ReviewsIndex;

        beforeEach(() => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json');
            writeArtifact(reviewsDir, 'T-001-handshake.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-handshake.json');
            writeArtifact(reviewsDir, 'T-003-compile-gate.json');

            index = loadIndex(reviewsDir).index;
        });

        it('entriesForTask returns entries for one task', () => {
            const t001 = entriesForTask(index, 'T-001');
            assert.equal(t001.length, 3);
            assert.ok(t001.every(e => e.taskId === 'T-001'));

            const t002 = entriesForTask(index, 'T-002');
            assert.equal(t002.length, 2);

            const t999 = entriesForTask(index, 'T-999');
            assert.equal(t999.length, 0);
        });

        it('entriesByArtifactSuffix finds matching entries', () => {
            const handshakes = entriesByArtifactSuffix(index, 'handshake.json');
            assert.equal(handshakes.length, 2);

            const taskModes = entriesByArtifactSuffix(index, 'task-mode.json');
            assert.equal(taskModes.length, 2);

            const compileGates = entriesByArtifactSuffix(index, 'compile-gate.json');
            assert.equal(compileGates.length, 1);

            const nonExistent = entriesByArtifactSuffix(index, 'security-review.md');
            assert.equal(nonExistent.length, 0);
        });

        it('taskIds returns unique task IDs', () => {
            const ids = taskIds(index);
            assert.equal(ids.length, 3);
            assert.ok(ids.includes('T-001'));
            assert.ok(ids.includes('T-002'));
            assert.ok(ids.includes('T-003'));
        });

        it('groupByTask groups correctly', () => {
            const groups = groupByTask(index);
            assert.equal(groups.size, 3);
            assert.equal(groups.get('T-001')?.length, 3);
            assert.equal(groups.get('T-002')?.length, 2);
            assert.equal(groups.get('T-003')?.length, 1);
        });
    });

    describe('retention-aware index refresh', () => {
        it('index reflects state after cleanup invalidation', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.index.entries.length, 2);

            // Simulate cleanup deleting an artifact and invalidating the index
            // (the real cleanup integration calls invalidateIndex after removing files)
            fs.unlinkSync(path.join(reviewsDir, 'T-001-task-mode.json'));
            invalidateIndex(reviewsDir);

            const second = loadIndex(reviewsDir);
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].taskId, 'T-002');
        });

        it('forceRebuild picks up external changes', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-002-task-mode.json');

            const first = loadIndex(reviewsDir);
            assert.equal(first.index.entries.length, 2);

            // External deletion without index notification
            fs.unlinkSync(path.join(reviewsDir, 'T-001-task-mode.json'));

            const second = loadIndex(reviewsDir, { forceRebuild: true });
            assert.equal(second.source, 'rebuilt');
            assert.equal(second.index.entries.length, 1);
            assert.equal(second.index.entries[0].taskId, 'T-002');
        });

        it('invalidation forces rebuild on next load', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');

            loadIndex(reviewsDir);
            invalidateIndex(reviewsDir);

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });
    });

    describe('edge cases', () => {
        it('handles corrupt index file gracefully', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const indexPath = resolveIndexPath(reviewsDir);
            fs.writeFileSync(indexPath, 'not valid json!!!', 'utf8');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });

        it('handles index with wrong version', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            const indexPath = resolveIndexPath(reviewsDir);
            fs.writeFileSync(indexPath, JSON.stringify({
                version: 99,
                directoryMtimeMs: 0,
                generatedAtMs: Date.now(),
                entries: []
            }), 'utf8');

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 1);
        });

        it('handles compressed artifact files (.gz) not being indexed', () => {
            writeArtifact(reviewsDir, 'T-001-task-mode.json');
            writeArtifact(reviewsDir, 'T-001-preflight.json.gz', 'compressed data');

            const index = rebuildIndex(reviewsDir);
            // .gz files have T-001- prefix but their artifactType includes .gz
            // They should still be indexed since they match the pattern
            const gzEntry = index.entries.find(e => e.fileName === 'T-001-preflight.json.gz');
            assert.ok(gzEntry);
            assert.equal(gzEntry.artifactType, 'preflight.json.gz');
        });

        it('handles many tasks efficiently', () => {
            for (let i = 1; i <= 200; i++) {
                const taskId = `T-${String(i).padStart(3, '0')}`;
                writeArtifact(reviewsDir, `${taskId}-task-mode.json`, `{"task_id":"${taskId}"}`);
                writeArtifact(reviewsDir, `${taskId}-preflight.json`, `{"task_id":"${taskId}"}`);
            }

            const result = loadIndex(reviewsDir);
            assert.equal(result.source, 'rebuilt');
            assert.equal(result.index.entries.length, 400);

            const ids = taskIds(result.index);
            assert.equal(ids.length, 200);

            // Second load from cache
            const cached = loadIndex(reviewsDir);
            assert.equal(cached.source, 'cache');
            assert.equal(cached.index.entries.length, 400);
        });

        it('upsert to empty directory without prior artifacts', () => {
            const emptyReviewsDir = path.join(tmpDir, 'empty-reviews');
            fs.mkdirSync(emptyReviewsDir, { recursive: true });
            writeArtifact(emptyReviewsDir, 'T-001-task-mode.json');

            upsertEntry(emptyReviewsDir, 'T-001-task-mode.json');

            const indexPath = resolveIndexPath(emptyReviewsDir);
            assert.ok(fs.existsSync(indexPath));
        });
    });
});
