import { AsyncLocalStorage } from 'node:async_hooks';
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
    ageMs: number | null;
    ownerHostMatchesCurrent: boolean | null;
    ownerAlive: boolean | null;
    staleReason: 'owner_dead' | 'age_exceeded' | null;
    metadata: LifecycleOperationLockMetadata;
}

export interface LifecycleLockTelemetry {
    elapsedMs: number;
    staleLockRecovered: boolean;
    queueWaitMs: number;
}

export interface LifecycleLockOptions {
    allowForeignHostStaleRecovery?: unknown;
    queueTimeoutMs?: unknown;
}

interface LifecycleAsyncQueueEntry {
    operation: string;
    enqueuedAtMs: number;
    started: boolean;
    startPromise: Promise<void>;
    resolveStart: () => void;
}

interface LifecycleAsyncQueueState {
    entries: LifecycleAsyncQueueEntry[];
}

interface LifecycleAsyncContextState {
    heldTargets: Map<string, number>;
}

const LIFECYCLE_LOCK_METADATA_GRACE_MS = 2000;
const LIFECYCLE_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LIFECYCLE_ASYNC_QUEUE_TIMEOUT_MS = 10 * 60 * 1000;
const FOREIGN_HOST_LIFECYCLE_STALE_RECOVERY_ENV = 'GARDA_RECOVER_FOREIGN_HOST_LIFECYCLE_LOCKS';
const FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV = 'GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS';
const ACTIVE_LIFECYCLE_OPERATION_LOCKS = new Map<string, number>();
const LIFECYCLE_ASYNC_QUEUES = new Map<string, LifecycleAsyncQueueState>();
const LIFECYCLE_ASYNC_CONTEXT = new AsyncLocalStorage<LifecycleAsyncContextState>();

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

function normalizeHostname(hostname: string | null): string | null {
    const trimmed = typeof hostname === 'string' ? hostname.trim() : '';
    return trimmed ? trimmed.toLowerCase() : null;
}

function isCurrentHostOwner(hostname: string | null): boolean | null {
    const ownerHost = normalizeHostname(hostname);
    if (!ownerHost) {
        return null;
    }
    return ownerHost === normalizeHostname(os.hostname());
}

