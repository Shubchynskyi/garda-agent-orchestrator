import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../../core/filesystem';
import { withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { runGc } from '../cleanup/cleanup-orchestration';
import { loadRuntimeRetentionPolicy, resolveRuntimeRetentionPolicyConfigPath } from './runtime-retention-policy';
import type { GcResult } from '../cleanup/cleanup-types';
import {
    runScheduledAutoBackupMaintenance,
    type ScheduledAutoBackupResult
} from './scheduled-backups';

export type DailyRetentionMaintenanceStatus =
    | 'DISABLED'
    | 'SKIPPED_ALREADY_RAN'
    | 'SUCCESS'
    | 'DRY_RUN'
    | 'FAILED';

export interface DailyRetentionMaintenanceOptions {
    targetRoot: string;
    bundleRoot: string;
    now?: Date;
}

export interface DailyRetentionMaintenanceResult {
    status: DailyRetentionMaintenanceStatus;
    enabled: boolean;
    dry_run: boolean;
    local_date: string;
    sentinel_path: string;
    report_path: string;
    policy_path: string;
    max_tasks_per_run: number;
    lock_acquired: boolean;
    skipped_reason: string | null;
    error: string | null;
    gc_result?: {
        result: string;
        dry_run: boolean;
        removed_count: number;
        skipped_count: number;
        error_count: number;
        total_freed_bytes: number;
        eligible_now_count: number | null;
        selected_task_limit: number;
    };
    scheduled_backup?: ScheduledAutoBackupResult;
}

function pad2(value: number): string {
    return String(value).padStart(2, '0');
}

export function formatLocalMaintenanceDate(now: Date): string {
    return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

export function resolveDailyRetentionMaintenanceReportPath(bundleRoot: string, localDate: string): string {
    return path.join(bundleRoot, 'runtime', 'maintenance', 'daily-retention', `${localDate}.json`);
}

function readExistingSuccessfulSentinel(reportPath: string): boolean {
    if (!fs.existsSync(reportPath)) {
        return false;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8')) as Record<string, unknown>;
        return parsed.status === 'SUCCESS' || parsed.status === 'DRY_RUN';
    } catch {
        return false;
    }
}

function writeMaintenanceReport(reportPath: string, result: DailyRetentionMaintenanceResult): void {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    writeFileAtomically(reportPath, JSON.stringify(result, null, 2) + '\n', { encoding: 'utf8' });
}

function summarizeGcResult(gcResult: GcResult, selectedTaskLimit: number): NonNullable<DailyRetentionMaintenanceResult['gc_result']> {
    return {
        result: gcResult.result,
        dry_run: gcResult.dryRun,
        removed_count: gcResult.removed.length,
        skipped_count: gcResult.skipped.length,
        error_count: gcResult.errors.length,
        total_freed_bytes: gcResult.totalFreedBytes,
        eligible_now_count: gcResult.runtimeRetentionPreview?.eligible_now_count ?? null,
        selected_task_limit: selectedTaskLimit
    };
}

function runScheduledBackupForDailyMaintenance(options: DailyRetentionMaintenanceOptions, localDate: string): ScheduledAutoBackupResult {
    return runScheduledAutoBackupMaintenance({
        targetRoot: options.targetRoot,
        bundleRoot: options.bundleRoot,
        localDate,
        now: options.now
    });
}

function buildBaseResult(options: DailyRetentionMaintenanceOptions, localDate: string): DailyRetentionMaintenanceResult {
    const reportPath = resolveDailyRetentionMaintenanceReportPath(options.bundleRoot, localDate);
    const policy = loadRuntimeRetentionPolicy(options.bundleRoot);
    const dryRun = policy.dailyMaintenance.dryRun || policy.purge.requireConfirm;
    return {
        status: 'DISABLED',
        enabled: policy.dailyMaintenance.enabled,
        dry_run: dryRun,
        local_date: localDate,
        sentinel_path: reportPath,
        report_path: reportPath,
        policy_path: resolveRuntimeRetentionPolicyConfigPath(options.bundleRoot),
        max_tasks_per_run: policy.dailyMaintenance.maxTasksPerRun,
        lock_acquired: false,
        skipped_reason: null,
        error: null
    };
}

export function runDailyRetentionMaintenance(
    options: DailyRetentionMaintenanceOptions
): DailyRetentionMaintenanceResult {
    const now = options.now ?? new Date();
    const localDate = formatLocalMaintenanceDate(now);
    const base = buildBaseResult(options, localDate);

    if (!base.enabled) {
        return {
            ...base,
            status: 'DISABLED',
            skipped_reason: 'daily_maintenance_disabled',
            scheduled_backup: runScheduledBackupForDailyMaintenance(options, localDate)
        };
    }

    if (readExistingSuccessfulSentinel(base.report_path)) {
        return {
            ...base,
            status: 'SKIPPED_ALREADY_RAN',
            skipped_reason: 'daily_sentinel_present',
            scheduled_backup: runScheduledBackupForDailyMaintenance(options, localDate)
        };
    }

    try {
        return withLifecycleOperationLock(options.targetRoot, 'daily-retention-maintenance', () => {
            if (readExistingSuccessfulSentinel(base.report_path)) {
                return {
                    ...base,
                    status: 'SKIPPED_ALREADY_RAN',
                    lock_acquired: true,
                    skipped_reason: 'daily_sentinel_present_after_lock',
                    scheduled_backup: runScheduledBackupForDailyMaintenance(options, localDate)
                };
            }

            const gcResult = runGc({
                targetRoot: options.targetRoot,
                bundleRoot: options.bundleRoot,
                confirm: !base.dry_run,
                runtimeRetentionOnly: true,
                runtimeRetentionTaskLimit: base.max_tasks_per_run
            });
            const gcSummary = summarizeGcResult(gcResult, base.max_tasks_per_run);
            const status: DailyRetentionMaintenanceStatus = gcResult.result === 'SUCCESS'
                ? (base.dry_run ? 'DRY_RUN' : 'SUCCESS')
                : 'FAILED';
            const result: DailyRetentionMaintenanceResult = {
                ...base,
                status,
                lock_acquired: true,
                skipped_reason: null,
                error: status === 'FAILED' ? `retention maintenance gc result was ${gcResult.result}` : null,
                gc_result: gcSummary,
                scheduled_backup: runScheduledBackupForDailyMaintenance(options, localDate)
            };
            writeMaintenanceReport(base.report_path, result);
            return result;
        });
    } catch (error: unknown) {
        return {
            ...base,
            status: 'FAILED',
            error: error instanceof Error ? error.message : String(error)
        };
    }
}
