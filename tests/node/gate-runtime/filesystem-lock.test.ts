import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    acquireFilesystemLock,
    acquireFilesystemLockAsync,
    releaseFilesystemLock,
    scanTaskEventLocks,
    cleanupStaleTaskEventLocks
} from '../../../src/gate-runtime/task-events';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-fslock-'));
}

// ---------------------------------------------------------------------------
// acquireFilesystemLock / releaseFilesystemLock
// ---------------------------------------------------------------------------

test('acquireFilesystemLock creates lock directory with owner metadata', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test.lock');
    try {
        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.ok(fs.existsSync(lockPath), 'lock directory should exist');
        const ownerPath = path.join(lockPath, 'owner.json');
        assert.ok(fs.existsSync(ownerPath), 'owner.json should exist');
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        assert.equal(owner.pid, process.pid);
        assert.ok(typeof owner.hostname === 'string' && owner.hostname.length > 0);
        assert.ok(typeof owner.created_at_utc === 'string');
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

        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim aged live lock when metadata has pid but no hostname', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-live-pid-only.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            created_at_utc: new Date().toISOString()
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
        assert.ok(fs.existsSync(lockPath), 'pid-only live lock should not be reclaimed automatically');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock does not reclaim aged foreign-host lock by default', () => {
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

        assert.throws(
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
        assert.ok(fs.existsSync(lockPath), 'foreign-host lock should not be reclaimed automatically');
    } finally {
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
            () => acquireFilesystemLock(lockPath),
            /Timed out acquiring file lock/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// acquireFilesystemLockAsync
// ---------------------------------------------------------------------------

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

test('acquireFilesystemLockAsync reclaims orphaned lock without metadata', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-orphan.lock');
    try {
        fs.mkdirSync(lockPath);
        // Age the lock beyond the metadata grace period
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);

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

// ---------------------------------------------------------------------------
// releaseFilesystemLock edge cases
// ---------------------------------------------------------------------------

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
            if (targetPath === path.resolve(lockPath) && interceptedRetries < 2) {
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

// ---------------------------------------------------------------------------
// scanTaskEventLocks
// ---------------------------------------------------------------------------

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

test('scanTaskEventLocks retains aged foreign-host locks as active', () => {
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
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.active_count, 1);
        assert.equal(result.stale_count, 0);
        assert.equal(result.locks[0].status, 'ACTIVE');
        assert.equal(result.locks[0].owner_alive, null);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('scanTaskEventLocks retains aged pid-only live locks as active', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const lockDir = path.join(eventsRoot, '.T-PID-ONLY.lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
        pid: process.pid,
        created_at_utc: new Date().toISOString()
    }));
    const oldTime = new Date(Date.now() - (31 * 60 * 1000));
    fs.utimesSync(lockDir, oldTime, oldTime);
    try {
        const result = scanTaskEventLocks(orchRoot);
        assert.equal(result.locks.length, 1);
        assert.equal(result.active_count, 1);
        assert.equal(result.stale_count, 0);
        assert.equal(result.locks[0].status, 'ACTIVE');
        assert.equal(result.locks[0].owner_alive, true);
        assert.equal(result.locks[0].owner_hostname, null);
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

// ---------------------------------------------------------------------------
// cleanupStaleTaskEventLocks
// ---------------------------------------------------------------------------

test('cleanupStaleTaskEventLocks removes stale locks on non-dry-run', () => {
    const tmp = mkTmpDir();
    const orchRoot = path.join(tmp, 'orch');
    const eventsRoot = path.join(orchRoot, 'runtime', 'task-events');
    fs.mkdirSync(eventsRoot, { recursive: true });
    const staleLock = path.join(eventsRoot, '.T-STALE.lock');
    fs.mkdirSync(staleLock);
    const oldTime = new Date(Date.now() - 5000);
    fs.utimesSync(staleLock, oldTime, oldTime);
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

test('cleanupStaleTaskEventLocks retains aged foreign-host locks', () => {
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
    try {
        const result = cleanupStaleTaskEventLocks(orchRoot, { dryRun: false });
        assert.ok(result.retained_live_locks.includes('.T-REMOTE-LIVE.lock'));
        assert.ok(fs.existsSync(lockDir));
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// TOCTOU-safe stale lock recovery (rename-based)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Metadata-write-failure cleanup
// ---------------------------------------------------------------------------

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
