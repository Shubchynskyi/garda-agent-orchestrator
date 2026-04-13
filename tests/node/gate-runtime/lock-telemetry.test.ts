import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    classifyLockContention,
    buildLockWaitDiagnostics,
    acquireFilesystemLock,
    acquireFilesystemLockAsync,
    releaseFilesystemLock
} from '../../../src/gate-runtime/task-events';

import type {
    LockContentionLevel,
    AcquireLockTelemetry,
    LockWaitDiagnostics
} from '../../../src/gate-runtime/task-events';

function mkTmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-locktel-'));
}

// ---------------------------------------------------------------------------
// classifyLockContention
// ---------------------------------------------------------------------------

test('classifyLockContention returns none for zero retries and low elapsed', () => {
    assert.equal(classifyLockContention(0, 0), 'none');
    assert.equal(classifyLockContention(0, 10), 'none');
    assert.equal(classifyLockContention(0, 49), 'none');
});

test('classifyLockContention returns low for few retries under 500ms', () => {
    assert.equal(classifyLockContention(1, 25), 'low');
    assert.equal(classifyLockContention(5, 200), 'low');
    assert.equal(classifyLockContention(9, 499), 'low');
});

test('classifyLockContention returns moderate for mid-range contention', () => {
    assert.equal(classifyLockContention(10, 500), 'moderate');
    assert.equal(classifyLockContention(50, 1000), 'moderate');
    assert.equal(classifyLockContention(99, 2400), 'moderate');
});

test('classifyLockContention returns high for severe contention', () => {
    assert.equal(classifyLockContention(100, 3000), 'high');
    assert.equal(classifyLockContention(500, 5000), 'high');
    assert.equal(classifyLockContention(200, 10000), 'high');
});

test('classifyLockContention treats high elapsed with zero retries as none', () => {
    // Zero retries but slow filesystem — still considered no contention
    // because no retry loop ran.
    assert.equal(classifyLockContention(0, 100), 'none');
});

test('classifyLockContention handles boundary between low and moderate', () => {
    // Exactly at warn threshold (10 retries) with >= 500ms → moderate
    assert.equal(classifyLockContention(10, 500), 'moderate');
    // Below threshold with >= 500ms → moderate (elapsed pushes past low)
    assert.equal(classifyLockContention(5, 600), 'moderate');
});

// ---------------------------------------------------------------------------
// AcquireLockTelemetry fields on acquireFilesystemLock
// ---------------------------------------------------------------------------

test('acquireFilesystemLock returns telemetry with contention level none on fresh lock', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-tel.lock');
    try {
        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.equal(telemetry.contentionLevel, 'none');
        assert.equal(telemetry.staleLockRecovered, false);
        assert.equal(telemetry.staleLockReason, null);
        assert.equal(telemetry.retries, 0);
        assert.ok(typeof telemetry.elapsedMs === 'number');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reports stale recovery in telemetry when reclaiming dead lock', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-tel-dead.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));

        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'owner_dead');
        assert.equal(telemetry.retries, 0);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLock reports stale recovery for missing metadata after grace period', () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-tel-orphan.lock');
    try {
        fs.mkdirSync(lockPath);
        const oldTime = new Date(Date.now() - 5000);
        fs.utimesSync(lockPath, oldTime, oldTime);

        const { handle, telemetry } = acquireFilesystemLock(lockPath);
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'owner_dead');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// AcquireLockTelemetry fields on acquireFilesystemLockAsync
// ---------------------------------------------------------------------------

test('acquireFilesystemLockAsync returns telemetry with contention level none on fresh lock', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-tel.lock');
    try {
        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, { timeoutMs: 2000 });
        assert.equal(telemetry.contentionLevel, 'none');
        assert.equal(telemetry.staleLockRecovered, false);
        assert.equal(telemetry.staleLockReason, null);
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('acquireFilesystemLockAsync reports stale recovery for dead process lock', async () => {
    const tmp = mkTmpDir();
    const lockPath = path.join(tmp, '.test-async-tel-dead.lock');
    try {
        fs.mkdirSync(lockPath);
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }));

        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, { timeoutMs: 2000, retryMs: 10 });
        assert.equal(telemetry.staleLockRecovered, true);
        assert.equal(telemetry.staleLockReason, 'owner_dead');
        releaseFilesystemLock(handle);
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// buildLockWaitDiagnostics
// ---------------------------------------------------------------------------

