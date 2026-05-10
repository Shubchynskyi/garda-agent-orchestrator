import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    fs,
    path,
    spawn,
    inspectCompletionGateFinalizationLock,
    scanCompletionGateFinalizationLocks,
    withCompletionGateFinalizationLockAsync,
    makeTempDir,
    writeActiveCompletionLock
} from './task-audit-summary-fixtures';

describe('gates/finalization-lock', () => {
    it('does not throw when owner metadata is missing during lock inspection', () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const lockPath = writeActiveCompletionLock(reviewsDir, 'T-LOCK-1');
        const ownerPath = path.join(lockPath, 'owner.json');

        try {
            fs.rmSync(ownerPath, { force: true });
            const inspection = inspectCompletionGateFinalizationLock(reviewsDir, 'T-LOCK-1');
            assert.equal(inspection.lock_path, lockPath.replace(/\\/g, '/'));
            assert.equal(typeof inspection.active, 'boolean');
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('reports contention with timeout diagnostics when a live completion finalization lock is held elsewhere', async () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const taskId = 'T-LOCK-TIMEOUT';
        const lockPath = path.join(reviewsDir, `${taskId}-completion-gate.lock`);
        const ownerPath = path.join(lockPath, 'owner.json');
        const child = spawn(
            process.execPath,
            [
                '-e',
                [
                    'const fs = require("node:fs");',
                    'const os = require("node:os");',
                    'const path = require("node:path");',
                    'const lockPath = process.argv[1];',
                    'fs.mkdirSync(lockPath, { recursive: true });',
                    'fs.writeFileSync(path.join(lockPath, "owner.json"), JSON.stringify({',
                    '  pid: process.pid,',
                    '  hostname: os.hostname(),',
                    '  created_at_utc: new Date().toISOString()',
                    '}), "utf8");',
                    'setTimeout(() => {}, 10000);'
                ].join(' '),
                lockPath
            ],
            { stdio: 'ignore' }
        );

        try {
            for (let attempt = 0; attempt < 20 && !fs.existsSync(ownerPath); attempt += 1) {
                await new Promise((resolve) => setTimeout(resolve, 50));
            }
            assert.equal(fs.existsSync(ownerPath), true, 'expected helper process to materialize owner metadata');

            await assert.rejects(
                () => withCompletionGateFinalizationLockAsync(reviewsDir, taskId, async () => undefined),
                /Timed out acquiring file lock: .*timeout_ms=5000/
            );
        } finally {
            child.kill();
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it('propagates unexpected scan errors instead of treating completion locks as absent', () => {
        const tmpDir = makeTempDir();
        const reviewsDir = path.join(tmpDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const realFs = require('node:fs') as typeof fs & { readdirSync: typeof fs.readdirSync };
        const originalReaddirSync = realFs.readdirSync;

        try {
            realFs.readdirSync = function (..._args: unknown[]): never {
                const error = new Error('permission denied') as NodeJS.ErrnoException;
                error.code = 'EACCES';
                throw error;
            };
            assert.throws(
                () => scanCompletionGateFinalizationLocks(reviewsDir),
                /permission denied/
            );
        } finally {
            realFs.readdirSync = originalReaddirSync;
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});
