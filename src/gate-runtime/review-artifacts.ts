import * as fs from 'node:fs';
import * as path from 'node:path';

import { writeFileAtomically } from '../core/filesystem';
import {
    acquireFilesystemLock,
    acquireFilesystemLockAsync,
    filesystemLockRequiresExplicitForeignHostRecovery,
    FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV,
    inspectFilesystemLock,
    isForeignHostFilesystemLockRecoveryAllowed,
    reclaimStaleFilesystemLock,
    releaseFilesystemLock
} from './task-events';
import {
    beginInProcessReviewTransactionSnapshot,
    currentProcessOwnsReviewTransactionLock,
    parseReviewArtifactFileName,
    rebuildAndPersistIndex,
    resolveIndexPath,
    resolveReviewTransactionLockPath,
    type ReviewsIndexMutationStatus,
    upsertEntry
} from './reviews-index';

const DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS = 25;
const DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS = 30 * 1000;
const REVIEWS_INDEX_FILE_NAME = 'reviews-index.json';
const inProcessReviewTransactionQueues = new Map<string, Promise<void>>();

export interface ReviewArtifactLockOptions {
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
    requireIndexUpdate?: unknown;
}

export interface ReviewArtifactLockTelemetry {
    retries: number;
    elapsedMs: number;
}

