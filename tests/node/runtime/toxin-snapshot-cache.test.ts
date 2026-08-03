import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { withRuntimeMutationGeneration } from '../../../src/gate-runtime/runtime-mutation-generation';
import { collectToxinSnapshot } from '../../../src/runtime/toxin-metrics';
import {
    resolveToxinSnapshotCacheAnchorPath,
    resolveToxinSnapshotCachePath
} from '../../../src/runtime/toxin-snapshot-cache';

const DAY_MS = 24 * 60 * 60 * 1000;

function createRuntimeRoot(prefix: string): string {
    const orchestratorRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(orchestratorRoot, 'runtime'), { recursive: true });
    return orchestratorRoot;
}

function writeJournaledFile(orchestratorRoot: string, relativePath: string, content: string): void {
    withRuntimeMutationGeneration(orchestratorRoot, `test-write-${path.basename(relativePath)}`, () => {
        const filePath = path.join(orchestratorRoot, relativePath);
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.writeFileSync(filePath, content, 'utf8');
    });
}

function countTrackedDirectoryReads<T>(trackedRoot: string, callback: () => T): { result: T; reads: number } {
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalReaddirSync = fsModule.readdirSync;
    let reads = 0;
    try {
        fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
            const resolvedPath = path.resolve(String(targetPath));
            if (
                resolvedPath === path.resolve(trackedRoot)
                || resolvedPath.startsWith(`${path.resolve(trackedRoot)}${path.sep}`)
            ) {
                reads++;
            }
            return originalReaddirSync(targetPath, options as never);
        }) as typeof fsModule.readdirSync;
        return { result: callback(), reads };
    } finally {
        fsModule.readdirSync = originalReaddirSync;
    }
}

function readCacheDocument(cachePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(cachePath, 'utf8')) as Record<string, unknown>;
}

function payloadSha256(payload: unknown): string {
    return createHash('sha256').update(JSON.stringify(payload), 'utf8').digest('hex');
}

function waitForPath(targetPath: string, timeoutMs: number = 5_000): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
        const poll = () => {
            if (fs.existsSync(targetPath)) {
                resolve();
                return;
            }
            if (Date.now() - startedAt >= timeoutMs) {
                reject(new Error(`Timed out waiting for ${targetPath}`));
                return;
            }
            setTimeout(poll, 10);
        };
        poll();
    });
}

function collectWorkerResult(child: ReturnType<typeof spawn>): Promise<{
    status: number | null;
    stdout: string;
    stderr: string;
}> {
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr?.on('data', (chunk: string) => { stderr += chunk; });
    return new Promise((resolve, reject) => {
        child.once('error', reject);
        child.once('close', (status) => resolve({ status, stdout, stderr }));
    });
}

