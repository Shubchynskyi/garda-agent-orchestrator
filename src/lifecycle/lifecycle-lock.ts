import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { redactHostname as redactHostnameValue, redactPath } from '../core/redaction';
import { resolveBundleName } from '../core/constants';
import { removeLockPathWithRetry } from '../gate-runtime/task-events-locking';

type JsonObject = Record<string, unknown>;

export const LIFECYCLE_OPERATION_LOCK_DIR_NAME = '.lifecycle-operation.lock';
export const LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME = 'owner.json';

interface LifecycleOperationLockMetadata extends JsonObject {
    pid: number | null;
    hostname: string | null;
    operation: string | null;
    acquired_at_utc: string | null;
    target_root: string | null;
}

interface LifecycleOperationLockInspection {
    exists: boolean;
    ownerAlive: boolean | null;
    metadata: LifecycleOperationLockMetadata;
}

export interface LifecycleLockTelemetry {
    elapsedMs: number;
    staleLockRecovered: boolean;
    queueWaitMs: number;
}

const LIFECYCLE_LOCK_METADATA_GRACE_MS = 2000;
const ACTIVE_LIFECYCLE_OPERATION_LOCKS = new Map<string, number>();
const LIFECYCLE_ASYNC_QUEUES = new Map<string, Promise<void>>();

let lastLifecycleLockTelemetry: LifecycleLockTelemetry | null = null;

export function getLastLifecycleLockTelemetry(): LifecycleLockTelemetry | null {
    return lastLifecycleLockTelemetry;
}

function getErrorCode(error: unknown): string {
    return error != null && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

function isProcessLikelyAlive(pid: number | null): boolean | null {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (errorCode === 'EPERM') return true;
        if (errorCode === 'ESRCH') return false;
        return null;
    }
}

function readLifecycleOperationLockMetadata(lockPath: string): LifecycleOperationLockMetadata {
    const ownerPath = path.join(lockPath, LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME);
    try {
        const raw = fs.readFileSync(ownerPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
            pid: typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0 ? parsed.pid : null,
            hostname: typeof parsed.hostname === 'string' && parsed.hostname.trim() ? parsed.hostname.trim() : null,
            operation: typeof parsed.operation === 'string' && parsed.operation.trim() ? parsed.operation.trim() : null,
            acquired_at_utc: typeof parsed.acquired_at_utc === 'string' && parsed.acquired_at_utc.trim()
                ? parsed.acquired_at_utc.trim()
                : null,
            target_root: typeof parsed.target_root === 'string' && parsed.target_root.trim() ? parsed.target_root.trim() : null
        };
    } catch {
        return {
            pid: null,
            hostname: null,
            operation: null,
            acquired_at_utc: null,
            target_root: null
        };
    }
}

function inspectLifecycleOperationLock(lockPath: string): LifecycleOperationLockInspection {
    if (!fs.existsSync(lockPath)) {
        return {
            exists: false,
            ownerAlive: null,
            metadata: {
                pid: null,
                hostname: null,
                operation: null,
                acquired_at_utc: null,
                target_root: null
            }
        };
    }
    const metadata = readLifecycleOperationLockMetadata(lockPath);

    if (metadata.pid === null) {
        try {
            const stats = fs.statSync(lockPath);
            const ageMs = Math.max(0, Date.now() - stats.mtimeMs);
            if (ageMs >= LIFECYCLE_LOCK_METADATA_GRACE_MS) {
                return { exists: true, ownerAlive: false, metadata };
            }
        } catch {
            // lock may have been removed concurrently
        }
        return { exists: true, ownerAlive: null, metadata };
    }

    const localHost = os.hostname();
    const sameHost = metadata.hostname !== null && metadata.hostname === localHost;
    return {
        exists: true,
        ownerAlive: sameHost ? isProcessLikelyAlive(metadata.pid) : null,
        metadata
    };
}