test('buildLockWaitDiagnostics returns no contention for clean telemetry', () => {
    const diagnostics = buildLockWaitDiagnostics({
        task_lock_retries: 0,
        task_lock_elapsed_ms: 2,
        task_lock_contention_level: 'none',
        task_lock_stale_recovered: false,
        task_lock_stale_reason: null,
        aggregate_lock_retries: 0,
        aggregate_lock_elapsed_ms: 1,
        aggregate_lock_contention_level: 'none',
        aggregate_lock_stale_recovered: false,
        aggregate_lock_stale_reason: null,
        aggregate_append_mode: 'lock_free'
    });
    assert.equal(diagnostics.overall_contention_level, 'none');
    assert.equal(diagnostics.summary, 'No lock contention detected.');
    assert.equal(diagnostics.task_lock.contention_level, 'none');
    assert.equal(diagnostics.aggregate_lock.contention_level, 'none');
});

test('buildLockWaitDiagnostics picks higher contention level across both locks', () => {
    const diagnostics = buildLockWaitDiagnostics({
        task_lock_retries: 5,
        task_lock_elapsed_ms: 200,
        task_lock_contention_level: 'low',
        task_lock_stale_recovered: false,
        task_lock_stale_reason: null,
        aggregate_lock_retries: 50,
        aggregate_lock_elapsed_ms: 1000,
        aggregate_lock_contention_level: 'moderate',
        aggregate_lock_stale_recovered: false,
        aggregate_lock_stale_reason: null,
        aggregate_append_mode: 'locked_prune'
    });
    assert.equal(diagnostics.overall_contention_level, 'moderate');
    assert.ok(diagnostics.summary.includes('moderate'));
    assert.ok(diagnostics.summary.includes('aggregate_lock'));
});

test('buildLockWaitDiagnostics includes stale recovery in summary', () => {
    const diagnostics = buildLockWaitDiagnostics({
        task_lock_retries: 15,
        task_lock_elapsed_ms: 800,
        task_lock_contention_level: 'moderate',
        task_lock_stale_recovered: true,
        task_lock_stale_reason: 'owner_dead',
        aggregate_lock_retries: 0,
        aggregate_lock_elapsed_ms: 1,
        aggregate_lock_contention_level: 'none',
        aggregate_lock_stale_recovered: false,
        aggregate_lock_stale_reason: null,
        aggregate_append_mode: 'lock_free'
    });
    assert.equal(diagnostics.overall_contention_level, 'moderate');
    assert.ok(diagnostics.summary.includes('stale_recovered=true'));
    assert.ok(diagnostics.summary.includes('owner_dead'));
    assert.equal(diagnostics.task_lock.stale_recovered, true);
    assert.equal(diagnostics.task_lock.stale_reason, 'owner_dead');
});

test('buildLockWaitDiagnostics handles undefined lock_telemetry gracefully', () => {
    const diagnostics = buildLockWaitDiagnostics(undefined);
    assert.equal(diagnostics.overall_contention_level, 'none');
    assert.equal(diagnostics.summary, 'No lock contention detected.');
    assert.equal(diagnostics.task_lock.retries, 0);
    assert.equal(diagnostics.aggregate_lock.retries, 0);
});

test('buildLockWaitDiagnostics reports high contention correctly', () => {
    const diagnostics = buildLockWaitDiagnostics({
        task_lock_retries: 200,
        task_lock_elapsed_ms: 4000,
        task_lock_contention_level: 'high',
        task_lock_stale_recovered: false,
        task_lock_stale_reason: null,
        aggregate_lock_retries: 150,
        aggregate_lock_elapsed_ms: 3500,
        aggregate_lock_contention_level: 'high',
        aggregate_lock_stale_recovered: true,
        aggregate_lock_stale_reason: 'age_exceeded',
        aggregate_append_mode: 'locked_prune'
    });
    assert.equal(diagnostics.overall_contention_level, 'high');
    assert.ok(diagnostics.summary.includes('task_lock'));
    assert.ok(diagnostics.summary.includes('aggregate_lock'));
    assert.ok(diagnostics.summary.includes('high'));
});
