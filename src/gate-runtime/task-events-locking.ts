import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { redactHostname as redactHostnameValue, redactPath } from '../core/redaction';

const DEFAULT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_LOCK_RETRY_MS = 25;
const DEFAULT_LOCK_STALE_MS = 30 * 60 * 1000;
const DEFAULT_LOCK_RELEASE_RETRY_MS = 25;
const DEFAULT_LOCK_RELEASE_RETRIES = 8;
const MAX_LOCK_RELEASE_RETRY_MS = 250;
const MAX_LOCK_RETRIES = 500;
const LOCK_CONTENTION_WARN_THRESHOLD = 10;
const LOCK_METADATA_GRACE_MS = 2000;
export const FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV = 'GARDA_RECOVER_FOREIGN_HOST_FILE_LOCKS';
const TRANSIENT_LOCK_ACQUIRE_ERROR_CODES = new Set(['EEXIST', 'EPERM', 'EACCES', 'EBUSY']);
const TRANSIENT_LOCK_RELEASE_ERROR_CODES = new Set(['EPERM', 'EBUSY', 'ENOTEMPTY', 'EACCES']);

export interface LockOptions {
    timeoutMs?: unknown;
    retryMs?: unknown;
    staleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
}

export interface LockHandle {
    lockPath: string;
}

export interface LockOwnerMetadata {
    pid: number | null;
    hostname: string | null;
    created_at_utc: string | null;
    metadata_status: 'missing' | 'invalid_json' | 'invalid_shape' | 'ok';
}

export interface LockInspectionResult {
    exists: boolean;
    ageMs: number | null;
    metadata: LockOwnerMetadata;
    ownerHostMatchesCurrent: boolean | null;
    ownerAlive: boolean | null;
    staleReason: 'owner_dead' | 'age_exceeded' | null;
}

export type LockContentionLevel = 'none' | 'low' | 'moderate' | 'high';
export type TaskEventLockStatus = 'ACTIVE' | 'STALE';

export interface AcquireLockTelemetry {
    retries: number;
    elapsedMs: number;
    contentionLevel: LockContentionLevel;
    staleLockRecovered: boolean;
    staleLockReason: 'owner_dead' | 'age_exceeded' | null;
}

interface LockWaitEntry {
    retries: number;
    elapsed_ms: number;
    contention_level: LockContentionLevel;
    stale_recovered: boolean;
    stale_reason: 'owner_dead' | 'age_exceeded' | null;
}

export interface LockWaitDiagnostics {
    task_lock: LockWaitEntry;
    aggregate_lock: LockWaitEntry;
    overall_contention_level: LockContentionLevel;
    summary: string;
}

export interface TaskEventLockHealth {
    lock_name: string;
    lock_path: string;
    scope: 'aggregate' | 'task';
    task_id: string | null;
    status: TaskEventLockStatus;
    age_ms: number | null;
    owner_pid: number | null;
    owner_hostname: string | null;
    owner_created_at_utc: string | null;
    owner_alive: boolean | null;
    owner_metadata_status: LockOwnerMetadata['metadata_status'];
    stale_reason: LockInspectionResult['staleReason'];
    remediation: string;
}

export interface TaskEventLockScanResult {
    lock_root: string;
    subsystem_scope_note: string;
    locks: TaskEventLockHealth[];
    active_count: number;
    stale_count: number;
}

export interface TaskEventLockCleanupResult {
    lock_root: string;
    dry_run: boolean;
    removed_locks: string[];
    removable_stale_locks: string[];
    retained_live_locks: string[];
    failed_locks: string[];
    warnings: string[];
}

