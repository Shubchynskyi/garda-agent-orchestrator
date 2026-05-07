import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
    cleanupStaleReviewArtifactLocks,
    getReviewArtifactLockPath,
    getReviewArtifactTransactionLockPath,
    scanReviewArtifactLocks,
    withReviewArtifactReadBarrier,
    writeReviewArtifactJson,
    writeReviewArtifactsWithRollback,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review-artifacts';
import {
    loadIndex,
    resolveIndexPath,
    resolveIndexLockPath
} from '../../../src/gate-runtime/reviews-index';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../src/gate-runtime/task-events';

function listTempArtifacts(directoryPath: string): string[] {
    return fs.readdirSync(directoryPath).filter((entry) => entry.includes('.tmp-'));
}

function createReviewsDir(root: string): string {
    const reviewsDir = path.join(root, 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    return reviewsDir;
}

async function delay(milliseconds: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function holdReviewArtifactLock(lockPath: string, holdMs: number): Promise<() => Promise<void>> {
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
                reject(new Error(stderr || 'Timed out waiting for review-artifact lock holder'));
            }
        }, 10);
        child.once('error', (error) => {
            clearInterval(timer);
            reject(error);
        });
        child.once('exit', (code) => {
            if (!fs.existsSync(path.join(lockPath, 'owner.json')) && code !== 0) {
                clearInterval(timer);
                reject(new Error(stderr || `review-artifact lock holder exited with code ${code}`));
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

test('writeReviewArtifactJson writes JSON and cleans up the transient lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-001-task-mode.json');

    writeReviewArtifactJson(artifactPath, {
        task_id: 'T-001',
        status: 'PASSED'
    });

    assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
        task_id: 'T-001',
        status: 'PASSED'
    });
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactText replaces existing content without leaving temp files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-002-review-output.log');
    fs.writeFileSync(artifactPath, 'old content\n', 'utf8');

    writeReviewArtifactText(artifactPath, 'new content\n');

    assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'new content\n');
    assert.equal(fs.existsSync(getReviewArtifactLockPath(artifactPath)), false);
    assert.deepEqual(listTempArtifacts(tempDir), []);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactText reports review index update status', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-index-status-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-011-code.md');

    try {
        const result = writeReviewArtifactText(artifactPath, 'REVIEW PASSED\n');

        assert.equal(result.index_update_status, 'updated');
        assert.ok(result.index_path.endsWith('/runtime/reviews/reviews-index.json') || result.index_path.endsWith('\\runtime\\reviews\\reviews-index.json'));
        const index = loadIndex(reviewsDir).index;
        assert.ok(index.entries.some((entry) => entry.fileName === 'T-011-code.md'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactText surfaces index failures and rolls back critical writes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-index-failure-'));
    const reviewsDir = createReviewsDir(tempDir);
    const artifactPath = path.join(reviewsDir, 'T-012-code.md');
    const criticalArtifactPath = path.join(reviewsDir, 'T-012-test.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);

    try {
        fs.mkdirSync(indexLockPath, { recursive: true });
        fs.writeFileSync(path.join(indexLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const result = writeReviewArtifactText(
            artifactPath,
            'REVIEW PASSED\n',
            { lockTimeoutMs: 75, lockRetryMs: 10 }
        );

        assert.equal(result.index_update_status, 'failed');
        assert.match(result.index_update_error || '', /file lock/);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), 'REVIEW PASSED\n');

        assert.throws(
            () => writeReviewArtifactText(
                criticalArtifactPath,
                'REVIEW PASSED\n',
                { lockTimeoutMs: 75, lockRetryMs: 10, requireIndexUpdate: true }
            ),
            /Review artifact index update failed/
        );
        assert.equal(fs.existsSync(criticalArtifactPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson fails when a live review-artifact lock already exists', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-003-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    }, null, 2) + '\n', 'utf8');

    assert.throws(
        () => writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-003' },
            { lockTimeoutMs: 75, lockRetryMs: 10 }
        ),
        /Timed out acquiring file lock/
    );
    assert.equal(fs.existsSync(artifactPath), false);

    fs.rmSync(tempDir, { recursive: true, force: true });
});

test('writeReviewArtifactJson waits for a short-lived external review-artifact lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-004-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(lockPath, 120);
        const startedAt = Date.now();
        writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-004', status: 'PASSED' },
            { lockTimeoutMs: 1000, lockRetryMs: 20, lockStaleMs: 60000 }
        );
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 80, `sync review-artifact write should wait for brief contention, got ${elapsedMs} ms`);
        assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
            task_id: 'T-004',
            status: 'PASSED'
        });
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson does not reclaim aged foreign-host review-artifact lock without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-005-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        assert.throws(
            () => writeReviewArtifactJson(
                artifactPath,
                { task_id: 'T-005', status: 'PASSED' },
                { lockTimeoutMs: 75, lockRetryMs: 10 }
            ),
            /GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1/
        );
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(lockPath), true);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson reclaims aged foreign-host review-artifact lock when explicit override is enabled', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-005-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = '1';
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        writeReviewArtifactJson(
            artifactPath,
            { task_id: 'T-005', status: 'PASSED' },
            { lockTimeoutMs: 500, lockRetryMs: 10 }
        );

        assert.deepEqual(JSON.parse(fs.readFileSync(artifactPath, 'utf8')), {
            task_id: 'T-005',
            status: 'PASSED'
        });
        assert.equal(fs.existsSync(lockPath), false);
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactJson does not reclaim fresh foreign-host review-artifact lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-'));
    const artifactPath = path.join(tempDir, 'T-006-preflight.json');
    const lockPath = getReviewArtifactLockPath(artifactPath);
    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => writeReviewArtifactJson(
                artifactPath,
                { task_id: 'T-006', status: 'PASSED' },
                { lockTimeoutMs: 75, lockRetryMs: 10, lockStaleMs: 60_000 }
            ),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(lockPath), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks reports active and stale review-artifact locks with task binding', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-scan-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const activeLockPath = path.join(reviewsDir, 'T-007-code.md.lock');
    const staleLockPath = path.join(reviewsDir, 'T-008-preflight.json.lock');

    try {
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(staleLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        assert.equal(result.lock_root, reviewsDir.replace(/\\/g, '/'));
        assert.equal(result.active_count, 1);
        assert.equal(result.stale_count, 1);
        assert.equal(result.locks.length, 2);

        const activeLock = result.locks.find((lock) => lock.lock_name === 'T-007-code.md.lock');
        assert.ok(activeLock, 'expected active review-artifact lock to be reported');
        assert.equal(activeLock!.task_id, 'T-007');
        assert.equal(activeLock!.artifact_type, 'code.md');
        assert.equal(activeLock!.status, 'ACTIVE');

        const staleLock = result.locks.find((lock) => lock.lock_name === 'T-008-preflight.json.lock');
        assert.ok(staleLock, 'expected stale review-artifact lock to be reported');
        assert.equal(staleLock!.task_id, 'T-008');
        assert.equal(staleLock!.artifact_type, 'preflight.json');
        assert.equal(staleLock!.status, 'STALE');
        assert.ok(staleLock!.remediation.includes('doctor --target-root "." --cleanup-stale-locks --dry-run'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cleanupStaleReviewArtifactLocks removes only proven-stale review-artifact locks', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-cleanup-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const activeLockPath = path.join(reviewsDir, 'T-009-test.md.lock');
    const staleLockPath = path.join(reviewsDir, 'T-009-preflight.json.lock');

    try {
        fs.mkdirSync(activeLockPath, { recursive: true });
        fs.writeFileSync(path.join(activeLockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        fs.mkdirSync(staleLockPath, { recursive: true });
        fs.writeFileSync(path.join(staleLockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(staleLockPath, oldTime, oldTime);

        const dryRun = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: true });
        assert.deepEqual(dryRun.removable_stale_locks, ['T-009-preflight.json.lock']);
        assert.deepEqual(dryRun.removed_locks, []);
        assert.ok(fs.existsSync(staleLockPath), 'dry-run must not remove stale review-artifact locks');

        const applied = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: false });
        assert.deepEqual(applied.removed_locks, ['T-009-preflight.json.lock']);
        assert.ok(fs.existsSync(activeLockPath), 'active review-artifact lock must be preserved');
        assert.equal(fs.existsSync(staleLockPath), false, 'stale review-artifact lock should be removed');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('cleanupStaleReviewArtifactLocks retains aged foreign-host review-artifact locks without explicit override', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-artifact-foreign-cleanup-'));
    const reviewsDir = path.join(tempDir, 'runtime', 'reviews');
    const lockPath = path.join(reviewsDir, 'T-010-code.md.lock');
    const previousEnv = process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
    delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;

    try {
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: 'remote-build-host',
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(lockPath, oldTime, oldTime);

        const result = cleanupStaleReviewArtifactLocks(tempDir, { dryRun: false });
        assert.deepEqual(result.removed_locks, []);
        assert.ok(result.retained_live_locks.includes('T-010-code.md.lock'));
        assert.ok(result.warnings.some((warning) => warning.includes('GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS=1')));
        assert.equal(fs.existsSync(lockPath), true, 'cleanup must preserve aged foreign-host review-artifact lock without explicit override');
    } finally {
        if (previousEnv === undefined) {
            delete process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS;
        } else {
            process.env.GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS = previousEnv;
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks includes the shared reviews-index lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-index-lock-scan-'));
    const runtimeDir = path.join(tempDir, 'runtime');
    const indexLockPath = path.join(runtimeDir, '.reviews-index.lock');

    try {
        fs.mkdirSync(indexLockPath, { recursive: true });
        fs.writeFileSync(path.join(indexLockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(indexLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        const sharedLock = result.locks.find((lock) => lock.lock_name === '.reviews-index.lock');
        assert.ok(sharedLock, 'expected shared reviews-index lock to be reported');
        assert.equal(sharedLock!.task_id, null);
        assert.equal(sharedLock!.artifact_type, 'reviews-index');
        assert.equal(sharedLock!.status, 'STALE');
        assert.ok(sharedLock!.artifact_path.endsWith('/runtime/reviews/reviews-index.json'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('scanReviewArtifactLocks includes the shared reviews transaction lock', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-lock-scan-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);

    try {
        fs.mkdirSync(transactionLockPath, { recursive: true });
        fs.writeFileSync(path.join(transactionLockPath, 'owner.json'), JSON.stringify({
            pid: 999999999,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');
        const oldTime = new Date(Date.now() - (31 * 60 * 1000));
        fs.utimesSync(transactionLockPath, oldTime, oldTime);

        const result = scanReviewArtifactLocks(tempDir);
        const sharedLock = result.locks.find((lock) => lock.lock_name === '.reviews-transaction.lock');
        assert.ok(sharedLock, 'expected shared reviews transaction lock to be reported');
        assert.equal(sharedLock!.task_id, null);
        assert.equal(sharedLock!.artifact_type, 'reviews-transaction');
        assert.equal(sharedLock!.status, 'STALE');
        assert.ok(sharedLock!.artifact_path.endsWith('/runtime/reviews'));
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex waits for a live review artifact transaction lock before rebuilding', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-read-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 140);
        const startedAt = Date.now();
        const result = loadIndex(reviewsDir);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 90, `index load should wait for transaction lock, got ${elapsedMs} ms`);
        assert.equal(result.source, 'rebuilt');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex waits for the transaction lock before returning a fresh cache hit', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-cache-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        writeReviewArtifactText(path.join(reviewsDir, 'T-016-code.md'), 'REVIEW PASSED\n');
        const warmCache = loadIndex(reviewsDir);
        assert.equal(warmCache.source, 'cache');

        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 140);
        const startedAt = Date.now();
        const result = loadIndex(reviewsDir);
        const elapsedMs = Date.now() - startedAt;

        assert.ok(elapsedMs >= 90, `cache-hit index load should wait for transaction lock, got ${elapsedMs} ms`);
        assert.equal(result.source, 'cache');
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex read-only mode does not create a transaction lock when no transaction is active', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-readonly-index-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);

    try {
        const result = loadIndex(reviewsDir, { readOnly: true });

        assert.equal(result.source, 'rebuilt');
        assert.equal(fs.existsSync(transactionLockPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('loadIndex uses the in-process pre-transaction snapshot during an async review transaction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-snapshot-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-019-code.md');
    const newPath = path.join(reviewsDir, 'T-020-code.md');

    try {
        writeReviewArtifactText(existingPath, 'old review\n');
        loadIndex(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: newPath,
                contentType: 'text',
                content: 'new review\n'
            }
        ], async () => {
            const duringTransaction = loadIndex(reviewsDir).index;
            assert.equal(duringTransaction.entries.some((entry) => entry.fileName === 'T-019-code.md'), true);
            assert.equal(duringTransaction.entries.some((entry) => entry.fileName === 'T-020-code.md'), false);
            return 'done';
        });

        const committed = loadIndex(reviewsDir).index;
        assert.equal(committed.entries.some((entry) => entry.fileName === 'T-020-code.md'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('withReviewArtifactReadBarrier waits for a live external review transaction lock', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-read-barrier-'));
    const reviewsDir = createReviewsDir(tempDir);
    const transactionLockPath = getReviewArtifactTransactionLockPath(reviewsDir);
    let cleanupChild: (() => Promise<void>) | null = null;

    try {
        cleanupChild = await holdReviewArtifactLock(transactionLockPath, 120);
        const startedAt = Date.now();

        const result = withReviewArtifactReadBarrier(reviewsDir, () => 'read-complete', {
            lockTimeoutMs: 1_000,
            lockRetryMs: 10
        });

        assert.equal(result, 'read-complete');
        assert.ok(Date.now() - startedAt >= 90);
    } finally {
        if (cleanupChild) {
            await cleanupChild();
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('same-process read barrier sees complete staged artifact set during transaction', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-same-process-read-'));
    const reviewsDir = createReviewsDir(tempDir);
    const reviewPath = path.join(reviewsDir, 'T-021-code.md');
    const receiptPath = path.join(reviewsDir, 'T-021-code-receipt.json');

    try {
        writeReviewArtifactText(reviewPath, 'old review\n');
        loadIndex(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: reviewPath,
                contentType: 'text',
                content: 'new review\n'
            },
            {
                artifactPath: receiptPath,
                contentType: 'json',
                payload: {
                    task_id: 'T-021',
                    review_type: 'code'
                }
            }
        ], async () => {
            const snapshot = withReviewArtifactReadBarrier(reviewsDir, () => ({
                review: fs.readFileSync(reviewPath, 'utf8'),
                receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>,
                indexEntries: loadIndex(reviewsDir).index.entries.map((entry) => entry.fileName).sort()
            }));

            assert.equal(snapshot.review, 'new review\n');
            assert.deepEqual(snapshot.receipt, {
                task_id: 'T-021',
                review_type: 'code'
            });
            assert.equal(snapshot.indexEntries.includes('T-021-code.md'), true);
            assert.equal(snapshot.indexEntries.includes('T-021-code-receipt.json'), false);
            return 'done';
        });

        const committedIndex = loadIndex(reviewsDir).index;
        assert.equal(committedIndex.entries.some((entry) => entry.fileName === 'T-021-code.md'), true);
        assert.equal(committedIndex.entries.some((entry) => entry.fileName === 'T-021-code-receipt.json'), true);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback rolls back all artifacts and refreshes the index after callback failure', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-rollback-'));
    const reviewsDir = createReviewsDir(tempDir);
    const existingPath = path.join(reviewsDir, 'T-013-code.md');
    const newPath = path.join(reviewsDir, 'T-013-code-receipt.json');

    try {
        writeReviewArtifactText(existingPath, 'old review\n');

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: existingPath,
                    contentType: 'text',
                    content: 'new review\n'
                },
                {
                    artifactPath: newPath,
                    contentType: 'json',
                    payload: { task_id: 'T-013' }
                }
            ], async () => {
                throw new Error('simulated telemetry failure');
            }),
            /simulated telemetry failure/
        );

        assert.equal(fs.readFileSync(existingPath, 'utf8'), 'old review\n');
        assert.equal(fs.existsSync(newPath), false);
        const index = loadIndex(reviewsDir).index;
        assert.ok(index.entries.some((entry) => entry.fileName === 'T-013-code.md'));
        assert.equal(index.entries.some((entry) => entry.fileName === 'T-013-code-receipt.json'), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback does not publish new index entries before afterWrites succeeds', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-index-commit-'));
    const reviewsDir = createReviewsDir(tempDir);
    const newPath = path.join(reviewsDir, 'T-017-code.md');

    try {
        loadIndex(reviewsDir);
        const indexPath = resolveIndexPath(reviewsDir);

        await writeReviewArtifactsWithRollback([
            {
                artifactPath: newPath,
                contentType: 'text',
                content: 'REVIEW PASSED\n'
            }
        ], async () => {
            const duringTransactionIndex = JSON.parse(fs.readFileSync(indexPath, 'utf8')) as {
                entries: Array<{ fileName: string }>;
            };
            assert.equal(
                duringTransactionIndex.entries.some((entry) => entry.fileName === 'T-017-code.md'),
                false
            );
            return 'done';
        });

        const committedIndex = loadIndex(reviewsDir).index;
        assert.equal(
            committedIndex.entries.some((entry) => entry.fileName === 'T-017-code.md'),
            true
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback rolls back visible artifacts when commit index persistence fails', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-index-failure-'));
    const reviewsDir = createReviewsDir(tempDir);
    const newPath = path.join(reviewsDir, 'T-018-code.md');
    const indexLockPath = resolveIndexLockPath(reviewsDir);
    let lockHandle: ReturnType<typeof acquireFilesystemLock>['handle'] | null = null;

    try {
        loadIndex(reviewsDir);
        lockHandle = acquireFilesystemLock(indexLockPath, {
            timeoutMs: 500,
            retryMs: 10
        }).handle;

        await assert.rejects(
            () => writeReviewArtifactsWithRollback([
                {
                    artifactPath: newPath,
                    contentType: 'text',
                    content: 'REVIEW PASSED\n'
                }
            ], async () => 'after-writes-ok', { lockTimeoutMs: 75, lockRetryMs: 10 }),
            /Review artifact transaction index commit failed/
        );

        assert.equal(fs.existsSync(newPath), false);
    } finally {
        if (lockHandle) {
            releaseFilesystemLock(lockHandle);
        }
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('writeReviewArtifactsWithRollback uses an async transaction lock for concurrent async callbacks', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-transaction-async-lock-'));
    const reviewsDir = createReviewsDir(tempDir);
    const firstPath = path.join(reviewsDir, 'T-014-code.md');
    const secondPath = path.join(reviewsDir, 'T-015-code.md');
    let firstCallbackStarted = false;
    let secondCallbackStarted = false;

    try {
        const first = writeReviewArtifactsWithRollback([
            {
                artifactPath: firstPath,
                contentType: 'text',
                content: 'first review\n'
            }
        ], async () => {
            firstCallbackStarted = true;
            await delay(120);
            return 'first';
        }, { lockTimeoutMs: 1_000, lockRetryMs: 10 });

        await delay(20);

        const second = writeReviewArtifactsWithRollback([
            {
                artifactPath: secondPath,
                contentType: 'text',
                content: 'second review\n'
            }
        ], async () => {
            secondCallbackStarted = true;
            return 'second';
        }, { lockTimeoutMs: 1_000, lockRetryMs: 10 });

        const progressProbe = Promise.race([
            first.then(() => 'first-complete'),
            delay(250).then(() => 'timeout')
        ]);
        assert.equal(await progressProbe, 'first-complete');

        const results = await Promise.all([first, second]);
        assert.deepEqual(results, ['first', 'second']);
        assert.equal(firstCallbackStarted, true);
        assert.equal(secondCallbackStarted, true);
        assert.equal(fs.readFileSync(firstPath, 'utf8'), 'first review\n');
        assert.equal(fs.readFileSync(secondPath, 'utf8'), 'second review\n');
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