function parseBooleanLike(value: unknown): boolean {
    const raw = String(value ?? '').trim().toLowerCase();
    return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

function toPositiveInteger(value: unknown, fallback: number): number {
    const normalized = Number(value);
    return Number.isInteger(normalized) && normalized > 0 ? normalized : fallback;
}

function isForeignHostLifecycleStaleRecoveryEnabled(options: LifecycleLockOptions = {}): boolean {
    if (options.allowForeignHostStaleRecovery !== undefined) {
        return parseBooleanLike(options.allowForeignHostStaleRecovery);
    }
    return parseBooleanLike(process.env[FOREIGN_HOST_LIFECYCLE_STALE_RECOVERY_ENV] || '')
        || parseBooleanLike(process.env[FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV] || '');
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
            ageMs: null,
            ownerHostMatchesCurrent: null,
            ownerAlive: null,
            staleReason: null,
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
    let ageMs: number | null = null;
    try {
        const stats = fs.statSync(lockPath);
        ageMs = Math.max(0, Date.now() - stats.mtimeMs);
    } catch {
        return {
            exists: false,
            ageMs: null,
            ownerHostMatchesCurrent: null,
            ownerAlive: null,
            staleReason: null,
            metadata
        };
    }

    const ownerHostMatchesCurrent = isCurrentHostOwner(metadata.hostname);

    if (metadata.pid === null) {
        if (ownerHostMatchesCurrent === false && ageMs >= LIFECYCLE_LOCK_STALE_MS) {
            return { exists: true, ageMs, ownerHostMatchesCurrent, ownerAlive: null, staleReason: 'age_exceeded', metadata };
        }
        if (ownerHostMatchesCurrent !== false && ageMs >= LIFECYCLE_LOCK_METADATA_GRACE_MS) {
            return { exists: true, ageMs, ownerHostMatchesCurrent, ownerAlive: false, staleReason: 'owner_dead', metadata };
        }
        return { exists: true, ageMs, ownerHostMatchesCurrent, ownerAlive: null, staleReason: null, metadata };
    }

    const ownerAlive = ownerHostMatchesCurrent === false ? null : isProcessLikelyAlive(metadata.pid);
    const staleReason = ownerAlive === false
        ? 'owner_dead'
        : (ownerHostMatchesCurrent === false && ageMs >= LIFECYCLE_LOCK_STALE_MS ? 'age_exceeded' : null);
    return {
        exists: true,
        ageMs,
        ownerHostMatchesCurrent,
        ownerAlive,
        staleReason,
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

function getCurrentLifecycleAsyncTargetDepth(normalizedTarget: string): number {
    const store = LIFECYCLE_ASYNC_CONTEXT.getStore();
    return store?.heldTargets.get(normalizedTarget) || 0;
}

async function runWithinLifecycleAsyncContext<T>(normalizedTarget: string, callback: () => Promise<T>): Promise<T> {
    const currentStore = LIFECYCLE_ASYNC_CONTEXT.getStore();
    if (currentStore) {
        const nextDepth = (currentStore.heldTargets.get(normalizedTarget) || 0) + 1;
        currentStore.heldTargets.set(normalizedTarget, nextDepth);
        try {
            return await callback();
        } finally {
            if (nextDepth <= 1) {
                currentStore.heldTargets.delete(normalizedTarget);
            } else {
                currentStore.heldTargets.set(normalizedTarget, nextDepth - 1);
            }
        }
    }

    const initialStore: LifecycleAsyncContextState = {
        heldTargets: new Map([[normalizedTarget, 1]])
    };
    return await LIFECYCLE_ASYNC_CONTEXT.run(initialStore, callback);
}

function buildLifecycleAsyncQueueTimeoutMessage(
    normalizedTarget: string,
    requestedOperation: string,
    blockingEntry: LifecycleAsyncQueueEntry,
    waitedMs: number,
    timeoutMs: number
): string {
    const redactedTarget = redactPath(normalizedTarget, normalizedTarget);
    const blockingElapsedMs = Math.max(0, Date.now() - blockingEntry.enqueuedAtMs);
    return (
        `Lifecycle async queue wait exceeded ${timeoutMs}ms for '${redactedTarget}' ` +
        `(requested_operation='${requestedOperation}', blocking_operation='${blockingEntry.operation}', ` +
        `waited_ms=${waitedMs}, blocking_elapsed_ms=${blockingElapsedMs}). ` +
        'This usually means a hung lifecycle callback or same-root nested async lifecycle work that never completed.'
    );
}

function createLifecycleAsyncQueueEntry(operation: string): LifecycleAsyncQueueEntry {
    let resolveStart!: () => void;
    const startPromise = new Promise<void>((resolve) => {
        resolveStart = resolve;
    });
    return {
        operation,
        enqueuedAtMs: Date.now(),
        started: false,
        startPromise,
        resolveStart
    };
}

function getOrCreateLifecycleAsyncQueueState(normalizedTarget: string): LifecycleAsyncQueueState {
    const existing = LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget);
    if (existing) {
        return existing;
    }

    const created: LifecycleAsyncQueueState = { entries: [] };
    LIFECYCLE_ASYNC_QUEUES.set(normalizedTarget, created);
    return created;
}

function startLifecycleAsyncQueueEntry(entry: LifecycleAsyncQueueEntry): void {
    if (entry.started) {
        return;
    }

    entry.started = true;
    entry.resolveStart();
}

function enqueueLifecycleAsyncQueueEntry(
    normalizedTarget: string,
    operation: string
): { queueState: LifecycleAsyncQueueState; queueEntry: LifecycleAsyncQueueEntry } {
    const queueState = getOrCreateLifecycleAsyncQueueState(normalizedTarget);
    const queueEntry = createLifecycleAsyncQueueEntry(operation);
    queueState.entries.push(queueEntry);
    if (queueState.entries[0] === queueEntry) {
        startLifecycleAsyncQueueEntry(queueEntry);
    }
    return { queueState, queueEntry };
}

function getLifecycleAsyncQueueBlockingEntry(
    queueState: LifecycleAsyncQueueState,
    queueEntry: LifecycleAsyncQueueEntry
): LifecycleAsyncQueueEntry {
    const headEntry = queueState.entries[0];
    if (headEntry && headEntry !== queueEntry) {
        return headEntry;
    }

    return queueEntry;
}

function removeLifecycleAsyncQueueEntry(
    normalizedTarget: string,
    queueState: LifecycleAsyncQueueState,
    queueEntry: LifecycleAsyncQueueEntry
): void {
    const index = queueState.entries.indexOf(queueEntry);
    if (index < 0) {
        if (queueState.entries.length === 0 && LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget) === queueState) {
            LIFECYCLE_ASYNC_QUEUES.delete(normalizedTarget);
        }
        return;
    }

    const wasHead = index === 0;
    queueState.entries.splice(index, 1);
    if (queueState.entries.length === 0) {
        if (LIFECYCLE_ASYNC_QUEUES.get(normalizedTarget) === queueState) {
            LIFECYCLE_ASYNC_QUEUES.delete(normalizedTarget);
        }
        return;
    }

    if (wasHead) {
        startLifecycleAsyncQueueEntry(queueState.entries[0]);
    }
}

async function waitForLifecycleAsyncQueueTurn(
    normalizedTarget: string,
    operation: string,
    queueState: LifecycleAsyncQueueState,
    queueEntry: LifecycleAsyncQueueEntry,
    options: LifecycleLockOptions = {}
): Promise<number> {
    if (queueEntry.started) {
        return 0;
    }

    const queueStartedAt = Date.now();
    const queueTimeoutMs = toPositiveInteger(options.queueTimeoutMs, DEFAULT_LIFECYCLE_ASYNC_QUEUE_TIMEOUT_MS);

    const completed = await new Promise<boolean>((resolve) => {
        let settled = false;
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            resolve(false);
        }, queueTimeoutMs);
        queueEntry.startPromise.then(
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(true);
            },
            () => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                resolve(true);
            }
        );
    });

    if (!completed) {
        const totalWaitedMs = Date.now() - queueStartedAt;
        throw new Error(
            buildLifecycleAsyncQueueTimeoutMessage(
                normalizedTarget,
                operation,
                getLifecycleAsyncQueueBlockingEntry(queueState, queueEntry),
                totalWaitedMs,
                queueTimeoutMs
            )
        );
    }

    return Date.now() - queueStartedAt;
}

