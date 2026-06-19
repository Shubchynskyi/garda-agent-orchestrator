import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getLifecycleOperationLockPath } from '../../../../src/lifecycle/common';
import { listBackups } from '../../../../src/lifecycle/backups';
import { runCliWithCapturedOutput } from './gate-test-helpers';

function makeWorkspace(prefix: string): { targetRoot: string; bundleRoot: string } {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
    return { targetRoot, bundleRoot };
}

function combinedOutput(result: { logs: readonly string[]; errors: readonly string[] }): string {
    return [...result.logs, ...result.errors].join('\n');
}

function seedLifecycleOperationLock(targetRoot: string): void {
    const lockPath = getLifecycleOperationLockPath(targetRoot);
    const now = new Date().toISOString();
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: process.pid,
        hostname: os.hostname(),
        operation: 'update',
        acquired_at_utc: now,
        heartbeat_at_utc: now,
        target_root: path.resolve(targetRoot)
    }, null, 2), 'utf8');
}

describe('backup create CLI command', () => {
    it('prints a dry-run preview without creating a backup', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-dry-run-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--dry-run'
            ], { cwd: targetRoot });

            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /Status: SKIPPED_DRY_RUN/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('rejects mutating create without explicit confirmation', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-confirm-required-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot
            ], { cwd: targetRoot });

            assert.notEqual(result.exitCode, 0);
            assert.match(combinedOutput(result), /requires --confirm/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('creates a manual backup snapshot when confirmed', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-confirmed-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm'
            ], { cwd: targetRoot });

            const backups = listBackups(targetRoot);
            assert.equal(result.exitCode, 0);
            assert.match(combinedOutput(result), /Status: SUCCESS/u);
            assert.match(combinedOutput(result), /BackupId: manual-/u);
            assert.equal(backups.length, 1);
            assert.equal(backups[0].reason, 'manual');
            assert.equal(backups[0].health, 'AVAILABLE');
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('does not create a confirmed backup while another lifecycle operation holds the lock', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-lock-held-');
        try {
            seedLifecycleOperationLock(targetRoot);
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm'
            ], { cwd: targetRoot });

            assert.notEqual(result.exitCode, 0);
            assert.match(combinedOutput(result), /Another lifecycle operation is already running/u);
            assert.equal(listBackups(targetRoot).length, 0);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });

    it('emits machine-readable JSON for confirmed manual backups', async () => {
        const { targetRoot } = makeWorkspace('gao-cli-backup-json-');
        try {
            const result = await runCliWithCapturedOutput([
                'backup',
                'create',
                '--target-root',
                targetRoot,
                '--confirm',
                '--json'
            ], { cwd: targetRoot });

            const parsed = JSON.parse(result.logs.join('\n')) as Record<string, unknown>;
            assert.equal(result.exitCode, 0);
            assert.equal(parsed.backupMode, 'manual');
            assert.equal(parsed.status, 'SUCCESS');
            assert.equal(typeof parsed.backupId, 'string');
            assert.match(String(parsed.backupId), /^manual-/u);
            assert.equal(listBackups(targetRoot).length, 1);
        } finally {
            fs.rmSync(targetRoot, { recursive: true, force: true });
        }
    });
});
