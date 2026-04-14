import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';

import {
    getReviewArtifactLockPath,
    writeReviewArtifactJson,
    writeReviewArtifactText
} from '../../../src/gate-runtime/review-artifacts';

function listTempArtifacts(directoryPath: string): string[] {
    return fs.readdirSync(directoryPath).filter((entry) => entry.includes('.tmp-'));
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