test('persisted generation cache removes recursive toxin traversal across processes', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-process-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    try {
        withRuntimeMutationGeneration(orchestratorRoot, 'seed-process-benchmark', () => {
            for (let directoryIndex = 0; directoryIndex < 40; directoryIndex++) {
                for (let fileIndex = 0; fileIndex < 20; fileIndex++) {
                    const filePath = path.join(
                        backupsRoot,
                        `batch-${directoryIndex}`,
                        `artifact-${fileIndex}.json`
                    );
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, '{}\n', 'utf8');
                }
            }
        });
        const modulePath = path.resolve(__dirname, '../../../src/runtime/toxin-metrics.js');
        const workerScript = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            "const { performance } = require('node:perf_hooks');",
            'const [modulePath, orchestratorRoot, trackedRoot] = process.argv.slice(1);',
            'const originalReaddirSync = fs.readdirSync;',
            'let traversals = 0;',
            'fs.readdirSync = function(targetPath, options) {',
            '  const resolved = path.resolve(String(targetPath));',
            '  const tracked = path.resolve(trackedRoot);',
            '  if (resolved === tracked || resolved.startsWith(tracked + path.sep)) traversals += 1;',
            '  return originalReaddirSync.call(fs, targetPath, options);',
            '};',
            'const { collectToxinSnapshot } = require(modulePath);',
            'const startedAt = performance.now();',
            'const snapshot = collectToxinSnapshot(orchestratorRoot);',
            'const durationMs = performance.now() - startedAt;',
            'process.stdout.write(JSON.stringify({ duration_ms: durationMs, traversals, total: snapshot.runtime_total_bytes }));'
        ].join('\n');
        const runWorker = () => spawnSync(process.execPath, [
            '--eval',
            workerScript,
            modulePath,
            orchestratorRoot,
            backupsRoot
        ], { encoding: 'utf8', timeout: 20_000 });

        const cold = runWorker();
        const warm = runWorker();
        assert.equal(cold.status, 0, cold.stderr);
        assert.equal(warm.status, 0, warm.stderr);
        const coldResult = JSON.parse(cold.stdout) as { duration_ms: number; traversals: number; total: number };
        const warmResult = JSON.parse(warm.stdout) as { duration_ms: number; traversals: number; total: number };

        assert.ok(coldResult.traversals > 0);
        assert.equal(warmResult.traversals, 0);
        assert.equal(warmResult.total, coldResult.total);
        assert.ok(
            warmResult.duration_ms < coldResult.duration_ms,
            `expected warm ${warmResult.duration_ms.toFixed(2)}ms below cold ${coldResult.duration_ms.toFixed(2)}ms`
        );
        console.log(
            `TOXIN_CACHE_BENCHMARK cold_ms=${coldResult.duration_ms.toFixed(2)} `
            + `warm_ms=${warmResult.duration_ms.toFixed(2)} `
            + `cold_traversals=${coldResult.traversals} warm_traversals=${warmResult.traversals}`
        );
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('low-noise runtime writes still reuse the rebuildable toxin snapshot cache', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-low-noise-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    const previousMode = process.env.GARDA_RUNTIME_WRITES_MODE;
    const previousFlag = process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/seed/artifact.txt', 'canonical\n');
        process.env.GARDA_RUNTIME_WRITES_MODE = 'low-noise';
        process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = '1';

        const cold = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));
        const warm = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));

        assert.ok(cold.reads > 0);
        assert.equal(warm.reads, 0);
        assert.equal(warm.result.runtime_total_bytes, cold.result.runtime_total_bytes);
        assert.equal(
            fs.existsSync(resolveToxinSnapshotCachePath(path.join(orchestratorRoot, 'runtime'))),
            true
        );
    } finally {
        if (previousMode === undefined) {
            delete process.env.GARDA_RUNTIME_WRITES_MODE;
        } else {
            process.env.GARDA_RUNTIME_WRITES_MODE = previousMode;
        }
        if (previousFlag === undefined) {
            delete process.env.GARDA_LOW_NOISE_RUNTIME_WRITES;
        } else {
            process.env.GARDA_LOW_NOISE_RUNTIME_WRITES = previousFlag;
        }
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('cache opt-out always performs a fresh recursive toxin scan', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-opt-out-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/seed/artifact.txt', 'canonical\n');
        collectToxinSnapshot(orchestratorRoot);

        const first = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot, {
            useCache: false
        }));
        const second = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot, {
            useCache: false
        }));

        assert.ok(first.reads > 0);
        assert.ok(second.reads > 0);
        assert.equal(second.result.runtime_total_bytes, first.result.runtime_total_bytes);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('concurrent cold processes share one recursive cache build', async () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-concurrent-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    const readyPath = path.join(orchestratorRoot, 'first-scan-ready');
    const releasePath = path.join(orchestratorRoot, 'release-first-scan');
    const children: ReturnType<typeof spawn>[] = [];
    try {
        withRuntimeMutationGeneration(orchestratorRoot, 'seed-concurrent-benchmark', () => {
            for (let directoryIndex = 0; directoryIndex < 20; directoryIndex++) {
                for (let fileIndex = 0; fileIndex < 10; fileIndex++) {
                    const filePath = path.join(backupsRoot, `batch-${directoryIndex}`, `artifact-${fileIndex}.json`);
                    fs.mkdirSync(path.dirname(filePath), { recursive: true });
                    fs.writeFileSync(filePath, '{}\n', 'utf8');
                }
            }
        });
        const modulePath = path.resolve(__dirname, '../../../src/runtime/toxin-metrics.js');
        const workerScript = [
            "const fs = require('node:fs');",
            "const path = require('node:path');",
            'const [modulePath, orchestratorRoot, trackedRoot, readyPath, releasePath, shouldBlock] = process.argv.slice(1);',
            'const originalReaddirSync = fs.readdirSync;',
            'const sleeper = new Int32Array(new SharedArrayBuffer(4));',
            'let traversals = 0;',
            'let blocked = false;',
            'fs.readdirSync = function(targetPath, options) {',
            '  const resolved = path.resolve(String(targetPath));',
            '  const tracked = path.resolve(trackedRoot);',
            '  if (resolved === tracked || resolved.startsWith(tracked + path.sep)) {',
            '    traversals += 1;',
            "    if (shouldBlock === 'true' && !blocked) {",
            '      blocked = true;',
            "      fs.writeFileSync(readyPath, 'ready\\n', 'utf8');",
            '      while (!fs.existsSync(releasePath)) Atomics.wait(sleeper, 0, 0, 10);',
            '    }',
            '  }',
            '  return originalReaddirSync.call(fs, targetPath, options);',
            '};',
            'const { collectToxinSnapshot } = require(modulePath);',
            'const snapshot = collectToxinSnapshot(orchestratorRoot);',
            'process.stdout.write(JSON.stringify({ traversals, total: snapshot.runtime_total_bytes }));'
        ].join('\n');
        const launchWorker = (shouldBlock: boolean) => {
            const child = spawn(process.execPath, [
                '--eval',
                workerScript,
                modulePath,
                orchestratorRoot,
                backupsRoot,
                readyPath,
                releasePath,
                String(shouldBlock)
            ], { stdio: ['ignore', 'pipe', 'pipe'] });
            children.push(child);
            return { child, result: collectWorkerResult(child) };
        };

        const first = launchWorker(true);
        await waitForPath(readyPath);
        const second = launchWorker(false);
        await new Promise((resolve) => setTimeout(resolve, 100));
        fs.writeFileSync(releasePath, 'release\n', 'utf8');
        const [firstResult, secondResult] = await Promise.all([first.result, second.result]);

        assert.equal(firstResult.status, 0, firstResult.stderr);
        assert.equal(secondResult.status, 0, secondResult.stderr);
        const firstSnapshot = JSON.parse(firstResult.stdout) as { traversals: number; total: number };
        const secondSnapshot = JSON.parse(secondResult.stdout) as { traversals: number; total: number };
        assert.ok(firstSnapshot.traversals > 0);
        assert.equal(secondSnapshot.traversals, 0);
        assert.equal(secondSnapshot.total, firstSnapshot.total);
    } finally {
        for (const child of children) {
            if (child.exitCode === null) child.kill();
        }
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('journaled runtime mutation invalidates a warm cache', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-mutation-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/first/artifact.txt', 'first\n');
        const cold = collectToxinSnapshot(orchestratorRoot);
        const warm = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));
        assert.equal(warm.reads, 0);
        assert.equal(warm.result.runtime_total_bytes, cold.runtime_total_bytes);

        writeJournaledFile(orchestratorRoot, 'runtime/backups/second/artifact.txt', 'second-write\n');
        const invalidated = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));

        assert.ok(invalidated.reads > 0);
        assert.ok(invalidated.result.runtime_total_bytes > cold.runtime_total_bytes);
        assert.equal(invalidated.result.runtime_disk[0].file_count, 2);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('cache hit rechecks generation after reading the persisted snapshot', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-hit-race-');
    const cachePath = resolveToxinSnapshotCachePath(path.join(orchestratorRoot, 'runtime'));
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalReadFileSync = fsModule.readFileSync;
    let mutationCommitted = false;
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/first/artifact.txt', 'first\n');
        const cold = collectToxinSnapshot(orchestratorRoot);
        fsModule.readFileSync = ((targetPath: fs.PathOrFileDescriptor, options?: unknown) => {
            const result = originalReadFileSync(targetPath, options as never);
            if (!mutationCommitted && path.resolve(String(targetPath)) === path.resolve(cachePath)) {
                mutationCommitted = true;
                writeJournaledFile(orchestratorRoot, 'runtime/backups/second/artifact.txt', 'second-write\n');
            }
            return result;
        }) as typeof fsModule.readFileSync;

        const raced = collectToxinSnapshot(orchestratorRoot);

        assert.equal(mutationCommitted, true);
        assert.ok(raced.runtime_total_bytes > cold.runtime_total_bytes);
    } finally {
        fsModule.readFileSync = originalReadFileSync;
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('retention eligibility invalidates inside one daily epoch at the exact transition', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-retention-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    const backupRoot = path.join(backupsRoot, 'expiring');
    try {
        const baseNowMs = Date.parse('2026-08-03T12:00:00.000Z');
        withRuntimeMutationGeneration(orchestratorRoot, 'seed-retention-boundary', () => {
            fs.mkdirSync(backupRoot, { recursive: true });
            fs.writeFileSync(path.join(backupRoot, 'artifact.txt'), 'retained\n', 'utf8');
            const mtime = new Date(baseNowMs - DAY_MS + 2_000);
            fs.utimesSync(backupRoot, mtime, mtime);
        });
        const observedMtimeMs = fs.statSync(backupRoot).mtimeMs;
        const eligibleAtMs = Math.floor(observedMtimeMs + DAY_MS) + 1;
        const beforeEligibilityMs = eligibleAtMs - 100;
        const cold = collectToxinSnapshot(orchestratorRoot, {
            cleanupMaxAgeDays: 1,
            nowMs: beforeEligibilityMs
        });
        assert.equal(cold.cleanup_candidate_count, 0);
        const warm = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot, {
            cleanupMaxAgeDays: 1,
            nowMs: beforeEligibilityMs + 1
        }));
        assert.equal(warm.reads, 0);

        const expired = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot, {
            cleanupMaxAgeDays: 1,
            nowMs: eligibleAtMs
        }));
        assert.ok(expired.reads > 0);
        assert.equal(expired.result.cleanup_candidate_count, 1);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('stale-lock and metrics-line values remain request-current on a cache hit', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-current-fields-');
    const runtimeRoot = path.join(orchestratorRoot, 'runtime');
    const backupsRoot = path.join(runtimeRoot, 'backups');
    const eventsRoot = path.join(runtimeRoot, 'task-events');
    const staleLockPath = path.join(eventsRoot, '.T-CACHE.lock');
    const metricsPath = path.join(runtimeRoot, 'metrics.jsonl');
    try {
        withRuntimeMutationGeneration(orchestratorRoot, 'seed-current-fields', () => {
            fs.mkdirSync(path.join(backupsRoot, 'seed'), { recursive: true });
            fs.writeFileSync(path.join(backupsRoot, 'seed', 'artifact.txt'), 'seed\n', 'utf8');
            fs.mkdirSync(staleLockPath, { recursive: true });
            fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
                pid: 999999,
                hostname: os.hostname(),
                created_at_utc: '2026-08-01T00:00:00.000Z'
            }), 'utf8');
        });
        fs.writeFileSync(metricsPath, '{"line":1}\n', 'utf8');
        const cold = collectToxinSnapshot(orchestratorRoot);
        assert.equal(cold.stale_lock_count, 1);
        assert.equal(cold.metrics_file_lines, 1);

        fs.rmSync(staleLockPath, { recursive: true, force: true });
        fs.appendFileSync(metricsPath, '{"line":2}\n', 'utf8');
        const warm = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));

        assert.equal(warm.reads, 0);
        assert.equal(warm.result.stale_lock_count, 0);
        assert.equal(warm.result.metrics_file_lines, 2);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('missing, corrupt, structurally divergent, and unreadable caches rebuild canonically', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-rebuild-');
    const runtimeRoot = path.join(orchestratorRoot, 'runtime');
    const backupsRoot = path.join(runtimeRoot, 'backups');
    const cachePath = resolveToxinSnapshotCachePath(runtimeRoot);
    const anchorPath = resolveToxinSnapshotCacheAnchorPath(runtimeRoot);
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalReadFileSync = fsModule.readFileSync;
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/seed/artifact.txt', 'canonical\n');
        collectToxinSnapshot(orchestratorRoot);
        assert.equal(fs.existsSync(cachePath), true);
        assert.equal(fs.existsSync(anchorPath), true);

        fs.rmSync(anchorPath, { force: true });
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        fs.writeFileSync(anchorPath, '{invalid-anchor', 'utf8');
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        fs.rmSync(cachePath, { force: true });
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        fs.writeFileSync(cachePath, '{invalid-json', 'utf8');
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        const divergent = readCacheDocument(cachePath);
        const payload = divergent.payload as Record<string, unknown>;
        const scan = payload.scan as Record<string, unknown>;
        scan.runtimeTotalBytes = Number(scan.runtimeTotalBytes) + 1;
        divergent.payload_sha256 = payloadSha256(payload);
        fs.writeFileSync(cachePath, `${JSON.stringify(divergent)}\n`, 'utf8');
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        const sameTotalDivergent = readCacheDocument(cachePath);
        const sameTotalPayload = sameTotalDivergent.payload as Record<string, unknown>;
        const sameTotalScan = sameTotalPayload.scan as Record<string, unknown>;
        const sameTotalSummaries = sameTotalScan.diskSummaries as Array<Record<string, unknown>>;
        sameTotalSummaries[0].file_count = Number(sameTotalSummaries[0].file_count) + 1;
        sameTotalPayload.scan_sha256 = payloadSha256(sameTotalScan);
        sameTotalDivergent.payload_sha256 = payloadSha256(sameTotalPayload);
        fs.writeFileSync(cachePath, `${JSON.stringify(sameTotalDivergent)}\n`, 'utf8');
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        const invalidDirectory = readCacheDocument(cachePath);
        const invalidDirectoryPayload = invalidDirectory.payload as Record<string, unknown>;
        const invalidDirectoryScan = invalidDirectoryPayload.scan as Record<string, unknown>;
        const invalidDirectorySummaries = invalidDirectoryScan.diskSummaries as Array<Record<string, unknown>>;
        invalidDirectorySummaries[0].directory = 'unknown-runtime-root';
        invalidDirectoryPayload.scan_sha256 = payloadSha256(invalidDirectoryScan);
        invalidDirectory.payload_sha256 = payloadSha256(invalidDirectoryPayload);
        fs.writeFileSync(cachePath, `${JSON.stringify(invalidDirectory)}\n`, 'utf8');
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);

        fsModule.readFileSync = ((targetPath: fs.PathOrFileDescriptor, options?: unknown) => {
            if (typeof targetPath !== 'number' && path.resolve(String(targetPath)) === path.resolve(cachePath)) {
                const error = new Error('injected unreadable cache') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            }
            return originalReadFileSync(targetPath, options as never);
        }) as typeof fsModule.readFileSync;
        assert.ok(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads > 0);
    } finally {
        fsModule.readFileSync = originalReadFileSync;
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('symlinked cache is ignored without overwriting its target', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-symlink-');
    const runtimeRoot = path.join(orchestratorRoot, 'runtime');
    const backupsRoot = path.join(runtimeRoot, 'backups');
    const cachePath = resolveToxinSnapshotCachePath(runtimeRoot);
    const externalPath = path.join(orchestratorRoot, 'external-cache-target.json');
    let externalSentinelPath = externalPath;
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/seed/artifact.txt', 'canonical\n');
        fs.writeFileSync(externalPath, 'external\n', 'utf8');
        try {
            fs.symlinkSync(externalPath, cachePath, 'file');
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EPERM' || code === 'EACCES' || code === 'ENOTSUP') {
                const externalDirectory = path.join(orchestratorRoot, 'external-cache-target');
                externalSentinelPath = path.join(externalDirectory, 'sentinel.txt');
                fs.rmSync(externalPath, { force: true });
                fs.mkdirSync(externalDirectory);
                fs.writeFileSync(externalSentinelPath, 'external\n', 'utf8');
                fs.symlinkSync(externalDirectory, cachePath, 'junction');
            } else {
                throw error;
            }
        }

        const rebuilt = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot));
        assert.ok(rebuilt.reads > 0);
        assert.equal(fs.readFileSync(externalSentinelPath, 'utf8'), 'external\n');
        assert.equal(fs.lstatSync(cachePath).isSymbolicLink(), true);
    } finally {
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});

