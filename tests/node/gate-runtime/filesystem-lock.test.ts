import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
    acquireFilesystemLock,
    acquireFilesystemLockAsync,
    inspectFilesystemLock,
    releaseFilesystemLock,
    scanTaskEventLocks,
    cleanupStaleTaskEventLocks
} from '../../../src/gate-runtime/task-events';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-fslock-'));
}

async function holdLockInChildProcess(lockPath: string, holdMs: number): Promise<() => Promise<void>> {
    const workerScript = [
        "const fs = require('node:fs');",
        "const os = require('node:os');",
        "const path = require('node:path');",
        "const lockPath = process.argv[1];",
        "const holdMs = Number.parseInt(process.argv[2], 10);",
        "fs.mkdirSync(lockPath, { recursive: true });",
        "fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({",
        "  pid: process.pid,",
        "  hostname: os.hostname(),",
        "  created_at_utc: new Date().toISOString()",
        "}, null, 2) + '\\n', 'utf8');",
        "setTimeout(() => {",
        "  try { fs.rmSync(lockPath, { recursive: true, force: true }); } catch {}",
        "  process.exit(0);",
        "}, holdMs);"
    ].join('\n');

    const child = spawn(process.execPath, [
        '--input-type=commonjs',
        '--eval',
        workerScript,
        lockPath,
        String(holdMs)
    ], {
        stdio: ['ignore', 'ignore', 'pipe']
    });

    let stderr = '';
    child.stderr.on('data', (chunk) => {
        stderr += String(chunk);
    });

    await new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + 1000;
        const timer = setInterval(() => {
            if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
                clearInterval(timer);
                resolve();
                return;
            }
            if (Date.now() >= deadline) {
                clearInterval(timer);
                reject(new Error(stderr || 'Timed out waiting for child lock holder to initialize'));
            }
        }, 10);
        child.once('error', (error) => {
            clearInterval(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            if (!fs.existsSync(path.join(lockPath, 'owner.json')) && code !== 0) {
                clearInterval(timer);
                reject(new Error(stderr || `lock holder exited with code ${code}`));
            }
        });
    });

    return async function cleanup(): Promise<void> {
        if (!child.killed && child.exitCode === null) {
            child.kill();
        }
        await new Promise<void>((resolve) => {
            child.once('exit', () => resolve());
            setTimeout(resolve, 250);
        });
    };
}


