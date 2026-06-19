import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const BACKUPS_TAB_TEXT_IDS = Object.freeze([
    'tab_intro',
    'inventory_title',
    'empty',
    'snapshots_root',
    'root_present',
    'root_missing',
    'id_column',
    'created_column',
    'size_column',
    'reason_column',
    'status_column',
    'restore_column',
    'reason_update',
    'reason_scheduled',
    'reason_manual',
    'health_available',
    'health_missing_records',
    'health_invalid_records',
    'actions_disabled',
    'manual_create_title',
    'manual_create_help',
    'manual_create_button',
    'manual_create_unavailable',
    'restore_unavailable',
    'restore_backup',
    'auto_backup_title',
    'auto_backup_help',
    'auto_enabled',
    'auto_interval_days',
    'auto_keep_latest',
    'restore_preview_help'
] as const);

export type BackupsTabTextId = typeof BACKUPS_TAB_TEXT_IDS[number];

export function buildBackupsTabTextCatalog(): Readonly<Record<BackupsTabTextId, LocalUiLocalizedText>> {
    return Object.freeze({
        tab_intro: {
            description: 'The Backups tab lists rollback snapshots from the backup inventory, shows auto-backup settings from workflow config, and exposes guarded restore actions when the UI server runs with `--actions`.'
        },
        inventory_title: {
            label: 'Backup list'
        },
        empty: {
            label: 'No backups in list.'
        },
        snapshots_root: {
            label: 'Snapshots root'
        },
        root_present: {
            label: 'present'
        },
        root_missing: {
            label: 'missing'
        },
        id_column: {
            label: 'ID'
        },
        created_column: {
            label: 'Created'
        },
        size_column: {
            label: 'Size'
        },
        reason_column: {
            label: 'Reason'
        },
        status_column: {
            label: 'Health'
        },
        restore_column: {
            label: 'Restore'
        },
        reason_update: {
            label: 'update'
        },
        reason_scheduled: {
            label: 'scheduled'
        },
        reason_manual: {
            label: 'manual'
        },
        health_available: {
            label: 'Available'
        },
        health_missing_records: {
            label: 'Missing records'
        },
        health_invalid_records: {
            label: 'Invalid records'
        },
        actions_disabled: {
            label: 'Controlled actions are disabled.'
        },
        manual_create_title: {
            label: 'Manual backup'
        },
        manual_create_help: {
            description: 'Create a rollback backup snapshot of the current workspace state through the guarded backup backend.'
        },
        manual_create_button: {
            label: 'Create backup'
        },
        manual_create_unavailable: {
            label: 'Manual backup creation is unavailable.'
        },
        restore_unavailable: {
            label: 'Restore unavailable for this backup.'
        },
        restore_backup: {
            label: 'Restore backup'
        },
        auto_backup_title: {
            label: 'Auto-backup'
        },
        auto_backup_help: {
            description: 'Scheduled auto-backups use audited workflow settings. Saving requires confirmation.'
        },
        auto_enabled: {
            label: 'Enabled'
        },
        auto_interval_days: {
            label: 'Interval (days)'
        },
        auto_keep_latest: {
            label: 'Keep latest'
        },
        restore_preview_help: {
            description: 'Choose a backup to restore it through the guarded rollback action.'
        }
    });
}

export function listBackupsTabTextCatalogIds(
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildBackupsTabTextCatalog()
): string[] {
    return Object.keys(catalog).sort();
}
