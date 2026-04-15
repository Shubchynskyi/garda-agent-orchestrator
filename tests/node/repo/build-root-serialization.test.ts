import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import { getRepoRoot } from '../../../scripts/node-foundation/build';
const {
    acquireBuildRootLock,
    getBuildRootLockPath,
    releaseBuildRootLock
} = require('../../../scripts/node-foundation/build-root-lock.cjs') as {
    acquireBuildRootLock: (
        lockPath: string,
        options?: {
            timeoutMs?: number;
            metadataGraceMs?: number;
            staleMs?: number;
            backoffBaseMs?: number;
            backoffMultiplier?: number;
            backoffMaxMs?: number;
        }
    ) => void;
    getBuildRootLockPath: (buildRoot: string) => string;
    releaseBuildRootLock: (lockPath: string) => void;
};

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function agePath(targetPath: string, ageMs: number): void {
    const oldTime = new Date(Date.now() - ageMs);
    fs.utimesSync(targetPath, oldTime, oldTime);
}

function parseSerializedRanges(logPath: string): Array<{ pid: number; acquiredAt: number; releasedAt: number; }> {
    const ranges = new Map<number, { acquiredAt?: number; releasedAt?: number }>();
    const lines = fs.readFileSync(logPath, 'utf8').trim().split(/\r?\n/).filter(Boolean);

    for (const line of lines) {
        const [eventType, pidText, timestampText] = line.trim().split(/\s+/);
        const pid = Number(pidText);
        const timestamp = Number(timestampText);
        assert.ok(Number.isInteger(pid) && pid > 0, `Unexpected pid in log line: ${line}`);
        assert.ok(Number.isFinite(timestamp) && timestamp > 0, `Unexpected timestamp in log line: ${line}`);

        const current = ranges.get(pid) || {};
        if (eventType === 'start' || eventType === 'acquired') {
            current.acquiredAt = timestamp;
        } else if (eventType === 'end' || eventType === 'released') {
            current.releasedAt = timestamp;
        } else {
            assert.fail(`Unexpected event type in log line: ${line}`);
        }
        ranges.set(pid, current);
    }

    return Array.from(ranges.entries())
        .map(([pid, range]) => ({
            pid,
            acquiredAt: Number(range.acquiredAt),
            releasedAt: Number(range.releasedAt)
        }))
        .sort((left, right) => left.acquiredAt - right.acquiredAt);
}

function assertSerializedRanges(logPath: string, expectedCount: number): void {
    const ranges = parseSerializedRanges(logPath);
    assert.equal(ranges.length, expectedCount, `Expected ${expectedCount} serialized workers`);

    for (const range of ranges) {
        assert.ok(Number.isFinite(range.acquiredAt) && range.acquiredAt > 0, 'Missing acquired/start timestamp');
        assert.ok(Number.isFinite(range.releasedAt) && range.releasedAt >= range.acquiredAt, 'Missing released/end timestamp');
    }

    for (let index = 1; index < ranges.length; index += 1) {
        assert.ok(
            ranges[index].acquiredAt >= ranges[index - 1].releasedAt,
            `Worker ${ranges[index].pid} overlapped worker ${ranges[index - 1].pid}`
        );
    }
}

function runWorker(command: string, args: string[], options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
} = {}): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        const child = spawn(command, args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true
        });

        let stderr = '';
        child.stderr.on('data', (chunk) => {
            stderr += String(chunk);
        });

        child.on('error', reject);
        child.on('exit', (code) => {
            if (code === 0) {
                resolve();
                return;
            }
            reject(new Error(stderr || `${path.basename(command)} exited with code ${code}`));
        });
    });
}

function createBuildScriptsFixture(repoRoot: string): string {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-fixture-'));
    const fixtureRoot = path.join(tempRoot, 'repo');
    const relativePaths = [
        'package.json',
        'VERSION',
        'tsconfig.scripts.json',
        'src/bin',
        'scripts/node-foundation'
    ];

    fs.mkdirSync(fixtureRoot, { recursive: true });
    for (const relativePath of relativePaths) {
        fs.cpSync(path.join(repoRoot, relativePath), path.join(fixtureRoot, relativePath), { recursive: true });
    }

    const realNodeModules = path.join(repoRoot, 'node_modules');
    const fixtureNodeModules = path.join(fixtureRoot, 'node_modules');
    if (fs.existsSync(realNodeModules) && !fs.existsSync(fixtureNodeModules)) {
        fs.symlinkSync(realNodeModules, fixtureNodeModules, 'junction');
    }

    return tempRoot;
}

