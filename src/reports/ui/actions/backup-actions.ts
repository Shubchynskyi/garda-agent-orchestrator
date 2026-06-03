import { listBackups } from '../../../lifecycle/backups';
import { buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

export const BACKUP_RESTORE_ACTION_ID_PREFIX = 'backup-restore:';

export function buildBackupRestoreActionId(backupId: string): string {
    return `${BACKUP_RESTORE_ACTION_ID_PREFIX}${backupId}`;
}

export function buildBackupRestoreConfirmationPhrase(backupId: string): string {
    return `RESTORE BACKUP ${backupId}`;
}

export function buildUiBackupActionDefinitions(repoRoot: string): UiActionDefinition[] {
    let backups;
    try {
        backups = listBackups(repoRoot);
    } catch {
        return [];
    }

    return backups.map((backup) => {
        const restorable = backup.health === 'AVAILABLE';
        return buildUiActionDefinition(
            repoRoot,
            buildBackupRestoreActionId(backup.id),
            'Backups',
            `Restore backup ${backup.id}`,
            `Restore workspace state from backup snapshot ${backup.relativeSnapshotPath} through the guarded rollback backend.`,
            [
                'rollback',
                '--snapshot-path',
                backup.restoreSnapshotPath,
                '--target-root',
                repoRoot
            ],
            {
                mutates: true,
                confirmationPhrase: buildBackupRestoreConfirmationPhrase(backup.id),
                enabled: restorable,
                unavailableReason: backup.healthMessage
                    ? `Backup is not restorable (${backup.health}): ${backup.healthMessage}`
                    : `Backup is not restorable (${backup.health}).`
            }
        );
    });
}
