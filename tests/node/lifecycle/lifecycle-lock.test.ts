import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    withLifecycleOperationLock,
    withLifecycleOperationLockAsync,
    getLifecycleOperationLockPath,
    getLastLifecycleLockTelemetry
} from '../../../src/lifecycle/common';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-lifecycle-lock-'));
}

// ---------------------------------------------------------------------------
// getLifecycleOperationLockPath
// ---------------------------------------------------------------------------

test('getLifecycleOperationLockPath returns path inside Garda runtime', () => {
    const lockPath = getLifecycleOperationLockPath('/some/project');
    assert.ok(lockPath.includes('garda-agent-orchestrator'));
    assert.ok(lockPath.includes('runtime'));
    assert.ok(lockPath.endsWith('.lifecycle-operation.lock'));
});

// ---------------------------------------------------------------------------
// withLifecycleOperationLock (synchronous)
// ---------------------------------------------------------------------------

test('withLifecycleOperationLock acquires and releases lock', () => {
    const tmp = mkTmpDir();
    try {
        const result = withLifecycleOperationLock(tmp, 'test-sync', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            assert.ok(fs.existsSync(lockPath), 'lock should exist during callback');
            return 42;
        });
        assert.equal(result, 42);
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock supports synchronous re-entrancy', () => {
    const tmp = mkTmpDir();
    try {
        const result = withLifecycleOperationLock(tmp, 'outer', () => {
            return withLifecycleOperationLock(tmp, 'inner', () => {
                return 'nested';
            });
        });
        assert.equal(result, 'nested');
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after outer callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock releases lock on callback error', () => {
    const tmp = mkTmpDir();
    try {
        assert.throws(
            () => withLifecycleOperationLock(tmp, 'error-test', () => {
                throw new Error('callback error');
            }),
            /callback error/
        );
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after error');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims lock from dead process', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'stale-test',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        const result = withLifecycleOperationLock(tmp, 'reclaim', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim aged foreign-host lock without explicit override', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        let error: Error | null = null;
        try {
            withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }
        assert.ok(error, 'foreign-host lock should block without explicit override');
        assert.match(error.message, /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1/);
        assert.doesNotMatch(String(error.message), /remote-build-host/);
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged pid-only lock with dead PID and unknown host', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            operation: 'legacy-partial',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'recover-pid-only', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock when explicit override is enabled', () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock with call-scoped override', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed', {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock explicit false override wins over env-based recovery', () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed', {
                allowForeignHostStaleRecovery: false
            }),
            /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1|GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim fresh foreign-host lock before stale threshold', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-fresh',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'should-fail', () => 'nope'),
            /Another lifecycle operation is already running/
        );
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock writes correct owner metadata', () => {
    const tmp = mkTmpDir();
    try {
        withLifecycleOperationLock(tmp, 'metadata-test', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            const ownerPath = path.join(lockPath, 'owner.json');
            const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
            assert.equal(owner.pid, process.pid);
            assert.equal(owner.hostname, os.hostname());
            assert.equal(owner.operation, 'metadata-test');
            assert.ok(typeof owner.acquired_at_utc === 'string');
            assert.ok(typeof owner.target_root === 'string');
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// withLifecycleOperationLockAsync
// ---------------------------------------------------------------------------

test('withLifecycleOperationLockAsync acquires and releases lock', async () => {
    const tmp = mkTmpDir();
    try {
        const result = await withLifecycleOperationLockAsync(tmp, 'async-test', async () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            assert.ok(fs.existsSync(lockPath), 'lock should exist during callback');
            return 42;
        });
        assert.equal(result, 42);
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after callback');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync releases lock on callback error', async () => {
    const tmp = mkTmpDir();
    try {
        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'error-test', async () => {
                throw new Error('async callback error');
            }),
            /async callback error/
        );
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock should be released after error');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync serializes concurrent callers', async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp, 'op1', async () => {
            executionOrder.push('op1-start');
            await new Promise((r) => setTimeout(r, 50));
            executionOrder.push('op1-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp, 'op2', async () => {
            executionOrder.push('op2-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('op2-end');
        });
        await Promise.all([p1, p2]);
        assert.equal(executionOrder[0], 'op1-start');
        assert.equal(executionOrder[1], 'op1-end');
        assert.equal(executionOrder[2], 'op2-start');
        assert.equal(executionOrder[3], 'op2-end');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync serializes three concurrent callers', async () => {
    const tmp = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp, 'a', async () => {
            executionOrder.push('a-start');
            await new Promise((r) => setTimeout(r, 30));
            executionOrder.push('a-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp, 'b', async () => {
            executionOrder.push('b-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('b-end');
        });
        const p3 = withLifecycleOperationLockAsync(tmp, 'c', async () => {
            executionOrder.push('c-start');
            executionOrder.push('c-end');
        });
        await Promise.all([p1, p2, p3]);
        // All three should run sequentially: a completes, then b, then c
        assert.deepEqual(executionOrder, [
            'a-start', 'a-end',
            'b-start', 'b-end',
            'c-start', 'c-end'
        ]);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync allows independent targets concurrently', async () => {
    const tmp1 = mkTmpDir();
    const tmp2 = mkTmpDir();
    const executionOrder: string[] = [];
    try {
        const p1 = withLifecycleOperationLockAsync(tmp1, 'target1', async () => {
            executionOrder.push('t1-start');
            await new Promise((r) => setTimeout(r, 30));
            executionOrder.push('t1-end');
        });
        const p2 = withLifecycleOperationLockAsync(tmp2, 'target2', async () => {
            executionOrder.push('t2-start');
            await new Promise((r) => setTimeout(r, 10));
            executionOrder.push('t2-end');
        });
        await Promise.all([p1, p2]);
        // Both should start before either finishes (different targets)
        assert.equal(executionOrder[0], 't1-start');
        assert.equal(executionOrder[1], 't2-start');
    } finally {
        fs.rmSync(tmp1, { recursive: true, force: true });
        fs.rmSync(tmp2, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not reclaim aged foreign-host lock without explicit override', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        let error: Error | null = null;
        try {
            await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed');
        } catch (caught: unknown) {
            error = caught instanceof Error ? caught : new Error(String(caught));
        }
        assert.ok(error, 'async foreign-host lock should block without explicit override');
        assert.match(error.message, /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1/);
        assert.doesNotMatch(String(error.message), /remote-build-host/);
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not reclaim fresh foreign-host lock before stale threshold', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-fresh',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'async-fresh-foreign', async () => 'nope'),
            /Another lifecycle operation is already running/
        );
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock when explicit override is enabled', async () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock with call-scoped override', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed', {
            allowForeignHostStaleRecovery: true
        });
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged pid-only lock with dead PID and unknown host', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            operation: 'legacy-partial',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await withLifecycleOperationLockAsync(tmp, 'async-pid-only', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync explicit false override wins over env-based recovery', async () => {
    const tmp = mkTmpDir();
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'async-foreign', async () => 'reclaimed', {
                allowForeignHostStaleRecovery: false
            }),
            /GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS=1|GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims aged foreign-host lock when shared file-lock env alias is enabled', () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-foreign-host', () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync reclaims aged foreign-host lock when shared file-lock env alias is enabled', async () => {
    const tmp = mkTmpDir();
    const previousLifecycleEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    const previousFileLockEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            operation: 'remote-stale',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = await withLifecycleOperationLockAsync(tmp, 'reclaim-foreign-host', async () => 'reclaimed');
        assert.equal(result, 'reclaimed');
    } finally {
        if (previousLifecycleEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS = previousLifecycleEnv;
        }
        if (previousFileLockEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousFileLockEnv;
        }
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Grace-period recovery for SIGKILL-orphaned locks
// ---------------------------------------------------------------------------

test('withLifecycleOperationLock reclaims SIGKILL-orphaned lock with missing metadata after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate SIGKILL crash: lock directory exists but no owner.json
        fs.mkdirSync(lockPath);
        // Age the lock beyond the grace period
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-orphan', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock does not reclaim orphaned lock within grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate very recent SIGKILL crash: lock directory exists, no owner.json,
        // but within the grace period (mtime is now)
        fs.mkdirSync(lockPath);

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'too-early', () => 'should-not-reach'),
            /Another lifecycle operation is already running/
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock redacts absolute target and lock paths in contention errors', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            operation: 'blocker',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        assert.throws(
            () => withLifecycleOperationLock(tmp, 'should-fail', () => 'nope'),
            function (error: unknown) {
                assert.ok(error instanceof Error);
                assert.ok(error.message.includes("Another lifecycle operation is already running for '.'"));
                assert.ok(error.message.includes("lock='garda-agent-orchestrator/runtime/.lifecycle-operation.lock'"));
                assert.ok(!error.message.includes(lockPath.replace(/\\/g, '/')));
                return true;
            }
        );
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims SIGKILL-orphaned lock with corrupt metadata after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        // Write corrupt metadata that parses to all-null fields
        fs.writeFileSync(path.join(lockPath, 'owner.json'), 'NOT VALID JSON{{{', 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-corrupt', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock reclaims lock with partial metadata (hostname only, no PID) after grace period', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        // Write partial metadata with hostname but no valid PID
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            hostname: os.hostname(),
            operation: 'partial-write'
        }), 'utf8');
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = withLifecycleOperationLock(tmp, 'reclaim-partial', () => 'recovered');
        assert.equal(result, 'recovered');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLockAsync does not poison queue on acquisition failure', async () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        // Simulate a live-process lock that cannot be reclaimed
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            operation: 'blocker',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        // First async call should fail because the lock is held by us externally
        await assert.rejects(
            () => withLifecycleOperationLockAsync(tmp, 'should-fail', async () => 'nope'),
            /Another lifecycle operation is already running/
        );

        // Remove the blocking lock
        fs.rmSync(lockPath, { recursive: true, force: true });

        // Second async call must succeed — queue must not be poisoned
        const result = await withLifecycleOperationLockAsync(tmp, 'should-succeed', async () => 'ok');
        assert.equal(result, 'ok');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Metadata-write-failure cleanup
// ---------------------------------------------------------------------------

test('withLifecycleOperationLock cleans up lock directory when metadata write fails', () => {
    const tmp = mkTmpDir();
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
            () => withLifecycleOperationLock(tmp, 'meta-fail', () => 'unreachable'),
            /Simulated metadata write failure/
        );
        assert.ok(intercepted, 'writeFileSync interception should have fired');
        const lockPath = getLifecycleOperationLockPath(tmp);
        assert.ok(!fs.existsSync(lockPath), 'lock directory should be cleaned up after metadata write failure');
    } finally {
        realFs.writeFileSync = originalWriteFileSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock stale recovery does not leave .stale- temp directories', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        const lockParent = path.dirname(lockPath);
        fs.mkdirSync(lockParent, { recursive: true });
        fs.mkdirSync(lockPath);
        // Simulate dead-process lock
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'dead-test',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        withLifecycleOperationLock(tmp, 'check-cleanup', () => {
            const entries = fs.readdirSync(lockParent);
            const staleEntries = entries.filter((e: string) => e.includes('.stale-'));
            assert.equal(staleEntries.length, 0, 'no stale temp directories should remain');
        });
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('withLifecycleOperationLock retries transient EBUSY during release and preserves callback result', () => {
    const tmp = mkTmpDir();
    const realFs = require('node:fs');
    const originalRmSync = realFs.rmSync;
    let interceptedRetries = 0;
    try {
        const result = withLifecycleOperationLock(tmp, 'release-retry', () => {
            const lockPath = getLifecycleOperationLockPath(tmp);
            realFs.rmSync = function (...args: unknown[]) {
                const targetPath = typeof args[0] === 'string' ? path.resolve(args[0]) : '';
                if (targetPath === path.resolve(lockPath) && interceptedRetries < 2) {
                    interceptedRetries += 1;
                    const error = new Error('EBUSY: simulated transient lifecycle release contention') as NodeJS.ErrnoException;
                    error.code = 'EBUSY';
                    throw error;
                }
                return originalRmSync.apply(realFs, args as [string, fs.RmOptions?]);
            };
            return 'ok';
        });

        assert.equal(result, 'ok');
        assert.equal(interceptedRetries, 2, 'lifecycle release should retry transient contention');
        assert.ok(!fs.existsSync(getLifecycleOperationLockPath(tmp)), 'lock should be released after retry recovery');
    } finally {
        realFs.rmSync = originalRmSync;
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// Lifecycle lock telemetry (getLastLifecycleLockTelemetry)
// ---------------------------------------------------------------------------

test('getLastLifecycleLockTelemetry returns telemetry after sync lock', () => {
    const tmp = mkTmpDir();
    try {
        withLifecycleOperationLock(tmp, 'tel-test', () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.ok(typeof tel!.elapsedMs === 'number');
        assert.equal(tel!.staleLockRecovered, false);
        assert.equal(tel!.queueWaitMs, 0);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('getLastLifecycleLockTelemetry reports stale recovery after dead lock reclaim', () => {
    const tmp = mkTmpDir();
    try {
        const lockPath = getLifecycleOperationLockPath(tmp);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            operation: 'dead',
            acquired_at_utc: new Date().toISOString(),
            target_root: tmp
        }));

        withLifecycleOperationLock(tmp, 'reclaim-tel', () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.equal(tel!.staleLockRecovered, true);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('getLastLifecycleLockTelemetry returns telemetry after async lock', async () => {
    const tmp = mkTmpDir();
    try {
        await withLifecycleOperationLockAsync(tmp, 'async-tel-test', async () => 'done');
        const tel = getLastLifecycleLockTelemetry();
        assert.ok(tel != null, 'telemetry should be available');
        assert.ok(typeof tel!.elapsedMs === 'number');
        assert.ok(typeof tel!.queueWaitMs === 'number');
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});
