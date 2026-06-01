import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../core/filesystem';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    normalizeAutoBackupConfig,
    readWorkflowConfigForMerge,
    type AutoBackupConfig
} from '../core/workflow-config';
import {
    createBackupSnapshot,
    listBackups,
    pruneBackups,
    type BackupSummary
} from './backups';

export type ScheduledAutoBackupStatus =
    | 'DISABLED'
    | 'SKIPPED_ALREADY_RAN'
    | 'SKIPPED_NOT_DUE'
    | 'SUCCESS'
    | 'FAILED';

export interface ScheduledAutoBackupOptions {
    targetRoot: string;
    bundleRoot: string;
    localDate: string;
    now?: Date;
}

export interface ScheduledAutoBackupResult {
    status: ScheduledAutoBackupStatus;
    enabled: boolean;
    interval_days: number;
    keep_latest: number;
    local_date: string;
    report_path: string;
    skipped_reason: string | null;
    error: string | null;
    latest_scheduled_backup_id: string | null;
    latest_scheduled_backup_created_at: string | null;
    next_due_at: string | null;
    created_backup: BackupSummary | null;
    retention_result: {
        result: string;
        dry_run: boolean;
        candidate_count: number;
        removed_count: number;
        skipped_count: number;
        error_count: number;
        total_freed_bytes: number;
    } | null;
}

export function resolveScheduledAutoBackupReportPath(bundleRoot: string, localDate: string): string {
    return path.join(bundleRoot, 'runtime', 'maintenance', 'scheduled-backups', `${localDate}.json`);
}

function readAutoBackupConfig(bundleRoot: string): AutoBackupConfig {
    const defaultConfig = buildDefaultWorkflowConfig();
    const configPath = getWorkflowConfigPath(bundleRoot);
    const readResult = readWorkflowConfigForMerge(configPath);
    const section = readResult.config?.auto_backup;
    return normalizeAutoBackupConfig(section ?? defaultConfig.auto_backup);
}

function summarizeRetentionResult(result: ReturnType<typeof pruneBackups>): NonNullable<ScheduledAutoBackupResult['retention_result']> {
    return {
        result: result.result,
        dry_run: result.dryRun,
        candidate_count: result.candidates.length,
        removed_count: result.removed.length,
        skipped_count: result.skipped.length,
        error_count: result.errors.length,
        total_freed_bytes: result.totalFreedBytes
    };
}

function readSuccessfulDailyReport(reportPath: string): boolean {
    if (!fs.existsSync(reportPath)) {
        return false;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
        return parsed.status === 'SKIPPED_NOT_DUE'
            || parsed.status === 'SUCCESS';
    } catch {
        return false;
    }
}

function latestScheduledBackup(targetRoot: string): BackupSummary | null {
    return listBackups(targetRoot).find((backup) => backup.reason === 'scheduled') ?? null;
}

function addDays(date: Date, days: number): Date {
    return new Date(date.getTime() + days * 24 * 60 * 60 * 1000);
}

function isBackupDue(now: Date, latest: BackupSummary | null, intervalDays: number): boolean {
    if (!latest) {
        return true;
    }
    const latestMs = Date.parse(latest.createdAt);
    if (!Number.isFinite(latestMs)) {
        return true;
    }
    return now.getTime() >= addDays(new Date(latestMs), intervalDays).getTime();
}

function calculateNextDueAt(latest: BackupSummary | null, intervalDays: number): string | null {
    if (!latest) {
        return null;
    }
    const latestMs = Date.parse(latest.createdAt);
    if (!Number.isFinite(latestMs)) {
        return null;
    }
    return addDays(new Date(latestMs), intervalDays).toISOString();
}

function formatBackupTimestamp(now: Date): string {
    const pad2 = (value: number): string => String(value).padStart(2, '0');
    const pad3 = (value: number): string => String(value).padStart(3, '0');
    return `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}-`
        + `${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}-`
        + `${pad3(now.getMilliseconds())}`;
}

function writeScheduledReport(reportPath: string, result: ScheduledAutoBackupResult): void {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileAtomically(reportPath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8' });
}

function buildBaseResult(
    options: ScheduledAutoBackupOptions,
    config: AutoBackupConfig,
    latest: BackupSummary | null
): ScheduledAutoBackupResult {
    const nextDueAt = calculateNextDueAt(latest, config.interval_days);
    return {
        status: 'DISABLED',
        enabled: config.enabled,
        interval_days: config.interval_days,
        keep_latest: config.keep_latest,
        local_date: options.localDate,
        report_path: resolveScheduledAutoBackupReportPath(options.bundleRoot, options.localDate),
        skipped_reason: null,
        error: null,
        latest_scheduled_backup_id: latest?.id ?? null,
        latest_scheduled_backup_created_at: latest?.createdAt ?? null,
        next_due_at: nextDueAt,
        created_backup: null,
        retention_result: null
    };
}

function buildResultWithoutInventory(
    options: ScheduledAutoBackupOptions,
    config: AutoBackupConfig
): ScheduledAutoBackupResult {
    return buildBaseResult(options, config, null);
}

export function runScheduledAutoBackupMaintenance(
    options: ScheduledAutoBackupOptions
): ScheduledAutoBackupResult {
    const now = options.now ?? new Date();
    const config = readAutoBackupConfig(options.bundleRoot);
    const baseWithoutInventory = buildResultWithoutInventory(options, config);

    try {
        if (!config.enabled) {
            const result = {
                ...baseWithoutInventory,
                status: 'DISABLED' as const,
                skipped_reason: 'auto_backup_disabled'
            };
            writeScheduledReport(baseWithoutInventory.report_path, result);
            return result;
        }

        if (readSuccessfulDailyReport(baseWithoutInventory.report_path)) {
            return {
                ...baseWithoutInventory,
                status: 'SKIPPED_ALREADY_RAN',
                skipped_reason: 'daily_sentinel_present'
            };
        }

        const latest = latestScheduledBackup(options.targetRoot);
        const base = buildBaseResult(options, config, latest);
        if (!isBackupDue(now, latest, config.interval_days)) {
            const result = {
                ...base,
                status: 'SKIPPED_NOT_DUE' as const,
                skipped_reason: 'latest_scheduled_backup_not_due'
            };
            writeScheduledReport(base.report_path, result);
            return result;
        }

        const created = createBackupSnapshot({
            targetRoot: options.targetRoot,
            bundleRoot: options.bundleRoot,
            reason: 'scheduled',
            timestamp: formatBackupTimestamp(now)
        });
        const retention = pruneBackups({
            targetRoot: options.targetRoot,
            bundleRoot: options.bundleRoot,
            keepLatest: config.keep_latest
        });
        const latestAfterCreation = created;
        const result: ScheduledAutoBackupResult = {
            ...base,
            status: retention.result === 'SUCCESS' ? 'SUCCESS' : 'FAILED',
            error: retention.result === 'SUCCESS' ? null : `backup retention result was ${retention.result}`,
            latest_scheduled_backup_id: latestAfterCreation.id,
            latest_scheduled_backup_created_at: latestAfterCreation.createdAt,
            next_due_at: calculateNextDueAt(latestAfterCreation, config.interval_days),
            created_backup: created,
            retention_result: summarizeRetentionResult(retention)
        };
        writeScheduledReport(base.report_path, result);
        return result;
    } catch (error: unknown) {
        const result: ScheduledAutoBackupResult = {
            ...baseWithoutInventory,
            status: 'FAILED',
            error: error instanceof Error ? error.message : String(error)
        };
        writeScheduledReport(baseWithoutInventory.report_path, result);
        return result;
    }
}
