import * as fs from 'node:fs';

import { DEFAULT_LOCK_RELEASE_RETRIES, DEFAULT_LOCK_RELEASE_RETRY_MS, MAX_LOCK_RELEASE_RETRY_MS, TRANSIENT_LOCK_ACQUIRE_ERROR_CODES, TRANSIENT_LOCK_RELEASE_ERROR_CODES } from './task-events-locking-types';
import type { LockOwnerMetadata } from './task-events-locking-types';
import { getErrorCode, getErrorMessage, createLockId, redactLockPath, sanitizeLockIdForPath, sleepMsSync } from './task-events-locking-support';
import { lockMetadataMatchesLockId, normalizeHostname, readLockMetadata } from './task-events-locking-metadata';

export function isRetryableLockReleaseError(error: unknown): boolean {
    return TRANSIENT_LOCK_RELEASE_ERROR_CODES.has(getErrorCode(error));
}

export function isRetryableLockAcquireError(error: unknown): boolean {
    return TRANSIENT_LOCK_ACQUIRE_ERROR_CODES.has(getErrorCode(error));
}

export function getLockReleaseDelayMs(retryIndex: number): number {
    const baseDelay = DEFAULT_LOCK_RELEASE_RETRY_MS * Math.pow(2, Math.max(0, retryIndex));
    return Math.min(baseDelay, MAX_LOCK_RELEASE_RETRY_MS);
}

export function formatLockReleaseDiagnostic(lockPath: string, kind: string, retries: number, elapsedMs: number, error: unknown): string {
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

export function createTransientLockPath(lockPath: string, kind: 'releasing' | 'stale', lockId?: string): string {
    const suffixParts = [
        kind,
        String(process.pid),
        String(Date.now()),
        sanitizeLockIdForPath(lockId || createLockId())
    ];
    return `${lockPath}.${suffixParts.join('-')}`;
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

export function removeLockPath(lockPath: string): void {
    removeLockPathWithRetry(lockPath, 'filesystem_lock');
}

export function renameLockPathWithRetry(
    lockPath: string,
    createDestinationPath: () => string,
    kind = 'filesystem_lock_rename',
    isExpectedOwner?: () => boolean
): string | null {
    let retries = 0;
    const startedAt = Date.now();
    while (true) {
        if (isExpectedOwner && !isExpectedOwner()) {
            return null;
        }

        const destinationPath = createDestinationPath();
        try {
            fs.renameSync(lockPath, destinationPath);
            if (retries > 0) {
                process.stderr.write(
                    `LOCK_RELEASE_RETRY_RESOLVED: kind=${kind}; lock=${redactLockPath(lockPath)}; retries=${retries}; elapsed_ms=${Date.now() - startedAt}\n`
                );
            }
            return destinationPath;
        } catch (error: unknown) {
            const errorCode = getErrorCode(error);
            if (errorCode === 'ENOENT' || errorCode === 'ENOTDIR') {
                return null;
            }
            if (!isRetryableLockReleaseError(error) || retries >= DEFAULT_LOCK_RELEASE_RETRIES) {
                const diagnostic = formatLockReleaseDiagnostic(lockPath, kind, retries, Date.now() - startedAt, error);
                process.stderr.write(`WARNING: LOCK_RELEASE_FAILED: ${diagnostic}\n`);
                throw new Error(`Failed to claim lock for release after retry backoff: ${diagnostic}`);
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

export function lockMetadataMatchesCandidate(before: LockOwnerMetadata, after: LockOwnerMetadata): boolean {
    if (before.lock_id || after.lock_id) {
        return Boolean(before.lock_id && before.lock_id === after.lock_id);
    }
    return before.metadata_status === after.metadata_status
        && before.pid === after.pid
        && normalizeHostname(before.hostname) === normalizeHostname(after.hostname)
        && before.created_at_utc === after.created_at_utc;
}

export function restoreMismatchedClaimedLock(claimedPath: string, originalPath: string): void {
    try {
        if (!fs.existsSync(originalPath)) {
            fs.renameSync(claimedPath, originalPath);
        }
    } catch (error: unknown) {
        process.stderr.write(
            `WARNING: LOCK_RELEASE_RESTORE_FAILED: lock=${redactLockPath(originalPath)}; claimed=${redactLockPath(claimedPath)}; message=${getErrorMessage(error)}\n`
        );
    }
}

export function claimOwnedLockForRelease(lockPath: string, lockId: string): string | null {
    const releasingPath = renameLockPathWithRetry(
        lockPath,
        () => createTransientLockPath(lockPath, 'releasing', lockId),
        'filesystem_lock_release_claim',
        () => lockMetadataMatchesLockId(readLockMetadata(lockPath), lockId)
    );
    if (!releasingPath) {
        return null;
    }

    const claimedMetadata = readLockMetadata(releasingPath);
    if (lockMetadataMatchesLockId(claimedMetadata, lockId)) {
        return releasingPath;
    }

    restoreMismatchedClaimedLock(releasingPath, lockPath);
    return null;
}
