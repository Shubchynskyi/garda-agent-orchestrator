import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../core/filesystem';
import {
    acquireFilesystemLock,
    filesystemLockRequiresExplicitForeignHostRecovery,
    FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV,
    inspectFilesystemLock,
    isForeignHostFilesystemLockRecoveryAllowed,
    reclaimStaleFilesystemLock,
    releaseFilesystemLock
} from './task-events';
import { parseReviewArtifactFileName, upsertEntry } from './reviews-index';

const DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS = 25;
const DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS = 30 * 1000;
const REVIEWS_INDEX_FILE_NAME = 'reviews-index.json';

export interface ReviewArtifactLockOptions {
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
}

export interface ReviewArtifactLockTelemetry {
    retries: number;
    elapsedMs: number;
}

export interface ReviewArtifactWriteResult {
    artifact_path: string;
    lock_path: string;
    telemetry: ReviewArtifactLockTelemetry;
}

export interface ReviewArtifactRollbackState {
    existed: boolean;
    content: string | null;
}

export type ReviewArtifactLockStatus = 'ACTIVE' | 'STALE';

export interface ReviewArtifactLockHealth {
    lock_name: string;
    lock_path: string;
    artifact_path: string;
    task_id: string | null;
    artifact_type: string | null;
    status: ReviewArtifactLockStatus;
    age_ms: number | null;
    owner_pid: number | null;
    owner_hostname: string | null;
    owner_created_at_utc: string | null;
    owner_alive: boolean | null;
    owner_metadata_status: 'missing' | 'invalid_json' | 'invalid_shape' | 'ok';
    stale_reason: 'owner_dead' | 'age_exceeded' | null;
    remediation: string;
}

export interface ReviewArtifactLockScanResult {
    lock_root: string;
    subsystem_scope_note: string;
    locks: ReviewArtifactLockHealth[];
    active_count: number;
    stale_count: number;
}

export interface ReviewArtifactLockCleanupResult {
    lock_root: string;
    dry_run: boolean;
    removed_locks: string[];
    removable_stale_locks: string[];
    retained_live_locks: string[];
    failed_locks: string[];
    warnings: string[];
}

const REVIEW_ARTIFACT_LOCK_SUBSYSTEM_NOTE =
    'Review-artifact locks under runtime/reviews/*.lock and the shared runtime/.reviews-index.lock participate in the review-artifact lock subsystem.';

interface ReviewArtifactLockTarget {
    lockName: string;
    lockPath: string;
    artifactPath: string;
    taskId: string | null;
    artifactType: string | null;
}