export interface ReviewArtifactWriteResult {
    artifact_path: string;
    lock_path: string;
    telemetry: ReviewArtifactLockTelemetry;
    index_update_status: ReviewsIndexMutationStatus;
    index_path: string;
    index_update_error?: string;
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
    'Review-artifact locks under runtime/reviews/*.lock plus shared runtime/.reviews-index.lock and runtime/.reviews-transaction.lock participate in the review-artifact lock subsystem.';

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

function resolveSharedReviewTransactionLockTarget(orchestratorRoot: string): ReviewArtifactLockTarget | null {
    const reviewsRoot = getReviewsRoot(orchestratorRoot);
    const lockPath = resolveReviewTransactionLockPath(reviewsRoot);
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
        artifactPath: reviewsRoot.replace(/\\/g, '/'),
        taskId: null,
        artifactType: 'reviews-transaction'
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
    const sharedTransactionLock = resolveSharedReviewTransactionLockTarget(orchestratorRoot);
    if (sharedTransactionLock) {
        targets.push(sharedTransactionLock);
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

export function getReviewArtifactTransactionLockPath(reviewsDir: string): string {
    return resolveReviewTransactionLockPath(reviewsDir);
}

function parseBooleanLike(value: unknown): boolean {
    const normalized = String(value ?? '').trim().toLowerCase();
    return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function shouldRequireIndexUpdate(options: ReviewArtifactLockOptions): boolean {
    return parseBooleanLike(options.requireIndexUpdate);
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

function withReviewArtifactTransactionLock<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): { result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry } {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle, telemetry } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
        ownerLabel: 'review-artifact-transaction'
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

export function withReviewArtifactReadBarrier<T>(
    reviewsDir: string,
    callback: () => T,
    options: ReviewArtifactLockOptions = {}
): T {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        return callback();
    }
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    const { handle } = acquireFilesystemLock(lockPath, {
        timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
        retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
        staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
        ownerLabel: 'review-artifact-read-barrier'
    });
    try {
        return callback();
    } finally {
        releaseFilesystemLock(handle);
    }
}

async function withInProcessReviewTransactionQueue<T>(lockPath: string, callback: () => Promise<T>): Promise<T> {
    const previous = inProcessReviewTransactionQueues.get(lockPath) || Promise.resolve();
    const next = previous.catch(() => undefined).then(callback);
    const queueTail = next.then(() => undefined, () => undefined);
    inProcessReviewTransactionQueues.set(lockPath, queueTail);
    try {
        return await next;
    } finally {
        if (inProcessReviewTransactionQueues.get(lockPath) === queueTail) {
            inProcessReviewTransactionQueues.delete(lockPath);
        }
    }
}

async function withReviewArtifactTransactionLockAsync<T>(
    reviewsDir: string,
    callback: () => Promise<T>,
    options: ReviewArtifactLockOptions = {}
): Promise<{ result: T; lock_path: string; telemetry: ReviewArtifactLockTelemetry }> {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    return await withInProcessReviewTransactionQueue(lockPath, async () => {
        const { handle, telemetry } = await acquireFilesystemLockAsync(lockPath, {
            timeoutMs: options.lockTimeoutMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_TIMEOUT_MS,
            retryMs: options.lockRetryMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_RETRY_MS,
            staleMs: options.lockStaleMs ?? DEFAULT_REVIEW_ARTIFACT_LOCK_STALE_MS,
            allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery,
            ownerLabel: 'review-artifact-transaction'
        });
        const releaseTransactionSnapshot = beginInProcessReviewTransactionSnapshot(reviewsDir);
        try {
            return {
                result: await callback(),
                lock_path: lockPath,
                telemetry
            };
        } finally {
            try {
                releaseTransactionSnapshot();
            } finally {
                releaseFilesystemLock(handle);
            }
        }
    });
}

function writeReviewArtifactTextUnlocked(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {},
    updateIndex: boolean = true
): ReviewArtifactWriteResult {
    const rollbackState = shouldRequireIndexUpdate(options)
        ? captureReviewArtifactRollbackState(artifactPath)
        : null;
    const { lock_path, telemetry } = withReviewArtifactLock(artifactPath, () => {
        writeArtifactFileAtomically(artifactPath, content);
    }, options);
    const reviewsDir = path.dirname(artifactPath);
    const indexUpdate = updateIndex
        ? upsertEntry(reviewsDir, path.basename(artifactPath))
        : {
            status: 'updated' as const,
            index_path: resolveIndexPath(reviewsDir),
            file_name: path.basename(artifactPath)
        };
    if (indexUpdate.status === 'failed' && shouldRequireIndexUpdate(options)) {
        if (rollbackState) {
            try {
                restoreReviewArtifactFromRollbackStateUnlocked(artifactPath, rollbackState, {
                    ...options,
                    requireIndexUpdate: false
                });
            } catch {
                // Preserve the index failure as the primary critical write error.
            }
        }
        throw new Error(
            `Review artifact index update failed for '${path.basename(artifactPath)}': ${indexUpdate.error || 'unknown error'}`
        );
    }
    return {
        artifact_path: artifactPath,
        lock_path,
        telemetry,
        index_update_status: indexUpdate.status,
        index_path: indexUpdate.index_path,
        ...(indexUpdate.error ? { index_update_error: indexUpdate.error } : {})
    };
}

export function writeReviewArtifactText(
    artifactPath: string,
    content: string,
    options: ReviewArtifactLockOptions = {}
): ReviewArtifactWriteResult {
    const { result } = withReviewArtifactTransactionLock(path.dirname(artifactPath), () => (
        writeReviewArtifactTextUnlocked(artifactPath, content, options)
    ), options);
    return result;
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

function restoreReviewArtifactFromRollbackStateUnlocked(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState,
    options: ReviewArtifactLockOptions & { ensureTrailingNewline?: boolean } = {}
): void {
    withReviewArtifactLock(artifactPath, () => {
        if (!rollbackState.existed) {
            if (fs.existsSync(artifactPath)) {
                fs.rmSync(artifactPath, { force: true });
            }
            return;
        }
        const content = rollbackState.content || '';
        writeArtifactFileAtomically(
            artifactPath,
            options.ensureTrailingNewline && !content.endsWith('\n') ? `${content}\n` : content
        );
    }, options);
}

function getReviewArtifactTransactionEntryContent(entry: ReviewArtifactTransactionalWrite): string {
    if (entry.contentType === 'json') {
        return `${JSON.stringify(entry.payload, null, 2)}\n`;
    }
    return entry.content;
}

function createReviewArtifactTransactionStagingDir(reviewsDir: string): string {
    fs.mkdirSync(reviewsDir, { recursive: true });
    return fs.mkdtempSync(path.join(reviewsDir, '.transaction-'));
}

function writeReviewArtifactTransactionEntryToStaging(
    entry: ReviewArtifactTransactionalWrite,
    stagingDir: string,
    index: number
): string {
    const stagedPath = path.join(stagingDir, `${String(index).padStart(4, '0')}-${path.basename(entry.artifactPath)}`);
    writeArtifactFileAtomically(stagedPath, getReviewArtifactTransactionEntryContent(entry));
    return stagedPath;
}

function commitStagedReviewArtifactTransactionEntry(
    entry: ReviewArtifactTransactionalWrite,
    stagedPath: string
): void {
    const content = fs.readFileSync(stagedPath, 'utf8');
    writeReviewArtifactTextUnlocked(entry.artifactPath, content, {
        ...entry.options,
        requireIndexUpdate: false
    }, false);
}

function assertTransactionIndexPersisted(reviewsDir: string, phase: string): void {
    const result = rebuildAndPersistIndex(reviewsDir);
    if (result.status === 'failed') {
        throw new Error(`Review artifact transaction index ${phase} failed: ${result.error || 'unknown error'}`);
    }
}

function resolveSingleTransactionReviewsDir(writes: readonly ReviewArtifactTransactionalWrite[]): string {
    const reviewsDir = path.dirname(writes[0].artifactPath);
    for (const entry of writes) {
        if (path.dirname(entry.artifactPath) !== reviewsDir) {
            throw new Error('Review artifact transaction writes must target one reviews directory.');
        }
    }
    return reviewsDir;
}

export async function writeReviewArtifactsWithRollback<T>(
    writes: readonly ReviewArtifactTransactionalWrite[],
    afterWrites: () => Promise<T>,
    options: ReviewArtifactLockOptions = {}
): Promise<T> {
    if (writes.length === 0) {
        return await afterWrites();
    }
    const reviewsDir = resolveSingleTransactionReviewsDir(writes);
    const { result } = await withReviewArtifactTransactionLockAsync(reviewsDir, async () => {
        const rollbackStates = writes.map((entry) => ({
            artifactPath: entry.artifactPath,
            rollbackState: captureReviewArtifactRollbackState(entry.artifactPath),
            options: entry.options
        }));
        const stagingDir = createReviewArtifactTransactionStagingDir(reviewsDir);
        try {
            const stagedWrites = writes.map((entry, index) => ({
                entry,
                stagedPath: writeReviewArtifactTransactionEntryToStaging(entry, stagingDir, index)
            }));
            for (const stagedWrite of stagedWrites) {
                commitStagedReviewArtifactTransactionEntry(stagedWrite.entry, stagedWrite.stagedPath);
            }
            const afterWritesResult = await afterWrites();
            assertTransactionIndexPersisted(reviewsDir, 'commit');
            return afterWritesResult;
        } catch (error: unknown) {
            try {
                for (let index = rollbackStates.length - 1; index >= 0; index -= 1) {
                    const entry = rollbackStates[index];
                    restoreReviewArtifactFromRollbackStateUnlocked(entry.artifactPath, entry.rollbackState, entry.options);
                }
                assertTransactionIndexPersisted(reviewsDir, 'rollback');
            } catch {
                // Preserve the original write or post-write failure.
            }
            throw error;
        } finally {
            fs.rmSync(stagingDir, { recursive: true, force: true });
        }
    }, options);
    return result;
}