export function getLifecycleOperationLockPath(targetRoot: string): string {
    const normalizedTarget = path.resolve(targetRoot);
    return path.join(normalizedTarget, resolveBundleName(), 'runtime', LIFECYCLE_OPERATION_LOCK_DIR_NAME);
}

function acquireLifecycleOperationLock(targetRoot: string, operation: string, options: LifecycleLockOptions = {}): { release: () => void; telemetry: LifecycleLockTelemetry } {
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
        const foreignHostAgeExceeded = inspection.ownerHostMatchesCurrent === false && inspection.staleReason === 'age_exceeded';
        const allowForeignHostRecovery = foreignHostAgeExceeded && isForeignHostLifecycleStaleRecoveryEnabled(options);
        if (inspection.exists && inspection.staleReason && (!foreignHostAgeExceeded || allowForeignHostRecovery)) {
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
            const foreignHostHint = foreignHostAgeExceeded
                ? ` Cross-host stale recovery is disabled by default; verify the remote owner is gone, then rerun with ${FOREIGN_HOST_LIFECYCLE_STALE_RECOVERY_ENV}=1 or ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 to reclaim this aged lock.`
                : '';
            throw new Error(
                `Another lifecycle operation is already running for '${redactedTarget}' ` +
                `(operation='${ownerOperation}', pid=${ownerPid}, host=${ownerHost}, lock='${redactedLockPath}').` +
                foreignHostHint
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

export function withLifecycleOperationLock<T>(targetRoot: string, operation: string, callback: () => T, options: LifecycleLockOptions = {}): T {
    const { release, telemetry } = acquireLifecycleOperationLock(targetRoot, operation, options);
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
    callback: () => Promise<T>,
    options: LifecycleLockOptions = {}
): Promise<T> {
    const normalizedTarget = path.resolve(targetRoot);
    if (getCurrentLifecycleAsyncTargetDepth(normalizedTarget) > 0) {
        const lockResult = acquireLifecycleOperationLock(targetRoot, operation, options);
        lastLifecycleLockTelemetry = { ...lockResult.telemetry, queueWaitMs: 0 };
        try {
            return await runWithinLifecycleAsyncContext(normalizedTarget, callback);
        } finally {
            lockResult.release();
        }
    }

    const { queueState, queueEntry } = enqueueLifecycleAsyncQueueEntry(normalizedTarget, operation);

    let release: (() => void) | null = null;
    try {
        const queueWaitMs = await waitForLifecycleAsyncQueueTurn(normalizedTarget, operation, queueState, queueEntry, options);
        const lockResult = acquireLifecycleOperationLock(targetRoot, operation, options);
        release = lockResult.release;
        lastLifecycleLockTelemetry = { ...lockResult.telemetry, queueWaitMs };
        return await runWithinLifecycleAsyncContext(normalizedTarget, callback);
    } finally {
        if (release) {
            release();
        }
        removeLifecycleAsyncQueueEntry(normalizedTarget, queueState, queueEntry);
    }
}