function writeLifecycleOperationLockMetadata(lockPath: string, targetRoot: string, operation: string): void {
    const ownerPath = path.join(lockPath, LIFECYCLE_OPERATION_LOCK_OWNER_FILE_NAME);
    const payload: LifecycleOperationLockMetadata = {
        pid: process.pid,
        hostname: os.hostname(),
        operation,
        acquired_at_utc: new Date().toISOString(),
        target_root: targetRoot
    };
    fs.writeFileSync(ownerPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

export function getLifecycleOperationLockPath(targetRoot: string): string {
    const normalizedTarget = path.resolve(targetRoot);
    return path.join(normalizedTarget, resolveBundleName(), 'runtime', LIFECYCLE_OPERATION_LOCK_DIR_NAME);
}

function acquireLifecycleOperationLock(targetRoot: string, operation: string): { release: () => void; telemetry: LifecycleLockTelemetry } {
    const startedAt = Date.now();
    const normalizedTarget = path.resolve(targetRoot);
    const heldCount = ACTIVE_LIFECYCLE_OPERATION_LOCKS.get(normalizedTarget) || 0;
    if (heldCount > 0) {
        ACTIVE_LIFECYCLE_OPERATION_LOCKS.set(normalizedTarget, heldCount + 1);
        return {
            release: function releaseNestedLock() {
                const currentCount = ACTIVE_LIFECYCLE_OPERATION_LOCKS.get(normalizedTarget) || 0;
                if (currentCount <= 1) {
                    ACTIVE_LIFECYCLE_OPERATION_LOCKS.delete(normalizedTarget);
                } else {
                    ACTIVE_LIFECYCLE_OPERATION_LOCKS.set(normalizedTarget, currentCount - 1);
                }
            },
            telemetry: { elapsedMs: Date.now() - startedAt, staleLockRecovered: false, queueWaitMs: 0 }
        };
    }

    let staleLockRecovered = false;
    const lockPath = getLifecycleOperationLockPath(normalizedTarget);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    try {
        fs.mkdirSync(lockPath);
    } catch (error: unknown) {
        const errorCode = getErrorCode(error);
        if (errorCode !== 'EEXIST') {
            throw error;
        }

        const inspection = inspectLifecycleOperationLock(lockPath);
        if (inspection.exists && inspection.ownerAlive === false) {
            const tempPath = lockPath + '.stale-' + process.pid + '-' + Date.now();
            try {
                fs.renameSync(lockPath, tempPath);
            } catch {
                throw error;
            }
            removeLockPathWithRetry(tempPath, 'lifecycle_lock_stale_cleanup');
            fs.mkdirSync(lockPath);
            staleLockRecovered = true;
        } else {
            const ownerPid = inspection.metadata.pid != null ? String(inspection.metadata.pid) : 'unknown';
            const ownerHost = redactHostnameValue(inspection.metadata.hostname) || 'unknown';
            const ownerOperation = inspection.metadata.operation || 'unknown';
            const redactedTarget = redactPath(normalizedTarget, normalizedTarget);
            const redactedLockPath = redactPath(lockPath, normalizedTarget);
            throw new Error(
                `Another lifecycle operation is already running for '${redactedTarget}' ` +
                `(operation='${ownerOperation}', pid=${ownerPid}, host=${ownerHost}, lock='${redactedLockPath}').`
            );
        }
    }

    try {
        writeLifecycleOperationLockMetadata(lockPath, normalizedTarget, operation);
    } catch (error: unknown) {
        removeLockPathWithRetry(lockPath, 'lifecycle_lock_metadata_cleanup');
        throw error;
    }

    ACTIVE_LIFECYCLE_OPERATION_LOCKS.set(normalizedTarget, 1);
    const elapsedMs = Date.now() - startedAt;
    if (staleLockRecovered) {
        process.stderr.write(
            `LIFECYCLE_LOCK_STALE_RECOVERED: target=${normalizedTarget}; operation=${operation}; elapsed_ms=${elapsedMs}\n`
        );
    }
    return {
        release: function releaseLock() {
            const currentCount = ACTIVE_LIFECYCLE_OPERATION_LOCKS.get(normalizedTarget) || 0;
            if (currentCount <= 1) {
                ACTIVE_LIFECYCLE_OPERATION_LOCKS.delete(normalizedTarget);
                removeLockPathWithRetry(lockPath, 'lifecycle_lock_release');
                return;
            }
            ACTIVE_LIFECYCLE_OPERATION_LOCKS.set(normalizedTarget, currentCount - 1);
        },
        telemetry: { elapsedMs, staleLockRecovered, queueWaitMs: 0 }
    };
}

export function withLifecycleOperationLock<T>(targetRoot: string, operation: string, callback: () => T): T {
    const { release, telemetry } = acquireLifecycleOperationLock(targetRoot, operation);
    lastLifecycleLockTelemetry = telemetry;
    try {
        return callback();
    } finally {
        release();
    }
}

export async function withLifecycleOperationLockAsync<T>(
    targetRoot: string,
    operation: string,
    callback: () => Promise<T>
): Promise<T> {
    const normalizedTarget = path.resolve(targetRoot);
    const queueStartedAt = Date.now();

    let previous = LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget);
    while (previous) {
        await previous;
        previous = LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget);
    }

    const queueWaitMs = Date.now() - queueStartedAt;
    let resolveQueue!: () => void;
    const queueEntry = new Promise<void>((resolve) => { resolveQueue = resolve; });
    LIFECYCLE_ASYNC_QUEUES.set(normalizedTarget, queueEntry);

    let release: (() => void) | null = null;
    try {
        const lockResult = acquireLifecycleOperationLock(targetRoot, operation);
        release = lockResult.release;
        lastLifecycleLockTelemetry = { ...lockResult.telemetry, queueWaitMs };
        return await callback();
    } finally {
        if (release) {
            release();
        }
        if (LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget) === queueEntry) {
            LIFECYCLE_ASYNC_QUEUES.delete(normalizedTarget);
        }
        resolveQueue();
    }
}