test('withBuildRootLock serializes concurrent workers without leaving lock directories', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-lock-'));
    const buildRoot = path.join(tempRoot, '.node-build');
    const eventLogPath = path.join(tempRoot, 'build-root-events.log');
    const buildModulePath = path.resolve(__dirname, '../../../scripts/node-foundation/build.js');
    const workerScript = [
        "const fs = require('node:fs');",
        "const { withBuildRootLock } = require(process.argv[1]);",
        "const buildRoot = process.argv[2];",
        "const eventLogPath = process.argv[3];",
        "const holdMs = Number(process.argv[4] || '0');",
        "function record(label) { fs.appendFileSync(eventLogPath, `${label} ${process.pid} ${Date.now()}\\n`, 'utf8'); }",
        "withBuildRootLock(buildRoot, () => {",
        "  record('start');",
        "  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, holdMs);",
        "  record('end');",
        "});"
    ].join('\n');

    try {
        await Promise.all([
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400']),
            runWorker(process.execPath, ['--input-type=commonjs', '--eval', workerScript, buildModulePath, buildRoot, eventLogPath, '400'])
        ]);

        assertSerializedRanges(eventLogPath, 2);
        assert.ok(!fs.existsSync(`${buildRoot}.lock`), 'build root lock directory must be removed after workers finish');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock reclaims orphaned lock directory without owner metadata after grace period', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-orphan-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 5000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock reclaims orphaned lock directory with corrupt owner metadata after grace period', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-corrupt-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), 'NOT VALID JSON{{{', 'utf8');
        agePath(lockPath, 5000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock does not reclaim orphaned lock directory within metadata grace period and reports diagnostics', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-fresh-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out acquiring build root lock/);
                assert.match(error.message, /metadata_status=missing/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock does not reclaim aged lock when owner PID is still alive', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-live-owner-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAtUtc: new Date().toISOString()
        }), 'utf8');
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /Timed out acquiring build root lock/);
                assert.match(error.message, /metadata_status=ok/);
                assert.match(error.message, /owner_alive=true/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'live-owner lock must remain in place after timeout');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock keeps foreign-host partial metadata until stale timeout and then reclaims it', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-foreign-partial-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: 'foreign-host-for-build-lock'
        }), 'utf8');
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                staleMs: 20000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=invalid_shape/);
                assert.match(error.message, /owner_host=foreign:/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );

        fs.rmSync(lockPath, { recursive: true, force: true });
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: 'foreign-host-for-build-lock'
        }), 'utf8');
        agePath(lockPath, 25000);

        acquireBuildRootLock(lockPath, {
            timeoutMs: 250,
            metadataGraceMs: 2000,
            staleMs: 20000,
            backoffBaseMs: 5,
            backoffMaxMs: 10
        });

        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
    } finally {
        releaseBuildRootLock(lockPath);
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock does not reclaim missing owner metadata during extended initialization grace', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-init-grace-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 5000);

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 30000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=missing/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'lock should remain during extended initialization grace');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('acquireBuildRootLock does not treat transient owner metadata read failures as corruption', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-build-root-transient-read-'));
    const buildRoot = path.join(tempRoot, '.scripts-build');
    const lockPath = getBuildRootLockPath(buildRoot);
    const ownerPath = path.join(lockPath, 'owner.json');
    const mutableFs = require('node:fs') as typeof fs & { readFileSync: typeof fs.readFileSync };
    const originalReadFileSync = mutableFs.readFileSync;

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(ownerPath, JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            startedAtUtc: new Date().toISOString()
        }), 'utf8');
        agePath(lockPath, 5000);

        mutableFs.readFileSync = function (filePath: fs.PathOrFileDescriptor, options?: Parameters<typeof originalReadFileSync>[1]) {
            if (String(filePath).replace(/\\/g, '/').endsWith('/owner.json')) {
                const error = new Error('owner metadata temporarily busy') as NodeJS.ErrnoException;
                error.code = 'EBUSY';
                throw error;
            }
            return (originalReadFileSync as typeof fs.readFileSync)(filePath, options as never);
        } as typeof fs.readFileSync;

        assert.throws(
            () => acquireBuildRootLock(lockPath, {
                timeoutMs: 80,
                metadataGraceMs: 2000,
                staleMs: 20000,
                backoffBaseMs: 5,
                backoffMaxMs: 10
            }),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.match(error.message, /metadata_status=transient_read_error/);
                assert.match(error.message, /stale_reason=none/);
                return true;
            }
        );
        assert.ok(fs.existsSync(lockPath), 'transient read failures must not reclaim a live lock');
    } finally {
        mutableFs.readFileSync = originalReadFileSync;
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('build-scripts wrapper serializes concurrent workers and leaves a usable scripts build', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const tracePath = path.join(tempRoot, 'wrapper-lock-trace.log');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');

    try {
        await Promise.all([
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            }),
            runWorker(process.execPath, [wrapperPath], {
                cwd: fixtureRoot,
                env: {
                    ...process.env,
                    GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '300',
                    GARDA_BUILD_SCRIPTS_TRACE_FILE: tracePath
                }
            })
        ]);

        assertSerializedRanges(tracePath, 2);
        assert.ok(fs.existsSync(path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js')));
        assert.ok(fs.existsSync(path.join(fixtureRoot, 'bin', 'garda.js')));
        assert.ok(!fs.existsSync(path.join(fixtureRoot, '.scripts-build.lock')), 'wrapper lock directory must be removed after build');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});

test('build-scripts wrapper reclaims orphaned lock directory without owner metadata after grace period', async () => {
    const repoRoot = getRepoRoot();
    const tempRoot = createBuildScriptsFixture(repoRoot);
    const fixtureRoot = path.join(tempRoot, 'repo');
    const wrapperPath = path.join(fixtureRoot, 'scripts', 'node-foundation', 'build-scripts.cjs');
    const lockPath = path.join(fixtureRoot, '.scripts-build.lock');

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        agePath(lockPath, 35000);

        await runWorker(process.execPath, [wrapperPath], {
            cwd: fixtureRoot,
            env: {
                ...process.env,
                GARDA_BUILD_SCRIPTS_LOCK_HOLD_MS: '0'
            }
        });

        assert.ok(fs.existsSync(path.join(fixtureRoot, '.scripts-build', 'scripts', 'node-foundation', 'build.js')));
        assert.ok(!fs.existsSync(lockPath), 'wrapper should reclaim abandoned lock directory and remove it after build');
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
