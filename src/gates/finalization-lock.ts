import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    acquireFilesystemLockAsync,
    inspectFilesystemLock,
    releaseFilesystemLock,
    type AcquireLockTelemetry,
    type LockInspectionResult,
    type LockOwnerMetadata
} from '../gate-runtime/task-events';

const FINALIZATION_LOCK_STALE_MS = 15 * 60 * 1000;
const FINALIZATION_LOCK_METADATA_GRACE_MS = 30 * 1000;
const FINALIZATION_LOCK_TIMEOUT_MS = 5_000;
const FINALIZATION_LOCK_RETRY_MS = 50;
const COMPLETION_GATE_LOCK_SUFFIX = '-completion-gate.lock';

export const COMPLETION_FINALIZATION_LOCK_SUBSYSTEM_NOTE =
    'Completion finalization locks under runtime/reviews/*-completion-gate.lock serialize only the completion-gate finalization step. '
    + 'They are separate from task-event and review-artifact lock subsystems, and doctor --cleanup-stale-locks does not reclaim them automatically.';

export interface CompletionGateFinalizationLockPolicy {
    timeout_ms: number;
    retry_ms: number;
    stale_after_ms: number;
}

export interface FinalizationLockInspection {
    active: boolean;
    lock_name: string;
    lock_path: string;
    task_id: string;
    age_ms: number | null;
    owner_pid: number | null;
    owner_hostname: string | null;
    owner_created_at_utc: string | null;
    owner_alive: boolean | null;
    owner_metadata_status: LockOwnerMetadata['metadata_status'];
    stale: boolean;
    stale_reason: LockInspectionResult['staleReason'];
    remediation: string;
    subsystem_scope_note: string;
    acquisition_policy: CompletionGateFinalizationLockPolicy;
}

export interface CompletionGateFinalizationLockScanResult {
    lock_root: string;
    subsystem_scope_note: string;
    acquisition_policy: CompletionGateFinalizationLockPolicy;
    locks: FinalizationLockInspection[];
    active_count: number;
    stale_count: number;
}

function getCompletionGateFinalizationLockPolicy(): CompletionGateFinalizationLockPolicy {
    return {
        timeout_ms: FINALIZATION_LOCK_TIMEOUT_MS,
        retry_ms: FINALIZATION_LOCK_RETRY_MS,
        stale_after_ms: FINALIZATION_LOCK_STALE_MS
    };
}

function listCompletionGateFinalizationLockEntries(reviewsRoot: string): string[] {
    try {
        return fs.readdirSync(reviewsRoot).filter((entryName) => entryName.endsWith(COMPLETION_GATE_LOCK_SUFFIX));
    } catch (error) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
            return [];
        }
        throw error;
    }
}

function inferTaskIdFromLockName(lockName: string): string | null {
    if (!lockName.endsWith(COMPLETION_GATE_LOCK_SUFFIX)) {
        return null;
    }
    const taskId = lockName.slice(0, -COMPLETION_GATE_LOCK_SUFFIX.length);
    return taskId.length > 0 ? taskId : null;
}

function buildFinalizationLockRemediation(lockPath: string, inspection: LockInspectionResult): string {
    if (!inspection.exists) {
        return 'No completion finalization lock is present.';
    }

    const ownerPidText = inspection.metadata.pid === null ? 'unknown' : String(inspection.metadata.pid);
    const ownerHostText = inspection.metadata.hostname || 'unknown';
    const normalizedLockPath = lockPath.replace(/\\/g, '/');
    if (!inspection.staleReason) {
        return `Wait for the owning completion-gate process to finish. If the lock remains contested, inspect PID ${ownerPidText} on ${ownerHostText} before retrying completion-gate or task-audit-summary.`;
    }

    return `Verify that completion-gate PID ${ownerPidText} on ${ownerHostText} is no longer running. `
        + `doctor --cleanup-stale-locks does not reclaim completion finalization locks. `
        + `After verification, remove '${normalizedLockPath}' if it still exists, then rerun completion-gate or task-audit-summary.`;
}