function getReviewArtifactLockStaleMs(options: ReviewArtifactLockOptions): number {
    const parsed = Number.parseInt(String(options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS;
}

function getReviewsRoot(orchestratorRoot: string): string {
    return path.join(orchestratorRoot, 'runtime', 'reviews');
}

function listReviewArtifactLockEntries(lockRoot: string): string[] {
    if (!fs.existsSync(lockRoot) || !fs.statSync(lockRoot).isDirectory()) {
        return [];
    }
    return fs.readdirSync(lockRoot)
        .filter((entryName) => {
            if (!entryName.endsWith('.lock')) {
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

function parseStandaloneReviewLockTaskId(artifactName: string): { taskId: string; artifactType: string } | null {
    const completionGateMatch = /^(T-.+)-completion-gate$/.exec(artifactName);
    if (!completionGateMatch || !completionGateMatch[1]) {
        return null;
    }
    return {
        taskId: completionGateMatch[1],
        artifactType: 'completion-gate'
    };
}

function buildReviewArtifactLockRemediation(entryName: string, ownerPid: number | null, staleReason: 'owner_dead' | 'age_exceeded' | null): string {
    if (staleReason === 'age_exceeded') {
        return [
            `Verify the remote owner is gone, then rerun with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 and 'garda doctor --target-root "." --cleanup-stale-locks --dry-run' before applying cleanup for '${entryName}'.`,
            'Do not delete live review-artifact locks manually.'
        ].join(' ');
    }
    if (staleReason) {
        return [
            `Run 'garda doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the review-artifact lock candidate list looks correct.`,
            'Only proven-stale review-artifact locks under runtime/reviews/*.lock are cleaned automatically.'
        ].join(' ');
    }
    return [
        `Wait for the owning process to release '${entryName}' or terminate PID ${ownerPid === null ? 'unknown' : String(ownerPid)} safely if it is hung.`,
        'Do not delete live review-artifact locks manually.'
    ].join(' ');
}

function resolveReviewArtifactLockTarget(lockRoot: string, entryName: string): ReviewArtifactLockTarget {
    const lockPath = path.join(lockRoot, entryName);
    const artifactName = entryName.slice(0, -'.lock'.length);
    const parsed = parseReviewArtifactFileName(artifactName) || parseStandaloneReviewLockTaskId(artifactName);
    return {
        lockName: entryName,
        lockPath: lockPath.replace(/\\/g, '/'),
        artifactPath: path.join(lockRoot, artifactName).replace(/\\/g, '/'),
        taskId: parsed?.taskId ?? null,
        artifactType: parsed?.artifactType ?? null
    };
}

function resolveSharedReviewsIndexLockTarget(orchestratorRoot: string): ReviewArtifactLockTarget | null {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const lockPath = path.join(path.dirname(reviewsRoot), '.reviews-index.lock');
    try {
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            return null;
        }
    } catch {
        return null;
    }
    return {
        lockName: path.basename(lockPath),
        lockPath: lockPath.replace(/\\/g, '/'),
        artifactPath: path.join(reviewsRoot, REVIEWS_INDEX_FILE_NAME).replace(/\\/g, '/'),
        taskId: null,
        artifactType: 'reviews-index'
    };
}

function resolveReviewArtifactLockTargets(orchestratorRoot: string): ReviewArtifactLockTarget[] {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const targets = listReviewArtifactLockEntries(reviewsRoot)
        .map((entryName) => resolveReviewArtifactLockTarget(reviewsRoot, entryName));
    const sharedIndexLock = resolveSharedReviewsIndexLockTarget(orchestratorRoot);
    if (sharedIndexLock) {
        targets.push(sharedIndexLock);
    }
    return targets.sort((left, right) => left.lockName.localeCompare(right.lockName));
}

function buildReviewArtifactLockHealth(target: ReviewArtifactLockTarget, options: ReviewArtifactLockOptions): ReviewArtifactLockHealth | null {
    const inspection = inspectFilesystemLock(target.lockPath, {
        staleMs: getReviewArtifactLockStaleMs(options),
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    if (!inspection.exists) {
        return null;
    }

    return {
        lock_name: target.lockName,
        lock_path: target.lockPath,
        artifact_path: target.artifactPath,
        task_id: target.taskId,
        artifact_type: target.artifactType,
        status: inspection.staleReason ? 'STALE' : 'ACTIVE',
        age_ms: inspection.ageMs,
        owner_pid: inspection.metadata.pid,
        owner_hostname: inspection.metadata.hostname,
        owner_created_at_utc: inspection.metadata.created_at_utc,
        owner_alive: inspection.ownerAlive,
        owner_metadata_status: inspection.metadata.metadata_status,
        stale_reason: inspection.staleReason,
        remediation: buildReviewArtifactLockRemediation(target.lockName, inspection.metadata.pid, inspection.staleReason)
    };
}

export function scanReviewArtifactLocks(orchestratorRoot: string, options: ReviewArtifactLockOptions = {}): ReviewArtifactLockScanResult {
    const lockRoot = getReviewsRoot(orchestratorRoot);
    const locks = resolveReviewArtifactLockTargets(orchestratorRoot)
        .map((target) => buildReviewArtifactLockHealth(target, options))
        .filter((lock): lock is ReviewArtifactLockHealth => lock !== null);

    return {
        lock_root: lockRoot.replace(/\\/g, '/'),
        subsystem_scope_note: REVIEW_ARTIFACT_LOCK_SUBSYSTEM_NOTE,
        locks,
        active_count: locks.filter((lock) => lock.status === 'ACTIVE').length,
        stale_count: locks.filter((lock) => lock.status === 'STALE').length
    };
}

export function cleanupStaleReviewArtifactLocks(
    orchestratorRoot: string,
    options: ReviewArtifactLockOptions & { dryRun?: boolean } = {}
): ReviewArtifactLockCleanupResult {
    const dryRun = options.dryRun === true;
    const lockRoot = getReviewsRoot(orchestratorRoot);
    const staleMs = getReviewArtifactLockStaleMs(options);
    const foreignHostRecoveryAllowed = isForeignHostFilesystemLockRecoveryAllowed({
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    const removableStaleLocks: string[] = [];
    const retainedLiveLocks: string[] = [];
    const removedLocks: string[] = [];
    const failedLocks: string[] = [];
    const warnings: string[] = [];

    for (const target of resolveReviewArtifactLockTargets(orchestratorRoot)) {
        const inspection = inspectFilesystemLock(target.lockPath, {
            staleMs,
            allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
        });
        if (!inspection.exists) {
            continue;
        }

        if (!inspection.staleReason) {
            retainedLiveLocks.push(target.lockName);
            continue;
        }

        if (filesystemLockRequiresExplicitForeignHostRecovery(inspection) && !foreignHostRecoveryAllowed) {
            retainedLiveLocks.push(target.lockName);
            warnings.push(
                `Skipped aged foreign-host review-artifact lock '${target.lockName}': rerun cleanup with ${FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV}=1 after verifying the remote owner is gone.`
            );
            continue;
        }

        removableStaleLocks.push(target.lockName);
        if (dryRun) {
            continue;
        }

        try {
            const removalAttempt = reclaimStaleFilesystemLock(target.lockPath, {
                staleMs,
                allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
            });
            if (removalAttempt.removed) {
                removedLocks.push(target.lockName);
                continue;
            }

            const refreshed = inspectFilesystemLock(target.lockPath, {
                staleMs,
                allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
            });
            if (!refreshed.exists) {
                continue;
            }
            if (!refreshed.staleReason) {
                retainedLiveLocks.push(target.lockName);
                continue;
            }

            failedLocks.push(target.lockName);
            warnings.push(`Failed to remove stale review-artifact lock '${target.lockName}': stale candidate changed before cleanup could claim it safely.`);
        } catch (error: unknown) {
            failedLocks.push(target.lockName);
            warnings.push(`Failed to remove stale review-artifact lock '${target.lockName}': ${error instanceof Error ? error.message : String(error)}`);
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

export function getReviewArtifactLockPath(artifactPath: string): string {
    return `${artifactPath}.lock`;
}

export function writeArtifactFileAtomically(filePath: string, content: string): string {
    return writeFileAtomically(filePath, content, { encoding: 'utf8' });
}

export function withReviewArtifactLock<T>(
    artifactPath: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): { result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry } {
    const lockPath = getReviewArtifactLockPath(artifactPath);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    });
    try {
        return {
            result: callback(),
            lock_path: lockPath,
            telemetry
        };
    } finally {
        releaseFilesystemLock(handle);
    }
}

export function writeReviewArtifactText(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    const { lock_path, telemetry } = withReviewArtifactLock(artifactPath, () => {
        writeArtifactFileAtomically(artifactPath, content);
    }, options);
    try {
        upsertEntry(path.dirname(artifactPath), path.basename(artifactPath));
    } catch {
        // Index update is best-effort; artifact write succeeded
    }
    return {
        artifact_path: artifactPath,
        lock_path,
        telemetry
    };
}

export function writeReviewArtifactJson(
    artifactPath: string,
    payload: unknown,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    return writeReviewArtifactText(artifactPath, `${JSON.stringify(payload, null, 2)}\n`, options);
}

export type ReviewArtifactTransactionalWrite =
    | {
        artifactPath: string;
        contentType: 'json';
        payload: unknown;
        options?: ReviewArtifactLockOptions;
    }
    | {
        artifactPath: string;
        contentType: 'text';
        content: string;
        options?: ReviewArtifactLockOptions;
    };

export function captureReviewArtifactRollbackState(artifactPath: string): ReviewArtifactRollbackState {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            existed: false,
            content: null
        };
    }
    return {
        existed: true,
        content: fs.readFileSync(artifactPath, 'utf8')
    };
}

export function restoreReviewArtifactFromRollbackState(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState,
    options: ReviewArtifactLockOptions & { ensureTrailingNewline?: boolean } = {}
): void {
    if (!rollbackState.existed) {
        if (fs.existsSync(artifactPath)) {
            fs.rmSync(artifactPath, { force: true });
        }
        return;
    }
    const content = rollbackState.content || '';
    writeReviewArtifactText(
        artifactPath,
        options.ensureTrailingNewline && !content.endsWith('\n') ? `${content}\n` : content,
        options
    );
}

export async function writeReviewArtifactsWithRollback<T>(
    writes: readonly ReviewArtifactTransactionalWrite[],
    afterWrites: () => Promise<T>
): Promise<T> {
    const rollbackStates = writes.map((entry) => ({
        artifactPath: entry.artifactPath,
        rollbackState: captureReviewArtifactRollbackState(entry.artifactPath),
        options: entry.options
    }));
    try {
        for (const entry of writes) {
            if (entry.contentType === 'json') {
                writeReviewArtifactJson(entry.artifactPath, entry.payload, entry.options);
            } else {
                writeReviewArtifactText(entry.artifactPath, entry.content, entry.options);
            }
        }
        return await afterWrites();
    } catch (error: unknown) {
        try {
            for (let index = rollbackStates.length - 1; index >= 0; index -= 1) {
                const entry = rollbackStates[index];
                restoreReviewArtifactFromRollbackState(entry.artifactPath, entry.rollbackState, entry.options);
            }
        } catch {
            // Preserve the original write or post-write failure.
        }
        throw error;
    }
}