test('missing generation scans without caching while corrupt generation fails closed', () => {
    const missingRoot = createRuntimeRoot('garda-toxin-cache-missing-generation-');
    try {
        const backupsRoot = path.join(missingRoot, 'runtime', 'backups');
        fs.mkdirSync(backupsRoot, { recursive: true });
        fs.writeFileSync(path.join(backupsRoot, 'artifact.txt'), 'canonical\n', 'utf8');
        const first = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(missingRoot));
        const second = countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(missingRoot));
        assert.ok(first.reads > 0);
        assert.ok(second.reads > 0);
        assert.equal(fs.existsSync(resolveToxinSnapshotCachePath(path.join(missingRoot, 'runtime'))), false);
    } finally {
        fs.rmSync(missingRoot, { recursive: true, force: true });
    }

    const corruptRoot = createRuntimeRoot('garda-toxin-cache-corrupt-generation-');
    try {
        writeJournaledFile(corruptRoot, 'runtime/backups/seed/artifact.txt', 'canonical\n');
        collectToxinSnapshot(corruptRoot);
        fs.rmSync(path.join(corruptRoot, 'runtime', '.runtime-mutation-generation.anchor.json'), { force: true });
        assert.throws(
            () => collectToxinSnapshot(corruptRoot),
            /anchor|generation journal/iu
        );
    } finally {
        fs.rmSync(corruptRoot, { recursive: true, force: true });
    }
});

