import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { writeRollbackRecords } from '../../../src/lifecycle/common';
import {
    BACKUP_RESTORE_ACTION_ID_PREFIX,
    buildBackupRestoreActionId,
    buildBackupRestoreConfirmationPhrase,
    buildUiBackupActionDefinitions,
    buildUiTaskActionDefinitions,
    buildUiWorkspaceActionDefinitions,
    buildUiWorkspaceAndBackupActionDefinitions
} from '../../../src/reports/ui/actions/registry';

test('workspace, task, and backup action registries stay in separate builders', () => {
    const repoRoot = process.cwd();
    const workspace = buildUiWorkspaceActionDefinitions(repoRoot);
    const task = buildUiTaskActionDefinitions(repoRoot, 'T-100');
    const backup = buildUiBackupActionDefinitions(repoRoot);

    assert.ok(workspace.every((action) => !action.id.startsWith(BACKUP_RESTORE_ACTION_ID_PREFIX)));
    assert.ok(workspace.every((action) => action.category !== 'Task'));
    assert.ok(task.every((action) => action.category === 'Task'));
    assert.ok(backup.every((action) => action.id.startsWith(BACKUP_RESTORE_ACTION_ID_PREFIX)));
    assert.ok(backup.every((action) => action.category === 'Backups'));

    const merged = buildUiWorkspaceAndBackupActionDefinitions(repoRoot);
    assert.equal(merged.length, workspace.length + backup.length);
    assert.ok(merged.some((action) => action.id === 'status'));
});

test('backup restore actions bind inventory ids to rollback commands with confirmation phrases', () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-ui-backup-actions-'));
    const bundleRoot = path.join(tempRoot, 'garda-agent-orchestrator');
    const backupId = 'update-20260101-120000-000';
    const snapshotsRoot = path.join(bundleRoot, 'runtime', 'update-rollbacks', backupId);
    const versionPath = path.join(snapshotsRoot, 'garda-agent-orchestrator', 'VERSION');
    fs.mkdirSync(path.dirname(versionPath), { recursive: true });
    fs.writeFileSync(versionPath, '1.0.0\n', 'utf8');
    writeRollbackRecords(snapshotsRoot, [
        {
            relativePath: 'garda-agent-orchestrator/VERSION',
            existed: true,
            pathType: 'file'
        }
    ]);

    try {
        const actions = buildUiBackupActionDefinitions(tempRoot);
        assert.equal(actions.length, 1);
        const action = actions[0];
        assert.equal(action.id, buildBackupRestoreActionId(backupId));
        assert.equal(action.confirmation_phrase, buildBackupRestoreConfirmationPhrase(backupId));
        assert.equal(action.enabled, true);
        assert.match(action.command.display, /rollback/u);
        assert.match(action.command.display, new RegExp(backupId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'));
    } finally {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
});
