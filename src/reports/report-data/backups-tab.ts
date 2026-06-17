import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig } from '../../core/workflow-config';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import { getBackupSnapshotsRoot, listBackups } from '../../lifecycle/backups';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import { formatSizeBytes, readJsonObject, toRepoRelativePath } from './shared';
import type { ReportBackupRow, ReportBackupsTab, ReportDataUnavailableEntry } from './types';

function readAutoBackupSettings(repoRoot: string, unavailable: ReportDataUnavailableEntry[]): ReportBackupsTab['auto_backup'] {
    const defaults = buildDefaultWorkflowConfig().auto_backup;
    const configPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'workflow-config.json'));
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        unavailable.push({
            scope: 'backups:auto-backup',
            reason: `${toRepoRelativePath(repoRoot, configPath)} not found; default auto-backup settings are shown.`
        });
        return { ...defaults };
    }

    try {
        const parsed = readJsonObject(configPath);
        if (!parsed) {
            throw new Error('Workflow config JSON root is not an object.');
        }
        const validated = validateWorkflowConfig(parsed) as { auto_backup?: typeof defaults };
        const autoBackup = validated.auto_backup ?? defaults;
        return {
            enabled: autoBackup.enabled === true,
            interval_days: autoBackup.interval_days,
            keep_latest: autoBackup.keep_latest
        };
    } catch (error: unknown) {
        unavailable.push({
            scope: 'backups:auto-backup',
            reason: error instanceof Error ? error.message : String(error)
        });
        return { ...defaults };
    }
}

function mapBackupRow(backup: ReturnType<typeof listBackups>[number]): ReportBackupRow {
    return {
        id: backup.id,
        reason: backup.reason,
        created_at: backup.createdAt,
        size_bytes: backup.sizeBytes,
        size_human: formatSizeBytes(backup.sizeBytes),
        health: backup.health,
        health_message: backup.healthMessage,
        record_count: backup.recordCount,
        relative_snapshot_path: backup.relativeSnapshotPath,
        restorable: backup.health === 'AVAILABLE'
    };
}

export function buildBackupsTab(repoRoot: string): ReportBackupsTab {
    const root = path.resolve(repoRoot);
    const unavailable: ReportDataUnavailableEntry[] = [];
    const workflowConfigPath = joinOrchestratorPath(root, path.join('live', 'config', 'workflow-config.json'));
    const snapshotsRoot = getBackupSnapshotsRoot(root);
    const snapshotsRootExists = fs.existsSync(snapshotsRoot) && fs.statSync(snapshotsRoot).isDirectory();
    let rows: ReportBackupRow[] = [];
    try {
        rows = listBackups(root).map(mapBackupRow);
    } catch (error: unknown) {
        unavailable.push({
            scope: 'backups:inventory',
            reason: error instanceof Error ? error.message : String(error)
        });
    }

    return {
        workflow_config_path: toRepoRelativePath(root, workflowConfigPath),
        snapshots_root: toRepoRelativePath(root, snapshotsRoot),
        snapshots_root_exists: snapshotsRootExists,
        auto_backup: readAutoBackupSettings(root, unavailable),
        rows,
        unavailable
    };
}
