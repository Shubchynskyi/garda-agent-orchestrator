import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    createBackupSnapshot,
    DEFAULT_BACKUP_KEEP_LATEST,
    listBackups,
    pruneBackups,
    resolveBackupRestoreSnapshotPath
} from '../../../src/lifecycle/backups';
import {
    getRollbackRecordsPath,
    removePathRecursive,
    writeRollbackRecords
} from '../../../src/lifecycle/common';

function makeWorkspace(prefix: string) {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
    return { targetRoot, bundleRoot };
}

function seedRollbackSnapshot(targetRoot: string, name: string): string {
    const snapshotPath = path.join(
        targetRoot,
        'garda-agent-orchestrator',
        'runtime',
        'update-rollbacks',
        name
    );
    const versionPath = path.join(snapshotPath, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, `${name}\n`, 'utf8');
    writeRollbackRecords(snapshotPath, [
        {
            relativePath: 'garda-agent-orchestrator/VERSION',
            existed: true,
            pathType: 'file'
        }
    ]);
    return snapshotPath;
}

describe('backup backend inventory', () => {
    it('lists existing update and scheduled backups with restore metadata and size', () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-backups-list-');
        try {
            const updateSnapshotPath = seedRollbackSnapshot(targetRoot, 'update-20260501-010000-000');
            const scheduled = createBackupSnapshot({
                targetRoot,
                bundleRoot,
                reason: 'scheduled',
                timestamp: '20260502-010000-000'
            });

            const backups = listBackups(targetRoot);
            assert.equal(backups.length, 2);
            assert.deepEqual(
                backups.map((backup) => backup.reason).sort(),
                ['scheduled', 'update']
            );

            const update = backups.find((backup) => backup.reason === 'update');
            assert.ok(update, 'update backup must be listed');
            assert.equal(update.snapshotPath, updateSnapshotPath);
            assert.equal(update.restoreSnapshotPath, updateSnapshotPath);
            assert.equal(update.health, 'AVAILABLE');
            assert.equal(update.recordCount, 1);
            assert.ok(update.sizeBytes > 0, 'update backup size should be reported');
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, update.id), update.snapshotPath);
            assert.equal(resolveBackupRestoreSnapshotPath(targetRoot, update.relativeSnapshotPath), update.snapshotPath);

            assert.equal(scheduled.reason, 'scheduled');
            assert.equal(fs.existsSync(getRollbackRecordsPath(scheduled.snapshotPath)), true);
            assert.equal(scheduled.health, 'AVAILABLE');
            assert.ok(scheduled.sizeBytes > 0, 'scheduled backup size should be reported');
        } finally {
            removePathRecursive(targetRoot);
        }
    });

    it('diagnoses missing records and refuses restore bridge for unrestorable backups', () => {
        const { targetRoot } = makeWorkspace('gao-backups-health-');
        try {
            const brokenSnapshotPath = path.join(
                targetRoot,
                'garda-agent-orchestrator',
                'runtime',
                'update-rollbacks',
                'scheduled-20260503-010000-000'
            );
            fs.mkdirSync(brokenSnapshotPath, { recursive: true });

            const [backup] = listBackups(targetRoot);
            assert.equal(backup.id, 'scheduled-20260503-010000-000');
            assert.equal(backup.reason, 'scheduled');
            assert.equal(backup.health, 'MISSING_RECORDS');
            assert.match(backup.healthMessage || '', /Rollback records file not found/);
            assert.throws(
                () => resolveBackupRestoreSnapshotPath(targetRoot, backup.id),
                /not restorable/
            );
        } finally {
            removePathRecursive(targetRoot);
        }
    });

    it('prunes the oldest backup when the default latest-ten retention is exceeded', () => {
        const { targetRoot, bundleRoot } = makeWorkspace('gao-backups-prune-');
        try {
            for (let day = 1; day <= DEFAULT_BACKUP_KEEP_LATEST + 1; day += 1) {
                seedRollbackSnapshot(targetRoot, `update-202605${String(day).padStart(2, '0')}-010000-000`);
            }

            const result = pruneBackups({ targetRoot, bundleRoot });
            assert.equal(result.result, 'SUCCESS');
            assert.equal(result.keepLatest, DEFAULT_BACKUP_KEEP_LATEST);
            assert.equal(result.removed.length, 1);
            assert.equal(result.removed[0].reason, 'count');

            const oldestPath = path.join(
                targetRoot,
                'garda-agent-orchestrator',
                'runtime',
                'update-rollbacks',
                'update-20260501-010000-000'
            );
            assert.equal(fs.existsSync(oldestPath), false, 'oldest backup should be pruned');
            assert.equal(listBackups(targetRoot).length, DEFAULT_BACKUP_KEEP_LATEST);
        } finally {
            removePathRecursive(targetRoot);
        }
    });
});
