import * as fs from 'node:fs';
import * as path from 'node:path';

import { redactHostname as redactHostnameValue } from '../core/redaction';
import { DEFAULT_LOCK_STALE_MS, FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV } from './task-events-locking-types';
import type { LockInspectionResult, LockOptions, TaskEventLockCleanupResult, TaskEventLockHealth, TaskEventLockScanResult } from './task-events-locking-types';
import { getErrorMessage, toPositiveInteger } from './task-events-locking-support';
import { allowForeignHostStaleRecovery, requiresExplicitAgeRecovery } from './task-events-locking-metadata';
import { inspectLock, tryRemoveStaleLock } from './task-events-locking-inspection';

export function classifyLockName(entryName: string): { scope: 'aggregate' | 'task'; taskId: string | null } | null {
    if (entryName === '.all-tasks.lock') {
        return { scope: 'aggregate', taskId: null };
    }
    const taskMatch = entryName.match(/^\.(.+)\.lock$/);
    if (!taskMatch || !taskMatch[1]) {
        return null;
    }
    return {
        scope: 'task',
        taskId: taskMatch[1]
    };
}

export function buildLockRemediation(entryName: string, inspection: LockInspectionResult): string {
    if (requiresExplicitAgeRecovery(inspection)) {
        return [
            `Verify the remote owner is gone, then rerun with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 to reclaim aged foreign-host lock '${entryName}'.`,
            'Do not delete live task-event locks manually.'
        ].join(' ');
    }
    if (inspection.staleReason) {
        return [
            `Run 'garda doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the candidate list looks correct.`,
            'Only proven-stale task-event locks under runtime/task-events/*.lock are cleaned automatically.'
        ].join(' ');
    }

    const ownerPidText = inspection.metadata.pid !== null ? String(inspection.metadata.pid) : 'unknown';
    return [
        `Wait for the owning process to release '${entryName}' or terminate PID ${ownerPidText} safely if it is hung.`,
        'Do not delete live task-event locks manually.'
    ].join(' ');
}

export function buildTaskEventLockHealth(lockRoot: string, entryName: string, inspection: LockInspectionResult): TaskEventLockHealth | null {
    const parsed = classifyLockName(entryName);
    if (!parsed) {
        return null;
    }
    return {
        lock_name: entryName,
        lock_path: path.join(lockRoot, entryName).replace(/\\/g, '/'),
        scope: parsed.scope,
        task_id: parsed.taskId,
        status: inspection.staleReason ? 'STALE' : 'ACTIVE',
        age_ms: inspection.ageMs,
        heartbeat_age_ms: inspection.freshness.heartbeatAgeMs,
        owner_file_age_ms: inspection.freshness.ownerFileAgeMs,
        lock_dir_age_ms: inspection.freshness.lockDirAgeMs,
        freshness_source: inspection.freshness.freshnessSource,
        owner_pid: inspection.metadata.pid,
        owner_hostname: redactHostnameValue(inspection.metadata.hostname),
        owner_created_at_utc: inspection.metadata.created_at_utc,
        owner_alive: inspection.ownerAlive,
        owner_metadata_status: inspection.metadata.metadata_status,
        stale_reason: inspection.staleReason,
        remediation: buildLockRemediation(entryName, inspection)
    };
}

export function getTaskEventsRoot(orchestratorRoot: string): string {
    return path.join(orchestratorRoot, 'runtime', 'task-events');
}

export function listTaskEventLockEntries(lockRoot: string): string[] {
    if (!fs.existsSync(lockRoot) || !fs.statSync(lockRoot).isDirectory()) {
        return [];
    }
    return fs.readdirSync(lockRoot)
        .filter(function (entryName: string) {
            if (!entryName.startsWith('.') || !entryName.endsWith('.lock')) {
                return false;
            }
            const fullPath = path.join(lockRoot, entryName);
            try {
                return fs.statSync(fullPath).isDirectory();
            } catch {
                return false;
            }
        })
        .sort();
}

export function scanTaskEventLocks(orchestratorRoot: string, options: LockOptions = {}): TaskEventLockScanResult {
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const lockRoot = getTaskEventsRoot(orchestratorRoot);
    const locks: TaskEventLockHealth[] = [];

    for (const entryName of listTaskEventLockEntries(lockRoot)) {
        const inspection = inspectLock(path.join(lockRoot, entryName), staleMs);
        if (!inspection.exists) {
            continue;
        }
        const lockHealth = buildTaskEventLockHealth(lockRoot, entryName, inspection);
        if (lockHealth) {
            locks.push(lockHealth);
        }
    }

    return {
        lock_root: lockRoot.replace(/\\/g, '/'),
        subsystem_scope_note: 'Only runtime/task-events/*.lock participates in the task-event lock subsystem.',
        locks,
        active_count: locks.filter((lock) => lock.status === 'ACTIVE').length,
        stale_count: locks.filter((lock) => lock.status === 'STALE').length
    };
}

export function cleanupStaleTaskEventLocks(
    orchestratorRoot: string,
    options: LockOptions & { dryRun?: boolean } = {}
): TaskEventLockCleanupResult {
    const dryRun = options.dryRun === true;
    const lockRoot = getTaskEventsRoot(orchestratorRoot);
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const foreignHostRecoveryAllowed = allowForeignHostStaleRecovery(options);
    const removableStaleLocks: string[] = [];
    const retainedLiveLocks: string[] = [];
    const removedLocks: string[] = [];
    const failedLocks: string[] = [];
    const warnings: string[] = [];

    for (const entryName of listTaskEventLockEntries(lockRoot)) {
        const lockPath = path.join(lockRoot, entryName);
        const inspection = inspectLock(lockPath, staleMs);
        if (!inspection.exists) {
            continue;
        }

        if (!inspection.staleReason) {
            retainedLiveLocks.push(entryName);
            continue;
        }

        if (requiresExplicitAgeRecovery(inspection) && !foreignHostRecoveryAllowed) {
            retainedLiveLocks.push(entryName);
            warnings.push(
                `Skipped aged foreign-host lock '${entryName}': rerun cleanup with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 after verifying the remote owner is gone.`
            );
            continue;
        }

        removableStaleLocks.push(entryName);
        if (dryRun) {
            continue;
        }

        try {
            const removalAttempt = tryRemoveStaleLock(lockPath, staleMs, options);
            if (removalAttempt.removed) {
                removedLocks.push(entryName);
                continue;
            }

            const refreshed = inspectLock(lockPath, staleMs);
            if (!refreshed.exists) {
                continue;
            }
            if (!refreshed.staleReason) {
                retainedLiveLocks.push(entryName);
                continue;
            }

            failedLocks.push(entryName);
            warnings.push(`Failed to remove stale lock '${entryName}': stale candidate changed before cleanup could claim it safely.`);
        } catch (error: unknown) {
            failedLocks.push(entryName);
            warnings.push(`Failed to remove stale lock '${entryName}': ${getErrorMessage(error)}`);
        }
    }

    return {
        lock_root: lockRoot.replace(/\\/g, '/'),
        dry_run: dryRun,
        removed_locks: removedLocks,
        removable_stale_locks: removableStaleLocks,
        retained_live_locks: retainedLiveLocks,
        failed_locks: failedLocks,
        warnings
    };
}