function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepMsAsync(milliseconds: number): Promise<void> {
    if (!milliseconds || milliseconds <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

function getErrorCode(error: unknown): string {
    return error != null && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

function sleepMsSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function parseBooleanLike(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function writeLockMetadata(lockPath: string): void {
    const metadataPath = path.join(lockPath, 'owner.json');
    const payload = {
        pid: process.pid,
        hostname: os.hostname(),
        created_at_utc: new Date().toISOString()
    };
    fs.writeFileSync(metadataPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
}

function readLockMetadata(lockPath: string): LockOwnerMetadata {
    const metadataPath = path.join(lockPath, 'owner.json');
    let rawContent = '';
    try {
        const stats = fs.statSync(metadataPath);
        if (!stats.isFile()) {
            return {
                pid: null,
                hostname: null,
                created_at_utc: null,
                metadata_status: 'missing'
            };
        }
        rawContent = fs.readFileSync(metadataPath, 'utf8');
    } catch (error: unknown) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR' || errorCode === 'EISDIR') {
            return {
                pid: null,
                hostname: null,
                created_at_utc: null,
                metadata_status: 'missing'
            };
        }
        return {
            pid: null,
            hostname: null,
            created_at_utc: null,
            metadata_status: 'missing'
        };
    }

    try {
        const parsed = JSON.parse(rawContent) as Record<string, unknown>;
        const pidValue = typeof parsed.pid === 'number' && Number.isInteger(parsed.pid) && parsed.pid > 0
            ? parsed.pid
            : null;
        const hostnameValue = typeof parsed.hostname === 'string' && parsed.hostname.trim()
            ? parsed.hostname.trim()
            : null;
        const createdAtValue = typeof parsed.created_at_utc === 'string' && parsed.created_at_utc.trim()
            ? parsed.created_at_utc.trim()
            : null;
        const metadataStatus = pidValue || hostnameValue || createdAtValue
            ? 'ok'
            : 'invalid_shape';
        return {
            pid: pidValue,
            hostname: hostnameValue,
            created_at_utc: createdAtValue,
            metadata_status: metadataStatus
        };
    } catch {
        return {
            pid: null,
            hostname: null,
            created_at_utc: null,
            metadata_status: 'invalid_json'
        };
    }
}

function isProcessLikelyAlive(pid: number | null): boolean | null {
    if (!pid || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const errorCode = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (errorCode === 'EPERM') {
            return true;
        }
        if (errorCode === 'ESRCH') {
            return false;
        }
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

function allowForeignHostStaleRecovery(options: LockOptions | undefined): boolean {
    if (options && options.allowForeignHostStaleRecovery !== undefined) {
        return parseBooleanLike(options.allowForeignHostStaleRecovery);
    }
    return parseBooleanLike(process.env[FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV]);
}

function requiresExplicitAgeRecovery(inspection: LockInspectionResult): boolean {
    return inspection.ownerHostMatchesCurrent === false && inspection.staleReason === 'age_exceeded';
}

function isRetryableLockReleaseError(error: unknown): boolean {
    return TRANSIENT_LOCK_RELEASE_ERROR_CODES.has(getErrorCode(error));
}

function isRetryableLockAcquireError(error: unknown): boolean {
    return TRANSIENT_LOCK_ACQUIRE_ERROR_CODES.has(getErrorCode(error));
}

function getLockReleaseDelayMs(retryIndex: number): number {
    const baseDelay = DEFAULT_LOCK_RELEASE_RETRY_MS * Math.pow(2, Math.max(0, retryIndex));
    return Math.min(baseDelay, MAX_LOCK_RELEASE_RETRY_MS);
}

function formatLockReleaseDiagnostic(lockPath: string, kind: string, retries: number, elapsedMs: number, error: unknown): string {
    const code = getErrorCode(error) || 'UNKNOWN';
    return [
        `kind=${kind}`,
        `lock=${redactLockPath(lockPath)}`,
        `retries=${retries}`,
        `elapsed_ms=${elapsedMs}`,
        `code=${code}`,
        `message=${getErrorMessage(error)}`
    ].join('; ');
}

export function removeLockPathWithRetry(lockPath: string, kind = 'filesystem_lock'): void {
    let retries = 0;
    const startedAt = Date.now();
    while (true) {
        try {
            fs.rmSync(lockPath, { recursive: true, force: true });
            if (retries > 0) {
                process.stderr.write(
                    `LOCK_RELEASE_RETRY_RESOLVED: kind=${kind}; lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${Date.now() - startedAt}\n`
                );
            }
            return;
        } catch (error: unknown) {
            if (!isRetryableLockReleaseError(error) || retries >= DEFAULT_LOCK_RELEASE_RETRIES) {
                const diagnostic = formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error);
                process.stderr.write(`WARNING: LOCK_RELEASE_FAILED: ${diagnostic}\n`);
                throw new Error(`Failed to release lock after retry backoff: ${diagnostic}`);
            }

            retries += 1;
            const delayMs = getLockReleaseDelayMs(retries - 1);
            process.stderr.write(
                `WARNING: LOCK_RELEASE_RETRY: ${formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error)}; next_delay_ms=${delayMs}\n`
            );
            sleepMsSync(delayMs);
        }
    }
}

function removeLockPath(lockPath: string): void {
    removeLockPathWithRetry(lockPath, 'filesystem_lock');
}

function inspectLock(lockPath: string, staleMs: number): LockInspectionResult {
    const metadata = readLockMetadata(lockPath);
    let ageMs: number | null = null;
    try {
        const stats = fs.statSync(lockPath);
        ageMs = Math.max(0, Date.now() - stats.mtimeMs);
    } catch {
        return {
            exists: false,
            ageMs: null,
            metadata,
            ownerHostMatchesCurrent: null,
            ownerAlive: null,
            staleReason: null
        };
    }

    const ownerHostMatchesCurrent = isCurrentHostOwner(metadata.hostname);
    const ownerAlive = ownerHostMatchesCurrent === false
        ? null
        : isProcessLikelyAlive(metadata.pid);
    if (ownerAlive === false) {
        return {
            exists: true,
            ageMs,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive,
            staleReason: 'owner_dead'
        };
    }

    if (metadata.pid === null
        && ageMs !== null
        && staleMs > 0
        && ageMs >= staleMs
        && ownerHostMatchesCurrent === false) {
        return {
            exists: true,
            ageMs,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive: null,
            staleReason: 'age_exceeded'
        };
    }

    if (metadata.pid === null
        && ownerHostMatchesCurrent !== false
        && ageMs !== null && ageMs >= LOCK_METADATA_GRACE_MS) {
        return {
            exists: true,
            ageMs,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive: null,
            staleReason: 'owner_dead'
        };
    }

    if (staleMs > 0
        && ageMs >= staleMs
        && ownerHostMatchesCurrent === false
        && ownerAlive !== true) {
        return {
            exists: true,
            ageMs,
            metadata,
            ownerHostMatchesCurrent,
            ownerAlive,
            staleReason: 'age_exceeded'
        };
    }

    return {
        exists: true,
        ageMs,
        metadata,
        ownerHostMatchesCurrent,
        ownerAlive,
        staleReason: null
    };
}

export function inspectFilesystemLock(lockPath: string, options: LockOptions = {}): LockInspectionResult {
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    return inspectLock(lockPath, staleMs);
}

export function filesystemLockRequiresExplicitForeignHostRecovery(inspection: LockInspectionResult): boolean {
    return requiresExplicitAgeRecovery(inspection);
}

export function isForeignHostFilesystemLockRecoveryAllowed(options: LockOptions = {}): boolean {
    return allowForeignHostStaleRecovery(options);
}

export function reclaimStaleFilesystemLock(lockPath: string, options: LockOptions = {}): { removed: boolean; inspection: LockInspectionResult } {
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    return tryRemoveStaleLock(lockPath, staleMs, options);
}

function formatLockDiagnostic(lockPath: string, inspection: LockInspectionResult, timeoutMs: number, waitedMs: number): string {
    const ageText = typeof inspection.ageMs === 'number' ? `${inspection.ageMs}ms` : 'unknown';
    const ownerPidText = inspection.metadata.pid !== null ? String(inspection.metadata.pid) : 'unknown';
    const ownerAliveText = inspection.ownerAlive === null ? 'unknown' : (inspection.ownerAlive ? 'yes' : 'no');
    const ownerHostText = redactHostnameValue(inspection.metadata.hostname) || 'unknown';
    const createdAtText = inspection.metadata.created_at_utc || 'unknown';
    const staleReasonText = inspection.staleReason || 'none';
    const redactedLockPath = redactLockPath(lockPath);
    return [
        `Timed out acquiring file lock: ${redactedLockPath}`,
        `waited_ms=${waitedMs}`,
        `timeout_ms=${timeoutMs}`,
        `lock_age_ms=${ageText}`,
        `owner_pid=${ownerPidText}`,
        `owner_alive=${ownerAliveText}`,
        `owner_hostname=${ownerHostText}`,
        `owner_created_at_utc=${createdAtText}`,
        `owner_metadata_status=${inspection.metadata.metadata_status}`,
        `stale_reason=${staleReasonText}`,
        requiresExplicitAgeRecovery(inspection)
            ? `foreign_host_recovery_hint=verify remote owner is gone, then rerun with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1`
            : ''
    ].filter(Boolean).join('; ');
}

function tryRemoveStaleLock(lockPath: string, staleMs: number, options: LockOptions = {}): { removed: boolean; inspection: LockInspectionResult } {
    const inspection = inspectLock(lockPath, staleMs);
    if (!inspection.exists || !inspection.staleReason) {
        return { removed: false, inspection };
    }
    if (requiresExplicitAgeRecovery(inspection) && !allowForeignHostStaleRecovery(options)) {
        return { removed: false, inspection };
    }

    const tempPath = lockPath + '.stale-' + process.pid + '-' + Date.now();
    try {
        fs.renameSync(lockPath, tempPath);
    } catch {
        return { removed: false, inspection };
    }

    try {
        removeLockPath(tempPath);
    } catch {
        // Best-effort cleanup of the renamed stale directory.
    }

    return { removed: true, inspection };
}

export function classifyLockContention(retries: number, elapsedMs: number): LockContentionLevel {
    if (retries === 0) return 'none';
    if (retries < LOCK_CONTENTION_WARN_THRESHOLD && elapsedMs < 500) return 'low';
    if (retries < 100 && elapsedMs < DEFAULT_LOCK_TIMEOUT_MS / 2) return 'moderate';
    return 'high';
}

function redactLockPath(lockPath: string): string {
    const runtimeMarker = `${path.sep}runtime${path.sep}`;
    const runtimeIndex = lockPath.lastIndexOf(runtimeMarker);
    if (runtimeIndex >= 0) {
        const orchestratorRoot = lockPath.slice(0, runtimeIndex);
        return redactPath(lockPath, orchestratorRoot);
    }
    return redactPath(lockPath);
}

export function acquireFilesystemLock(lockPath: string, options: LockOptions = {}): { handle: LockHandle; telemetry: AcquireLockTelemetry } {
    const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = toPositiveInteger(options.retryMs, DEFAULT_LOCK_RETRY_MS);
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lastInspection: LockInspectionResult = inspectLock(lockPath, staleMs);
    let retries = 0;
    let contentionWarned = false;
    let staleLockRecovered = false;
    let staleLockReason: 'owner_dead' | 'age_exceeded' | null = null;

    while (true) {
        try {
            fs.mkdirSync(lockPath);
            try {
                writeLockMetadata(lockPath);
            } catch (metadataError: unknown) {
                removeLockPath(lockPath);
                throw metadataError;
            }
            const elapsedMs = Date.now() - startedAt;
            return {
                handle: { lockPath },
                telemetry: {
                    retries,
                    elapsedMs,
                    contentionLevel: classifyLockContention(retries, elapsedMs),
                    staleLockRecovered,
                    staleLockReason
                }
            };
        } catch (error: unknown) {
            const errCode = error != null && typeof error === 'object' && 'code' in error
                ? (error as { code?: string }).code
                : undefined;
            if (!isRetryableLockAcquireError(error)) {
                throw error;
            }

            if (errCode === 'EEXIST') {
                const staleAttempt = tryRemoveStaleLock(lockPath, staleMs, options);
                lastInspection = staleAttempt.inspection;
                if (staleAttempt.removed) {
                    staleLockRecovered = true;
                    staleLockReason = staleAttempt.inspection.staleReason;
                    continue;
                }
            } else {
                lastInspection = inspectLock(lockPath, staleMs);
            }

            const ownerHostMatchesCurrent = isCurrentHostOwner(lastInspection.metadata.hostname);
            const currentProcessOwnsLock = lastInspection.metadata.pid === process.pid
                && ownerHostMatchesCurrent !== false
                && lastInspection.ownerAlive !== false;
            if (
                lastInspection.exists
                && (
                currentProcessOwnsLock
                || ownerHostMatchesCurrent === false
                || (requiresExplicitAgeRecovery(lastInspection) && !allowForeignHostStaleRecovery(options))
                )
            ) {
                const waitedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + '; retries=0; wait_strategy=immediate_fail'
                );
            }

            retries += 1;

            if (!contentionWarned && retries >= LOCK_CONTENTION_WARN_THRESHOLD) {
                contentionWarned = true;
                const elapsedMs = Date.now() - startedAt;
                const ownerPid = lastInspection.metadata.pid !== null ? String(lastInspection.metadata.pid) : 'unknown';
                const ownerHost = redactHostnameValue(lastInspection.metadata.hostname) || 'unknown';
                process.stderr.write(
                    `WARNING: lock contention on ${redactLockPath(lockPath)} (retries=${retries}, elapsed_ms=${elapsedMs}, owner_pid=${ownerPid}, owner_host=${ownerHost})\n`
                );
            }

            const waitedMs = Date.now() - startedAt;
            if (retries >= MAX_LOCK_RETRIES) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}; max_retries=${MAX_LOCK_RETRIES}; wait_strategy=sync_retry`
                );
            }

            if (waitedMs >= timeoutMs) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}; wait_strategy=sync_retry`
                );
            }

            sleepMsSync(retryMs);
        }
    }
}

