import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    acquireFilesystemLockAsync,
    releaseFilesystemLock,
    type AcquireLockTelemetry
} from '../gate-runtime/task-events';

const FINALIZATION_LOCK_STALE_MS = 15 * 60 * 1000;
const FINALIZATION_LOCK_METADATA_GRACE_MS = 30 * 1000;
const FINALIZATION_LOCK_TIMEOUT_MS = 1_000;
const FINALIZATION_LOCK_RETRY_MS = 25;

export interface FinalizationLockInspection {
    active: boolean;
    lock_path: string;
    owner_pid: number | null;
    stale: boolean;
}

function safeStat(targetPath: string): fs.Stats | null {
    try {
        return fs.statSync(targetPath);
    } catch (error) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
            return null;
        }
        throw error;
    }
}

function isProcessLikelyAlive(pid: number): boolean | null {
    if (!Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as NodeJS.ErrnoException).code || '')
            : '';
        if (errorCode === 'ESRCH') {
            return false;
        }
        if (errorCode === 'EPERM') {
            return true;
        }
        return null;
    }
}

export function getCompletionGateFinalizationLockPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-completion-gate.lock`);
}

export function inspectCompletionGateFinalizationLock(reviewsRoot: string, taskId: string): FinalizationLockInspection {
    const lockPath = getCompletionGateFinalizationLockPath(reviewsRoot, taskId);
    const lockStat = safeStat(lockPath);
    if (!lockStat || !lockStat.isDirectory()) {
        return {
            active: false,
            lock_path: lockPath,
            owner_pid: null,
            stale: false
        };
    }

    const ageMs = Math.max(0, Date.now() - lockStat.mtimeMs);
    const ownerPath = path.join(lockPath, 'owner.json');
    let ownerPid: number | null = null;
    const ownerStat = safeStat(ownerPath);
    if (ownerStat && ownerStat.isFile()) {
        try {
            const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
            ownerPid = Number.isInteger(parsed.pid) && Number(parsed.pid) > 0 ? Number(parsed.pid) : null;
        } catch {
            ownerPid = null;
        }
    }

    const ownerAlive = ownerPid != null ? isProcessLikelyAlive(ownerPid) : null;
    if (ownerAlive === true) {
        return {
            active: true,
            lock_path: lockPath,
            owner_pid: ownerPid,
            stale: false
        };
    }

    if (ownerAlive === false || ageMs >= FINALIZATION_LOCK_STALE_MS) {
        return {
            active: false,
            lock_path: lockPath,
            owner_pid: ownerPid,
            stale: true
        };
    }

    if (ageMs <= FINALIZATION_LOCK_METADATA_GRACE_MS) {
        return {
            active: true,
            lock_path: lockPath,
            owner_pid: ownerPid,
            stale: false
        };
    }

    return {
        active: false,
        lock_path: lockPath,
        owner_pid: ownerPid,
        stale: true
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
