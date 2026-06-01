import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { redactPath } from '../core/redaction';

import { DEFAULT_LOCK_TIMEOUT_MS, LOCK_CONTENTION_WARN_THRESHOLD, LOCK_OWNER_COMMAND_MAX_LENGTH, MAX_LOCK_RETRIES } from './task-events-locking-types';
import type { LockContentionLevel, LockOptions } from './task-events-locking-types';

export function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function toOptionalPositiveInteger(value: unknown): number | null {
    if (value === undefined || value === null) {
        return null;
    }
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function resolveMaxLockRetries(timeoutMs: number, retryMs: number): number {
    const boundedRetryMs = Math.max(1, retryMs);
    const retriesNeededToReachTimeout = Math.ceil(timeoutMs / boundedRetryMs) + 1;
    return Math.max(MAX_LOCK_RETRIES, retriesNeededToReachTimeout);
}

export function sleepMsAsync(milliseconds: number): Promise<void> {
    if (!milliseconds || milliseconds <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

export function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}

export function getErrorCode(error: unknown): string {
    return error != null && typeof error === 'object' && 'code' in error
        ? String((error as { code?: unknown }).code || '')
        : '';
}

export function createLockId(): string {
    return randomUUID();
}

export function sanitizeLockIdForPath(lockId: string): string {
    return lockId.replace(/[^A-Za-z0-9._-]/g, '-').slice(0, 80) || 'unknown';
}

export function sleepMsSync(milliseconds: number): void {
    if (!milliseconds || milliseconds <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

export function parseBooleanLike(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

export function getLockOwnerCommand(options: LockOptions | undefined): string | null {
    const explicitLabel = typeof options?.ownerLabel === 'string' ? options.ownerLabel.trim() : '';
    const rawLabel = explicitLabel || path.basename(process.argv[1] || process.argv[0] || '');
    if (!rawLabel) {
        return null;
    }
    return rawLabel.slice(0, LOCK_OWNER_COMMAND_MAX_LENGTH);
}

export function redactLockPath(lockPath: string): string {
    const runtimeMarker = `${path.sep}runtime${path.sep}`;
    const runtimeIndex = lockPath.lastIndexOf(runtimeMarker);
    if (runtimeIndex >= 0) {
        const orchestratorRoot = lockPath.slice(0, runtimeIndex);
        return redactPath(lockPath, orchestratorRoot);
    }
    return redactPath(lockPath);
}

export function classifyLockContention(retries: number, elapsedMs: number): LockContentionLevel {
    if (retries === 0) return 'none';
    if (retries < LOCK_CONTENTION_WARN_THRESHOLD && elapsedMs < 500) return 'low';
    if (retries < 100 && elapsedMs < DEFAULT_LOCK_TIMEOUT_MS / 2) return 'moderate';
    return 'high';
}