export async function acquireFilesystemLockAsync(lockPath: string, options: LockOptions = {}): Promise<{ handle: LockHandle; telemetry: AcquireLockTelemetry }> {
    const timeoutMs = toPositiveInteger(options.timeoutMs, DEFAULT_LOCK_TIMEOUT_MS);
    const retryMs = toPositiveInteger(options.retryMs, DEFAULT_LOCK_RETRY_MS);
    const staleMs = toPositiveInteger(options.staleMs, DEFAULT_LOCK_STALE_MS);
    const startedAt = Date.now();
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    let lastInspection: LockInspectionResult = inspectLock(lockPath, staleMs);
    let retries = 0;
    let contentionWarned = false;
    let staleLockRecovered = false;
    let staleLockReason: 'owner_dead' | 'age_exceeded' | null = null;

    while (true) {
        try {
            fs.mkdirSync(lockPath);
            try {
                writeLockMetadata(lockPath);
            } catch (metadataError: unknown) {
                removeLockPath(lockPath);
                throw metadataError;
            }
            const elapsedMs = Date.now() - startedAt;
            const contentionLevel = classifyLockContention(retries, elapsedMs);
            if (contentionLevel !== 'none' && contentionLevel !== 'low') {
                process.stderr.write(
                    `CONTENTION_RESOLVED: lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${elapsedMs}; contention_level=${contentionLevel}; stale_recovered=${staleLockRecovered}\n`
                );
            }
            return {
                handle: { lockPath },
                telemetry: {
                    retries,
                    elapsedMs,
                    contentionLevel,
                    staleLockRecovered,
                    staleLockReason
                }
            };
        } catch (error: unknown) {
            const errCode = error != null && typeof error === 'object' && 'code' in error
                ? (error as { code?: string }).code
                : undefined;
            if (!isRetryableLockAcquireError(error)) {
                throw error;
            }

            if (errCode === 'EEXIST') {
                const staleAttempt = tryRemoveStaleLock(lockPath, staleMs, options);
                lastInspection = staleAttempt.inspection;
                if (staleAttempt.removed) {
                    staleLockRecovered = true;
                    staleLockReason = staleAttempt.inspection.staleReason;
                    continue;
                }
            } else {
                lastInspection = inspectLock(lockPath, staleMs);
            }

            const ownerHostMatchesCurrent = isCurrentHostOwner(lastInspection.metadata.hostname);
            const currentProcessOwnsLock = lastInspection.metadata.pid === process.pid
                && ownerHostMatchesCurrent !== false
                && lastInspection.ownerAlive !== false;
            if (
                lastInspection.exists
                && (
                currentProcessOwnsLock
                || ownerHostMatchesCurrent === false
                || (requiresExplicitAgeRecovery(lastInspection) && !allowForeignHostStaleRecovery(options))
                )
            ) {
                const waitedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + '; retries=0; wait_strategy=immediate_fail'
                );
            }

            retries += 1;

            if (!contentionWarned && retries >= LOCK_CONTENTION_WARN_THRESHOLD) {
                contentionWarned = true;
                const elapsedMs = Date.now() - startedAt;
                const ownerPid = lastInspection.metadata.pid !== null ? String(lastInspection.metadata.pid) : 'unknown';
                const ownerHost = redactHostnameValue(lastInspection.metadata.hostname) || 'unknown';
                process.stderr.write(
                    `WARNING: lock contention on ${redactLockPath(lockPath)} (retries=${retries}, elapsed_ms=${elapsedMs}, owner_pid=${ownerPid}, owner_host=${ownerHost})\n`
                );
            }

            if (retries >= MAX_LOCK_RETRIES) {
                const elapsedMs = Date.now() - startedAt;
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, elapsedMs)
                    + `; retries=${retries}; max_retries=${MAX_LOCK_RETRIES}`
                );
            }

            const waitedMs = Date.now() - startedAt;
            if (waitedMs >= timeoutMs) {
                throw new Error(
                    formatLockDiagnostic(lockPath, lastInspection, timeoutMs, waitedMs)
                    + `; retries=${retries}`
                );
            }

            await sleepMsAsync(retryMs);
        }
    }
}