function buildFinalizationLockInspection(
    lockPath: string,
    taskId: string,
    inspection: LockInspectionResult
): FinalizationLockInspection {
    const staleReason = inspection.staleReason
        || (
            inspection.metadata.metadata_status !== 'ok'
            && inspection.ageMs !== null
            && inspection.ageMs >= FINALIZATION_LOCK_METADATA_GRACE_MS
                ? 'owner_dead'
                : null
        );

    return {
        active: inspection.exists && staleReason === null,
        lock_name: path.basename(lockPath),
        lock_path: lockPath.replace(/\\/g, '/'),
        task_id: taskId,
        age_ms: inspection.ageMs,
        owner_pid: inspection.metadata.pid,
        owner_hostname: inspection.metadata.hostname,
        owner_created_at_utc: inspection.metadata.created_at_utc,
        owner_alive: inspection.ownerAlive,
        owner_metadata_status: inspection.metadata.metadata_status,
        stale: inspection.exists && staleReason !== null,
        stale_reason: staleReason,
        remediation: buildFinalizationLockRemediation(lockPath, {
            ...inspection,
            staleReason
        }),
        subsystem_scope_note: COMPLETION_FINALIZATION_LOCK_SUBSYSTEM_NOTE,
        acquisition_policy: getCompletionGateFinalizationLockPolicy()
    };
}

export function getCompletionGateFinalizationLockPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}${COMPLETION_GATE_LOCK_SUFFIX}`);
}

export function inspectCompletionGateFinalizationLock(reviewsRoot: string, taskId: string): FinalizationLockInspection {
    const lockPath = getCompletionGateFinalizationLockPath(reviewsRoot, taskId);
    const inspection = inspectFilesystemLock(lockPath, { staleMs: FINALIZATION_LOCK_STALE_MS });
    if (!inspection.exists) {
        return {
            active: false,
            lock_name: path.basename(lockPath),
            lock_path: lockPath.replace(/\\/g, '/'),
            task_id: taskId,
            age_ms: null,
            owner_pid: null,
            owner_hostname: null,
            owner_created_at_utc: null,
            owner_alive: null,
            owner_metadata_status: 'missing',
            stale: false,
            stale_reason: null,
            remediation: buildFinalizationLockRemediation(lockPath, inspection),
            subsystem_scope_note: COMPLETION_FINALIZATION_LOCK_SUBSYSTEM_NOTE,
            acquisition_policy: getCompletionGateFinalizationLockPolicy()
        };
    }

    return buildFinalizationLockInspection(lockPath, taskId, inspection);
}

export function scanCompletionGateFinalizationLocks(reviewsRoot: string): CompletionGateFinalizationLockScanResult {
    const locks: FinalizationLockInspection[] = [];

    for (const entryName of listCompletionGateFinalizationLockEntries(reviewsRoot)) {
        const taskId = inferTaskIdFromLockName(entryName);
        if (!taskId) {
            continue;
        }
        const lockPath = path.join(reviewsRoot, entryName);
        const inspection = inspectFilesystemLock(lockPath, { staleMs: FINALIZATION_LOCK_STALE_MS });
        if (!inspection.exists) {
            continue;
        }
        locks.push(buildFinalizationLockInspection(lockPath, taskId, inspection));
    }

    return {
        lock_root: reviewsRoot.replace(/\\/g, '/'),
        subsystem_scope_note: COMPLETION_FINALIZATION_LOCK_SUBSYSTEM_NOTE,
        acquisition_policy: getCompletionGateFinalizationLockPolicy(),
        locks,
        active_count: locks.filter((lock) => lock.active).length,
        stale_count: locks.filter((lock) => lock.stale).length
    };
}

export async function withCompletionGateFinalizationLockAsync<T>(
    reviewsRoot: string,
    taskId: string,
    callback: () => Promise<T> | T
): Promise<{ result: T; lock_path: string; telemetry: AcquireLockTelemetry }> {
    const lockPath = getCompletionGateFinalizationLockPath(reviewsRoot, taskId);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
        timeoutMs: FINALIZATION_LOCK_TIMEOUT_MS,
        retryMs: FINALIZATION_LOCK_RETRY_MS,
        staleMs: FINALIZATION_LOCK_STALE_MS
    });
    try {
        return {
            result: await callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}