test('acquireFilesystemLock creates lock directory with owner metadata', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.ok(fs.existsSync(lockPath), 'lock directory should exist');
        const ownerPath = path.join(lockPath, 'owner.json');
        assert.ok(fs.existsSync(ownerPath), 'owner.json should exist');
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        assert.ok(typeof owner.lock_id === 'string' && owner.lock_id.length > 0);
        assert.equal(owner.pid, process.pid);
        assert.ok(typeof owner.hostname === 'string' && owner.hostname.length > 0);
        assert.ok(typeof owner.created_at_utc === 'string');
        assert.equal(owner.heartbeat_at_utc, owner.created_at_utc);
        assert.ok(typeof owner.command === 'string' && owner.command.length > 0);
        assert.ok(typeof telemetry.elapsedMs === 'number');
        assert.equal(telemetry.retries, 0);
        releaseFilesystemLock(handle);
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be removed after release');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock fails when lock already held by live process', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        const { handle } = acquireFilesystemLock(lockPath);
        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock waits through short-lived external contention and reports retries', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-external-live.lock');
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        cleanupChild = await holdLockInChildProcess(lockPath, 120);
        const startedAt = Date.now();
        const { handle, telemetry } = acquireFilesystemLock(lockPath, {
            timeoutMs: 1000,
            retryMs: 20,
            staleMs: 60000
        });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 80, `sync acquire should wait for the external owner, got ${elapsedMs} ms`);
        assert.ok(telemetry.retries > 0, 'telemetry should capture contention retries');
        assert.notEqual(telemetry.contentionLevel, 'none');
        releaseFilesystemLock(handle);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim aged live lock on the current host', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-live-aged.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims aged pid-only lock with dead PID and unknown host', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-live-pid-only.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'owner_dead');
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim aged foreign-host lock without explicit override', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        assert.throws(
            () => acquireFilesystemLock(lockPath, { timeoutMs: 75, retryMs: 10 }),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
        assert.ok(fs.existsSync(lockPath), 'foreign-host lock should remain in place without override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('inspectFilesystemLock treats recent heartbeat as fresh when lock directory mtime is old', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-recent-heartbeat.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            heartbeat_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const inspection = inspectFilesystemLock(lockPath);
        assert.equal(inspection.staleReason, null);
        assert.equal(inspection.freshness.freshnessSource, 'heartbeat');
        assert.ok((inspection.freshness.lockDirAgeMs ?? 0) >= 30 * 60 * 1000);
        assert.ok((inspection.freshness.heartbeatAgeMs ?? Number.MAX_SAFE_INTEGER) < 60_000);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock uses stale heartbeat age even when lock directory mtime is fresh', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-stale-heartbeat.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString(),
            heartbeat_at_utc: new Date(Date.now() - (31 * 60 * 1000)).toISOString()
        }));

        const { handle, telemetry } = acquireFilesystemLock(lockPath, {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'age_exceeded');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims aged foreign-host lock when explicit override is enabled', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.ok(fs.existsSync(lockPath), 'recovered foreign-host lock should be replaced by the current owner');
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'age_exceeded');
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims aged foreign-host lock with call-scoped override', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-aged.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = acquireFilesystemLock(lockPath, { allowForeignHostStaleRecovery: true });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'age_exceeded');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock explicit false override wins over env-based recovery', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        assert.throws(
            () => acquireFilesystemLock(lockPath, { timeoutMs: 75, retryMs: 10, allowForeignHostStaleRecovery: false }),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim fresh foreign-host lock before stale threshold', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-foreign-fresh.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));

        assert.throws(
            () => acquireFilesystemLock(lockPath, { timeoutMs: 75, retryMs: 10, staleMs: 60_000 }),
            /Timed out acquiring file lock/
        );
        assert.ok(fs.existsSync(lockPath), 'fresh foreign-host lock should not be reclaimed automatically');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims lock with missing owner metadata', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        // Simulate a crash that left a lock directory without owner.json
        fs.mkdirSync(lockPath);
        // Age the lock beyond the metadata grace period so it is treated as stale
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle } = acquireFilesystemLock(lockPath);
        assert.ok(fs.existsSync(lockPath));
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid, 'new owner should be current process');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims lock owned by dead process', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));

        const { handle } = acquireFilesystemLock(lockPath);
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims lock with corrupt owner.json', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), 'NOT VALID JSON{{{', 'utf8');
        // Age the lock beyond the metadata grace period
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle } = acquireFilesystemLock(lockPath);
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reclaims lock with partial metadata (hostname only, no PID) after grace period', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-partial.lock');
    try {
        fs.mkdirSync(lockPath);
        // Write partial metadata with hostname but no valid PID — invalid_shape
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: os.hostname(),
            some_field: 'present'
        }), 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle } = acquireFilesystemLock(lockPath);
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim lock without metadata within grace period', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-fresh-no-meta.lock');
    try {
        // Simulate a very recent lock creation with no owner.json (within grace period)
        fs.mkdirSync(lockPath);
        // mtime is current — within the 2s grace period

        assert.throws(
            () => acquireFilesystemLock(lockPath, { timeoutMs: 250, retryMs: 10 }),
            /Timed out acquiring file lock/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('acquireFilesystemLockAsync creates lock and releases correctly', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async.lock');
    try {
        const { handle } = await acquireFilesystemLockAsync(lockPath, { timeoutMs: 2000 });
        assert.ok(fs.existsSync(lockPath));
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
        assert.ok(!fs.existsSync(lockPath));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync refreshes heartbeat while lock is held', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-heartbeat.lock');
    try {
        const { handle } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 2000,
            heartbeatIntervalMs: 20
        });
        const ownerPath = path.join(lockPath, 'owner.json');
        const initialOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        await new Promise((resolve) => setTimeout(resolve, 80));
        const refreshedOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));

        assert.equal(refreshedOwner.lock_id, initialOwner.lock_id);
        assert.ok(
            Date.parse(refreshedOwner.heartbeat_at_utc) > Date.parse(initialOwner.heartbeat_at_utc),
            'heartbeat should advance while async lock is held'
        );
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reclaims orphaned lock without metadata', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-orphan.lock');
    try {
        fs.mkdirSync(lockPath);
        // Age the lock beyond the metadata grace period
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 5000,
            retryMs: 10
        });
        assert.ok(fs.existsSync(lockPath));
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reclaims lock with dead PID', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-dead.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));

        const { handle } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 5000,
            retryMs: 10
        });
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync times out against live lock', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-timeout.lock');
    try {
        const { handle } = await acquireFilesystemLockAsync(lockPath, { timeoutMs: 2000 });
        await assert.rejects(
            () => acquireFilesystemLockAsync(lockPath, { timeoutMs: 100, retryMs: 10 }),
            /Timed out acquiring file lock/
        );
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync keeps waiting until timeout when retryMs is much smaller than the wait window', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-small-retry.lock');
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        cleanupChild = await holdLockInChildProcess(lockPath, 700);
        const startedAt = Date.now();
        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 2000,
            retryMs: 1,
            staleMs: 60000
        });
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 500, `async acquire should wait past the legacy retry cap window, got ${elapsedMs} ms`);
        assert.ok(telemetry.retries > 0, 'telemetry should capture contention retries');
        assert.notEqual(telemetry.contentionLevel, 'none');
        releaseFilesystemLock(handle);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync contention wait does not block event-loop timers', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-event-loop.lock');
    let cleanupChild: (() => Promise<void>) | null = null;
    try {
        cleanupChild = await holdLockInChildProcess(lockPath, 120);
        let timerFired = false;
        const timerPromise = new Promise<void>((resolve) => {
            setTimeout(() => {
                timerFired = true;
                resolve();
            }, 20);
        });

        const { handle } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 1000,
            retryMs: 20,
            staleMs: 60000
        });
        await timerPromise;
        assert.equal(timerFired, true, 'timer should fire while async lock acquisition is waiting');
        releaseFilesystemLock(handle);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync does not reclaim aged foreign-host lock without explicit override', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        await assert.rejects(
            () => acquireFilesystemLockAsync(lockPath, { timeoutMs: 75, retryMs: 10 }),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync does not reclaim fresh foreign-host lock before stale threshold', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-foreign-fresh.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));

        await assert.rejects(
            () => acquireFilesystemLockAsync(lockPath, { timeoutMs: 75, retryMs: 10, staleMs: 60_000 }),
            /Timed out acquiring file lock/
        );
        assert.ok(fs.existsSync(lockPath), 'fresh foreign-host lock should not be reclaimed automatically');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reclaims aged foreign-host lock when explicit override is enabled', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, { timeoutMs: 250, retryMs: 10 });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'age_exceeded');
        releaseFilesystemLock(handle);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reclaims aged foreign-host lock with call-scoped override', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-foreign-aged.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 250,
            retryMs: 10,
            allowForeignHostStaleRecovery: true
        });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'age_exceeded');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reclaims aged pid-only lock with dead PID and unknown host', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-pid-only.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: 250,
            retryMs: 10
        });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'owner_dead');
        const owner = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(owner.pid, process.pid);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync explicit false override wins over env-based recovery', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-foreign-aged.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);
        if (fs.existsSync(path.join(lockPath, 'owner.json'))) {
            fs.utimesSync(path.join(lockPath, 'owner.json'), oldTime, oldTime);
        }

        await assert.rejects(
            () => acquireFilesystemLockAsync(lockPath, {
                timeoutMs: 75,
                retryMs: 10,
                allowForeignHostStaleRecovery: false
            }),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('releaseFilesystemLock is safe with null handle', () => {
    assert.doesNotThrow(() => releaseFilesystemLock(null));
});

test('releaseFilesystemLock is safe with empty lockPath', () => {
    assert.doesNotThrow(() => releaseFilesystemLock({ lockPath: '' }));
});

test('releaseFilesystemLock retries transient EPERM and removes lock directory', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-release-retry.lock');
    const realFs = require('node:fs');
    const originalRmSync = realFs.rmSync;
    const originalStderrWrite = process.stderr.write;
    let interceptedRetries = 0;
    let stderrOutput = '';

    try {
        const { handle } = acquireFilesystemLock(lockPath);
        realFs.rmSync = function (...args: unknown[]) {
            const targetPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
            if (targetPath.startsWith(path.resolve(`${lockPath}.releasing`)) && interceptedRetries < 2) {
                interceptedRetries += 1;
                const error = new Error('EPERM: simulated transient release contention') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return originalRmSync.apply(realFs, args as [string, fs.RmOptions?]);
        };
        (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
            stderrOutput += String(chunk);
            return true;
        };

        assert.doesNotThrow(() => releaseFilesystemLock(handle));
        assert.equal(interceptedRetries, 2, 'release path should retry transient contention');
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be removed after retry recovery');
        assert.ok(stderrOutput.includes('LOCK_RELEASE_RETRY_RESOLVED'));
    } finally {
        realFs.rmSync = originalRmSync;
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalStderrWrite;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('releaseFilesystemLock retries transient EPERM while claiming release ownership', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-release-claim-retry.lock');
    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    const originalStderrWrite = process.stderr.write;
    let interceptedRetries = 0;
    let stderrOutput = '';

    try {
        const { handle } = acquireFilesystemLock(lockPath);
        realFs.renameSync = function (...args: unknown[]) {
            const fromPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
            const toPath = typeof args[1] === 'string' ? path.resolve(args[1]) : '';
            if (fromPath === path.resolve(lockPath)
                && toPath.startsWith(path.resolve(`${lockPath}.releasing`))
                && interceptedRetries < 2) {
                interceptedRetries += 1;
                const error = new Error('EPERM: simulated transient release claim contention') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return originalRenameSync.apply(realFs, args as [fs.PathLike, fs.PathLike]);
        };
        (process.stderr as unknown as { write: (...args: unknown[]) => boolean }).write = function (chunk: unknown): boolean {
            stderrOutput += String(chunk);
            return true;
        };

        assert.doesNotThrow(() => releaseFilesystemLock(handle));
        assert.equal(interceptedRetries, 2, 'release claim should retry transient rename contention');
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be removed after release claim retry recovery');
        assert.ok(stderrOutput.includes('LOCK_RELEASE_RETRY_RESOLVED'));
    } finally {
        realFs.renameSync = originalRenameSync;
        (process.stderr as unknown as { write: typeof process.stderr.write }).write = originalStderrWrite;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('releaseFilesystemLock does not remove replacement lock after stale reclaim race', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-old-owner-race.lock');
    try {
        const oldOwner = acquireFilesystemLock(lockPath);
        const oldOwnerMetadataPath = path.join(lockPath, 'owner.json');
        const oldOwnerMetadata = JSON.parse(fs.readFileSync(oldOwnerMetadataPath, 'utf8'));
        fs.writeFileSync(oldOwnerMetadataPath, JSON.stringify({
            ...oldOwnerMetadata,
            pid: 999999999,
            heartbeat_at_utc: oldOwnerMetadata.created_at_utc
        }, null, 2) + '\n', 'utf8');

        const replacement = acquireFilesystemLock(lockPath);
        const replacementMetadata = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.notEqual(replacementMetadata.lock_id, oldOwner.handle.lockId);

        releaseFilesystemLock(oldOwner.handle);
        assert.ok(fs.existsSync(lockPath), 'old owner release must not remove replacement lock');
        const afterOldRelease = JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));
        assert.equal(afterOldRelease.lock_id, replacement.handle.lockId);

        releaseFilesystemLock(replacement.handle);
        assert.ok(!fs.existsSync(lockPath), 'replacement owner should still be able to release its own lock');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('releaseFilesystemLock restores replacement lock if owner changes during release claim', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-release-owner-window.lock');
    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    let interceptedReleaseClaim = false;

    try {
        const { handle } = acquireFilesystemLock(lockPath);
        const ownerPath = path.join(lockPath, 'owner.json');
        const initialOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        const replacementLockId = 'replacement-owner-during-release';
        const replacementOwner = {
            ...initialOwner,
            lock_id: replacementLockId,
            created_at_utc: new Date(Date.now() + 1000).toISOString(),
            heartbeat_at_utc: new Date(Date.now() + 1000).toISOString()
        };

        realFs.renameSync = function (...args: unknown[]) {
            const fromPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
            const toPath = typeof args[1] === 'string' ? path.resolve(args[1]) : '';
            if (!interceptedReleaseClaim
                && fromPath === path.resolve(lockPath)
                && toPath.startsWith(path.resolve(`${lockPath}.releasing`))) {
                interceptedReleaseClaim = true;
                fs.writeFileSync(ownerPath, JSON.stringify(replacementOwner, null, 2) + '\n', 'utf8');
            }
            return originalRenameSync.apply(realFs, args as [fs.PathLike, fs.PathLike]);
        };

        releaseFilesystemLock(handle);

        assert.equal(interceptedReleaseClaim, true, 'release claim race window should be exercised');
        assert.ok(fs.existsSync(lockPath), 'replacement lock should be restored to the canonical lock path');
        const restoredOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        assert.equal(restoredOwner.lock_id, replacementLockId);
    } finally {
        realFs.renameSync = originalRenameSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('scanTaskEventLocks reports empty when no locks exist', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    fs.mkdirSync(path.join(orchRoot, 'runtime', 'task-events'), { recursive: true });
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 0);
        assert.equal(result.active_count, 0);
        assert.equal(result.stale_count, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks classifies orphaned lock without metadata as stale', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-ORPHAN.lock');
    fs.mkdirSync(lockDir);
    // Age the lock beyond the metadata grace period
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks[0].status, 'STALE');
        assert.equal(result.locks[0].owner_metadata_status, 'missing');
        assert.equal(result.locks[0].stale_reason, 'owner_dead');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks classifies lock owned by current process as active', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-ACTIVE.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }));
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.active_count, 1);
        assert.equal(result.locks[0].status, 'ACTIVE');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks classifies lock with dead PID as stale', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-DEAD.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }));
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks[0].status, 'STALE');
        assert.equal(result.locks[0].stale_reason, 'owner_dead');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks classifies aged foreign-host locks as stale', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-REMOTE.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: 'remote-build-host',
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.active_count, 0);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks[0].status, 'STALE');
        assert.equal(result.locks[0].owner_alive, null);
        assert.equal(result.locks[0].stale_reason, 'age_exceeded');
        assert.match(result.locks[0].remediation, /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks reports aged pid-only locks as stale dead-owner candidates', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-PID-ONLY.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.active_count, 0);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks[0].status, 'STALE');
        assert.equal(result.locks[0].owner_alive, false);
        assert.equal(result.locks[0].owner_hostname, null);
        assert.equal(result.locks[0].stale_reason, 'owner_dead');
        assert.doesNotMatch(result.locks[0].remediation, /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks classifies aggregate lock correctly', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.all-tasks.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }));
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.locks[0].scope, 'aggregate');
        assert.equal(result.locks[0].task_id, null);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('cleanupStaleTaskEventLocks removes stale locks on non-dry-run', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const staleLock = path.join(eventsRoot, '.T-STALE.lock');
    fs.mkdirSync(staleLock);
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(staleLock, oldTime, oldTime);
    if (fs.existsSync(path.join(staleLock, 'owner.json'))) {
        fs.utimesSync(path.join(staleLock, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.removed_locks.includes('.T-STALE.lock'));
        assert.ok(!fs.existsSync(staleLock));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks dry-run does not remove locks', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const staleLock = path.join(eventsRoot, '.T-STALE-DRY.lock');
    fs.mkdirSync(staleLock);
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(staleLock, oldTime, oldTime);
    if (fs.existsSync(path.join(staleLock, 'owner.json'))) {
        fs.utimesSync(path.join(staleLock, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: true });
        assert.ok(result.removable_stale_locks.includes('.T-STALE-DRY.lock'));
        assert.equal(result.removed_locks.length, 0);
        assert.ok(fs.existsSync(staleLock));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks retains active locks', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-LIVE.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }));
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.retained_live_locks.includes('.T-LIVE.lock'));
        assert.ok(fs.existsSync(lockDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks retains aged foreign-host locks without explicit override', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-REMOTE-LIVE.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: 'remote-build-host',
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.retained_live_locks.includes('.T-REMOTE-LIVE.lock'));
        assert.ok(result.warnings.some((item) => item.includes('GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1')));
        assert.ok(fs.existsSync(lockDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks removes aged foreign-host locks when explicit override is enabled', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    const lockDir = path.join(eventsRoot, '.T-REMOTE-LIVE.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: 'remote-build-host',
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.removed_locks.includes('.T-REMOTE-LIVE.lock'));
        assert.ok(!fs.existsSync(lockDir));
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks removes aged foreign-host locks with direct option override', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    const lockDir = path.join(eventsRoot, '.T-REMOTE-LIVE.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: 'remote-build-host',
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, {
            dryRun: false,
            allowForeignHostStaleRecovery: true
        });
        assert.ok(result.removed_locks.includes('.T-REMOTE-LIVE.lock'));
        assert.ok(!fs.existsSync(lockDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks removes aged pid-only locks with dead PID and unknown host', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    const lockDir = path.join(eventsRoot, '.T-PID-ONLY-LIVE.lock');
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.removed_locks.includes('.T-PID-ONLY-LIVE.lock'));
        assert.ok(!fs.existsSync(lockDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks explicit false override wins over env-based recovery', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    const lockDir = path.join(eventsRoot, '.T-REMOTE-LIVE.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: 999999999,
        hostname: 'remote-build-host',
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    if (fs.existsSync(path.join(lockDir, 'owner.json'))) {
        fs.utimesSync(path.join(lockDir, 'owner.json'), oldTime, oldTime);
    }
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, {
            dryRun: false,
            allowForeignHostStaleRecovery: false
        });
        assert.ok(result.retained_live_locks.includes('.T-REMOTE-LIVE.lock'));
        assert.ok(fs.existsSync(lockDir));
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('acquireFilesystemLock stale recovery does not leave .stale- temp directories', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-stale-rename.lock');
    try {
        // Simulate a dead-process lock
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));

        const { handle } = acquireFilesystemLock(lockPath);
        // Verify no leftover .stale- temp directories
        const entries = fs.readdirSync(tmp);
        const staleEntries = entries.filter((e: string) => e.includes('.stale-'));
        assert.equal(staleEntries.length, 0, 'no stale temp directories should remain');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks handles mixed stale and active locks', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });

    // Stale lock (no metadata, aged beyond grace period)
    const staleLock = path.join(eventsRoot, '.T-STALE-MIX.lock');
    fs.mkdirSync(staleLock);
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(staleLock, oldTime, oldTime);
    if (fs.existsSync(path.join(staleLock, 'owner.json'))) {
        fs.utimesSync(path.join(staleLock, 'owner.json'), oldTime, oldTime);
    }

    // Active lock (current process)
    const activeDir = path.join(eventsRoot, '.T-ACTIVE-MIX.lock');
    fs.mkdirSync(activeDir);
    fs.writeFileSync(path.join(activeDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }));

    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.removed_locks.includes('.T-STALE-MIX.lock'));
        assert.ok(result.retained_live_locks.includes('.T-ACTIVE-MIX.lock'));
        assert.ok(!fs.existsSync(staleLock));
        assert.ok(fs.existsSync(activeDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('cleanupStaleTaskEventLocks does not remove a lock recreated after stale cleanup claims the old path', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });

    const staleLock = path.join(eventsRoot, '.T-RACE.lock');
    fs.mkdirSync(staleLock);
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(staleLock, oldTime, oldTime);
    if (fs.existsSync(path.join(staleLock, 'owner.json'))) {
        fs.utimesSync(path.join(staleLock, 'owner.json'), oldTime, oldTime);
    }

    const realFs = require('node:fs');
    const originalRenameSync = realFs.renameSync;
    let recreated = false;
    try {
        realFs.renameSync = function (...args: any[]) {
            const [fromPath, toPath] = args;
            const result = originalRenameSync.apply(realFs, args);
            if (!recreated && fromPath === staleLock && typeof toPath === 'string' && toPath.includes('.stale-')) {
                recreated = true;
                fs.mkdirSync(staleLock);
                fs.writeFileSync(path.join(staleLock, 'owner.json'), JSON.stringify({
                    pid: process.pid,
                    hostname: os.hostname(),
                    created_at_utc: new Date().toISOString()
                }));
            }
            return result;
        };

        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.removed_locks.includes('.T-RACE.lock'));
        assert.equal(result.failed_locks.length, 0);
        assert.ok(fs.existsSync(staleLock), 'recreated live lock should survive stale cleanup');
    } finally {
        realFs.renameSync = originalRenameSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});


test('acquireFilesystemLock cleans up lock directory when metadata write fails', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-meta-fail.lock');
    // Access the real fs module (not the __importStar wrapper) for monkey-patching
    const realFs = require('node:fs');
    const originalWriteFileSync = realFs.writeFileSync;
    let intercepted = false;
    try {
        realFs.writeFileSync = function (...args: any[]) {
            if (!intercepted && typeof args[0] === 'string' && args[0].includes('owner.json')) {
                intercepted = true;
                throw new Error('Simulated metadata write failure');
            }
            return originalWriteFileSync.apply(realFs, args);
        };

        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Simulated metadata write failure/
        );
        assert.ok(intercepted, 'writeFileSync interception should have fired');
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be cleaned up after metadata write failure');
    } finally {
        realFs.writeFileSync = originalWriteFileSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