export function releaseFilesystemLock(lockHandle: LockHandle | null): void {
    if (!lockHandle || !lockHandle.lockPath) {
        return;
    }
    removeLockPath(lockHandle.lockPath);
}

function classifyLockName(entryName: string): { scope: 'aggregate' | 'task'; taskId: string | null } | null {
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

function buildLockRemediation(entryName: string, inspection: LockInspectionResult): string {
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

function buildTaskEventLockHealth(lockRoot: string, entryName: string, inspection: LockInspectionResult): TaskEventLockHealth | null {
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
        owner_pid: inspection.metadata.pid,
        owner_hostname: redactHostnameValue(inspection.metadata.hostname),
        owner_created_at_utc: inspection.metadata.created_at_utc,
        owner_alive: inspection.ownerAlive,
        owner_metadata_status: inspection.metadata.metadata_status,
        stale_reason: inspection.staleReason,
        remediation: buildLockRemediation(entryName, inspection)
    };
}

function getTaskEventsRoot(orchestratorRoot: string): string {
    return path.join(orchestratorRoot, 'runtime', 'task-events');
}

function listTaskEventLockEntries(lockRoot: string): string[] {
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

export function withFilesystemLock<T>(lockPath: string, options: LockOptions, callback: () => T): { result: T; telemetry: AcquireLockTelemetry } {
    const { handle, telemetry } = acquireFilesystemLock(lockPath, options);
    try {
        return { result: callback(), telemetry };
    } finally {
        releaseFilesystemLock(handle);
    }
}

export async function withFilesystemLockAsync<T>(lockPath: string, options: LockOptions, callback: () => Promise<T> | T): Promise<{ result: T; telemetry: AcquireLockTelemetry }> {
    const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, options);
    try {
        return { result: await callback(), telemetry };
    } finally {
        releaseFilesystemLock(handle);
    }
}

function pickHigherContention(a: LockContentionLevel, b: LockContentionLevel): LockContentionLevel {
    const order: LockContentionLevel[] = ['none', 'low', 'moderate', 'high'];
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

function buildLockWaitSummary(entry: LockWaitEntry, label: string): string {
    if (entry.contention_level === 'none') return '';
    const parts = [`${label}: contention_level=${entry.contention_level}, retries=${entry.retries}, elapsed_ms=${entry.elapsed_ms}`];
    if (entry.stale_recovered) {
        parts.push(`stale_recovered=true (${entry.stale_reason || 'unknown'})`);
    }
    return parts.join(', ');
}

export function buildLockWaitDiagnostics(lockTelemetry: {
    task_lock_retries?: number;
    task_lock_elapsed_ms?: number;
    task_lock_contention_level?: LockContentionLevel;
    task_lock_stale_recovered?: boolean;
    task_lock_stale_reason?: 'owner_dead' | 'age_exceeded' | null;
    aggregate_lock_retries?: number;
    aggregate_lock_elapsed_ms?: number;
    aggregate_lock_contention_level?: LockContentionLevel;
    aggregate_lock_stale_recovered?: boolean;
    aggregate_lock_stale_reason?: 'owner_dead' | 'age_exceeded' | null;
    aggregate_append_mode?: 'lock_free' | 'locked' | 'locked_prune';
} | null | undefined): LockWaitDiagnostics {
    const taskLock: LockWaitEntry = {
        retries: lockTelemetry?.task_lock_retries ?? 0,
        elapsed_ms: lockTelemetry?.task_lock_elapsed_ms ?? 0,
        contention_level: lockTelemetry?.task_lock_contention_level ?? 'none',
        stale_recovered: lockTelemetry?.task_lock_stale_recovered ?? false,
        stale_reason: lockTelemetry?.task_lock_stale_reason ?? null
    };

    const aggregateLock: LockWaitEntry = {
        retries: lockTelemetry?.aggregate_lock_retries ?? 0,
        elapsed_ms: lockTelemetry?.aggregate_lock_elapsed_ms ?? 0,
        contention_level: lockTelemetry?.aggregate_lock_contention_level ?? 'none',
        stale_recovered: lockTelemetry?.aggregate_lock_stale_recovered ?? false,
        stale_reason: lockTelemetry?.aggregate_lock_stale_reason ?? null
    };

    const overallLevel = pickHigherContention(taskLock.contention_level, aggregateLock.contention_level);

    const summaryParts: string[] = [];
    const taskSummary = buildLockWaitSummary(taskLock, 'task_lock');
    if (taskSummary) summaryParts.push(taskSummary);
    const aggregateSummary = buildLockWaitSummary(aggregateLock, 'aggregate_lock');
    if (aggregateSummary) summaryParts.push(aggregateSummary);

    const summary = summaryParts.length > 0
        ? `Lock contention detected (overall=${overallLevel}): ${summaryParts.join('; ')}`
        : 'No lock contention detected.';

    return {
        task_lock: taskLock,
        aggregate_lock: aggregateLock,
        overall_contention_level: overallLevel,
        summary
    };
}