test('generation change during a scan retries before publishing cache evidence', () => {
    const orchestratorRoot = createRuntimeRoot('garda-toxin-cache-divergent-scan-');
    const backupsRoot = path.join(orchestratorRoot, 'runtime', 'backups');
    const fsModule = require('node:fs') as typeof import('node:fs');
    const originalReaddirSync = fsModule.readdirSync;
    let injected = false;
    let backupReads = 0;
    try {
        writeJournaledFile(orchestratorRoot, 'runtime/backups/first/artifact.txt', 'first\n');
        fsModule.readdirSync = ((targetPath: fs.PathLike, options?: unknown) => {
            const resolvedPath = path.resolve(String(targetPath));
            if (resolvedPath === path.resolve(backupsRoot)) {
                backupReads++;
                if (!injected) {
                    injected = true;
                    writeJournaledFile(orchestratorRoot, 'runtime/backups/second/artifact.txt', 'second\n');
                }
            }
            return originalReaddirSync(targetPath, options as never);
        }) as typeof fsModule.readdirSync;

        const snapshot = collectToxinSnapshot(orchestratorRoot);

        assert.equal(injected, true);
        assert.ok(backupReads >= 2, 'the generation-divergent scan must be retried');
        assert.equal(snapshot.runtime_disk[0].file_count, 2);
        fsModule.readdirSync = originalReaddirSync;
        assert.equal(countTrackedDirectoryReads(backupsRoot, () => collectToxinSnapshot(orchestratorRoot)).reads, 0);
    } finally {
        fsModule.readdirSync = originalReaddirSync;
        fs.rmSync(orchestratorRoot, { recursive: true, force: true });
    }
});
