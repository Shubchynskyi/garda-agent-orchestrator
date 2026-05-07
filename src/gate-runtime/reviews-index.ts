import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import { inspectFilesystemLock, withFilesystemLock } from './task-events-locking';

// Bounded metadata cache for runtime/reviews artifacts.
// Avoids full readdirSync scans growing linearly with historical
// handshake/task-mode artifacts; refreshed when the directory mtime
// changes or when the index is stale.

const INDEX_FILE_NAME = 'reviews-index.json';
const DEFAULT_INDEX_LOCK_TIMEOUT_MS = 5000;
const DEFAULT_INDEX_LOCK_RETRY_MS = 25;
const DEFAULT_INDEX_LOCK_STALE_MS = 30 * 1000;
const SELF_WRITE_MARKER_TOLERANCE_MS = 0.01;
const inProcessReviewTransactionSnapshots = new Map<string, { depth: number; index: ReviewsIndex }>();

// Known artifact type suffixes used to split task-id from artifact-type.
// Ordered longest-first so greedy suffix matching selects the right boundary.
export const KNOWN_SUFFIXES: readonly string[] = Object.freeze([
    '-dependency-review-context.json',
    '-performance-review-context.json',
    '-security-review-context.json',
    '-refactor-review-context.json',
    '-infra-review-context.json',
    '-code-review-context.json',
    '-test-review-context.json',
    '-api-review-context.json',
    '-db-review-context.json',
    '-dependency-receipt.json',
    '-performance-receipt.json',
    '-security-receipt.json',
    '-refactor-receipt.json',
    '-command-timeout.json',
    '-completion-gate.json',
    '-infra-receipt.json',
    '-code-receipt.json',
    '-test-receipt.json',
    '-compile-output.log',
    '-compile-gate.json',
    '-api-receipt.json',
    '-db-receipt.json',
    '-review-gate.json',
    '-shell-smoke.json',
    '-doc-impact.json',
    '-task-mode.json',
    '-handshake.json',
    '-preflight.json',
    '-rule-pack.json',
    '-code-scoped.diff',
    '-dependency.md',
    '-performance.md',
    '-no-op.json',
    '-security.md',
    '-refactor.md',
    '-infra.md',
    '-code.md',
    '-test.md',
    '-api.md',
    '-db.md'
]);

export interface ReviewsIndexEntry {
    fileName: string;
    taskId: string;
    artifactType: string;
    mtimeMs: number;
    sizeBytes: number;
}

export interface ReviewsIndex {
    version: 1;
    directoryMtimeMs: number;
    directoryCtimeMs?: number;
    directoryEntryCount?: number;
    generatedAtMs: number;
    entries: ReviewsIndexEntry[];
}

export interface ReviewsIndexLoadResult {
    index: ReviewsIndex;
    source: 'cache' | 'rebuilt';
}

export type ReviewsIndexMutationStatus =
    | 'updated'
    | 'skipped_unparseable_name'
    | 'skipped_missing_artifact'
    | 'failed';

export interface ReviewsIndexMutationResult {
    status: ReviewsIndexMutationStatus;
    index_path: string;
    file_name?: string;
    error?: string;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function cloneReviewsIndex(index: ReviewsIndex): ReviewsIndex {
    return {
        version: index.version,
        directoryMtimeMs: index.directoryMtimeMs,
        ...(typeof index.directoryCtimeMs === 'number' ? { directoryCtimeMs: index.directoryCtimeMs } : {}),
        ...(typeof index.directoryEntryCount === 'number' ? { directoryEntryCount: index.directoryEntryCount } : {}),
        generatedAtMs: index.generatedAtMs,
        entries: index.entries.map((entry) => ({ ...entry }))
    };
}

function getDirectoryTimestampSnapshot(dirPath: string): { mtimeMs: number; ctimeMs: number } {
    try {
        const stat = fs.statSync(dirPath);
        return {
            mtimeMs: stat.mtimeMs,
            ctimeMs: stat.ctimeMs
        };
    } catch {
        return {
            mtimeMs: 0,
            ctimeMs: 0
        };
    }
}

function getDirectoryEntryCount(dirPath: string): number {
    try {
        return fs.readdirSync(dirPath).filter((entryName) => (
            entryName !== INDEX_FILE_NAME
            && !entryName.endsWith('.lock')
        )).length;
    } catch {
        return 0;
    }
}

function refreshIndexDirectoryMetadata(index: ReviewsIndex, reviewsDir: string): void {
    const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
    index.directoryMtimeMs = dirSnapshot.mtimeMs;
    index.directoryCtimeMs = dirSnapshot.ctimeMs;
    index.directoryEntryCount = getDirectoryEntryCount(reviewsDir);
    index.generatedAtMs = Date.now();
}

function timestampsMatchSelfWriteMarker(leftMs: number, rightMs: number): boolean {
    return Math.abs(leftMs - rightMs) <= SELF_WRITE_MARKER_TOLERANCE_MS;
}

function markIndexFileAsDirectorySelfWrite(indexPath: string, reviewsDir: string): void {
    try {
        const directorySnapshot = getDirectoryTimestampSnapshot(reviewsDir);
        const markerSeconds = directorySnapshot.mtimeMs / 1000;
        fs.utimesSync(indexPath, markerSeconds, markerSeconds);
    } catch {
        // Best-effort marker; a missed marker only causes a rebuild.
    }
}

function isDirectoryChangeFromIndexWrite(
    indexPath: string,
    reviewsDir: string,
    cached: ReviewsIndex,
    currentDirSnapshot: { mtimeMs: number; ctimeMs: number }
): boolean {
    if (
        typeof cached.directoryEntryCount === 'number'
        && getDirectoryEntryCount(reviewsDir) !== cached.directoryEntryCount
    ) {
        return false;
    }

    try {
        const indexStat = fs.statSync(indexPath);
        if (!indexStat.isFile()) {
            return false;
        }
        return (
            currentDirSnapshot.mtimeMs >= cached.directoryMtimeMs
            && timestampsMatchSelfWriteMarker(indexStat.mtimeMs, currentDirSnapshot.mtimeMs)
        );
    } catch {
        return false;
    }
}

function readIndexFile(indexPath: string): ReviewsIndex | null {
    try {
        if (!fs.existsSync(indexPath)) return null;
        const raw = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
        if (raw && raw.version === 1 && Array.isArray(raw.entries)) {
            return raw as ReviewsIndex;
        }
        return null;
    } catch {
        return null;
    }
}

/**
 * Determine whether the cached index is still valid.
 *
 * The index is stale when:
 * - it doesn't exist or is unreadable
 * - the reviews directory mtime changed for a reason other than our own index rewrite
 * - the index is older than `maxStalenessMs` (guard against mtime quirks)
 */
export function isIndexStale(
    indexPath: string,
    reviewsDir: string,
    maxStalenessMs: number = 60_000
): boolean {
    const cached = readIndexFile(indexPath);
    if (!cached) return true;

    const currentDirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
    if (currentDirSnapshot.mtimeMs !== cached.directoryMtimeMs) {
        if (!isDirectoryChangeFromIndexWrite(indexPath, reviewsDir, cached, currentDirSnapshot)) {
            return true;
        }
    }
    if (
        typeof cached.directoryCtimeMs === 'number'
        && currentDirSnapshot.ctimeMs !== cached.directoryCtimeMs
        && !isDirectoryChangeFromIndexWrite(indexPath, reviewsDir, cached, currentDirSnapshot)
    ) {
        return true;
    }
    if (typeof cached.directoryEntryCount === 'number' && getDirectoryEntryCount(reviewsDir) !== cached.directoryEntryCount) return true;

    if (Date.now() - cached.generatedAtMs > maxStalenessMs) return true;

    return false;
}

export function parseReviewArtifactFileName(fileName: string): { taskId: string; artifactType: string } | null {
    if (!fileName.startsWith('T-')) return null;

    // Try known suffixes first for deterministic parsing
    for (const suffix of KNOWN_SUFFIXES) {
        if (fileName.endsWith(suffix)) {
            const taskId = fileName.slice(0, fileName.length - suffix.length);
            if (taskId.length > 2) {
                return { taskId, artifactType: suffix.slice(1) };
            }
        }
        // Also match compressed variants (e.g. T-001-preflight.json.gz)
        const gzSuffix = `${suffix}.gz`;
        if (fileName.endsWith(gzSuffix)) {
            const taskId = fileName.slice(0, fileName.length - gzSuffix.length);
            if (taskId.length > 2) {
                return { taskId, artifactType: gzSuffix.slice(1) };
            }
        }
    }

    // Fallback for simple task IDs (T-NNN-artifactType): split at
    // second `-` after the `T-` prefix. Only reliable for `T-\d+-`
    // formatted IDs; multi-segment IDs need a known suffix above.
    const match = /^(T-\d+)-(.+)$/.exec(fileName);
    if (match) {
        return { taskId: match[1], artifactType: match[2] };
    }

    return null;
}

/**
 * Perform a full directory scan and build a fresh index.
 */
export function rebuildIndex(reviewsDir: string): ReviewsIndex {
    const entries: ReviewsIndexEntry[] = [];
    const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
    const dirEntryCount = getDirectoryEntryCount(reviewsDir);

    let fileNames: string[];
    try {
        fileNames = fs.readdirSync(reviewsDir);
    } catch {
        return {
            version: 1,
            directoryMtimeMs: dirSnapshot.mtimeMs,
            directoryCtimeMs: dirSnapshot.ctimeMs,
            directoryEntryCount: dirEntryCount,
            generatedAtMs: Date.now(),
            entries
        };
    }

    for (const fileName of fileNames) {
        const parsed = parseReviewArtifactFileName(fileName);
        if (!parsed) continue;

        const fullPath = path.join(reviewsDir, fileName);
        try {
            const stat = fs.statSync(fullPath);
            if (!stat.isFile()) continue;
            entries.push({
                fileName,
                taskId: parsed.taskId,
                artifactType: parsed.artifactType,
                mtimeMs: stat.mtimeMs,
                sizeBytes: stat.size
            });
        } catch {
            // Skip unreadable files
        }
    }

    return {
        version: 1,
        directoryMtimeMs: dirSnapshot.mtimeMs,
        directoryCtimeMs: dirSnapshot.ctimeMs,
        directoryEntryCount: dirEntryCount,
        generatedAtMs: Date.now(),
        entries
    };
}

/**
 * Write the index atomically to avoid partial reads.
 */
export function writeIndex(indexPath: string, index: ReviewsIndex): void {
    const dir = path.dirname(indexPath);
    writeFileAtomically(indexPath, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', fsync: false });
    markIndexFileAsDirectorySelfWrite(indexPath, dir);
}

export function resolveIndexPath(reviewsDir: string): string {
    return path.join(reviewsDir, INDEX_FILE_NAME);
}

export function resolveIndexLockPath(reviewsDir: string): string {
    return path.join(path.dirname(reviewsDir), '.reviews-index.lock');
}

export function resolveReviewTransactionLockPath(reviewsDir: string): string {
    return path.join(path.dirname(reviewsDir), '.reviews-transaction.lock');
}

export function beginInProcessReviewTransactionSnapshot(reviewsDir: string): () => void {
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    const existing = inProcessReviewTransactionSnapshots.get(lockPath);
    if (existing) {
        existing.depth += 1;
        return () => {
            const current = inProcessReviewTransactionSnapshots.get(lockPath);
            if (!current) return;
            current.depth -= 1;
            if (current.depth <= 0) {
                inProcessReviewTransactionSnapshots.delete(lockPath);
            }
        };
    }

    inProcessReviewTransactionSnapshots.set(lockPath, {
        depth: 1,
        index: rebuildIndex(reviewsDir)
    });
    return () => {
        const current = inProcessReviewTransactionSnapshots.get(lockPath);
        if (!current) return;
        current.depth -= 1;
        if (current.depth <= 0) {
            inProcessReviewTransactionSnapshots.delete(lockPath);
        }
    };
}

function getInProcessReviewTransactionSnapshot(reviewsDir: string): ReviewsIndex | null {
    const snapshot = inProcessReviewTransactionSnapshots.get(resolveReviewTransactionLockPath(reviewsDir));
    return snapshot ? cloneReviewsIndex(snapshot.index) : null;
}

export function currentProcessOwnsReviewTransactionLock(reviewsDir: string): boolean {
    const inspection = inspectFilesystemLock(resolveReviewTransactionLockPath(reviewsDir), {
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS
    });
    return inspection.exists
        && inspection.metadata.pid === process.pid
        && inspection.ownerHostMatchesCurrent !== false
        && inspection.ownerAlive !== false;
}

function withIndexUpdateLock<T>(reviewsDir: string, callback: () => T): T {
    const { result } = withFilesystemLock(resolveIndexLockPath(reviewsDir), {
        timeoutMs: DEFAULT_INDEX_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_INDEX_LOCK_RETRY_MS,
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS,
        ownerLabel: 'reviews-index'
    }, callback);
    return result;
}

function withReviewTransactionReadBarrier<T>(
    reviewsDir: string,
    callback: () => T,
    options: { readOnly?: boolean } = {}
): T {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        return callback();
    }
    const lockPath = resolveReviewTransactionLockPath(reviewsDir);
    if (options.readOnly && !fs.existsSync(lockPath)) {
        return callback();
    }
    const { result } = withFilesystemLock(resolveReviewTransactionLockPath(reviewsDir), {
        timeoutMs: DEFAULT_INDEX_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_INDEX_LOCK_RETRY_MS,
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS,
        ownerLabel: 'reviews-index-read-barrier'
    }, callback);
    return result;
}

/**
 * Load the reviews index, rebuilding from disk only when stale.
 *
 * Returns the index and whether it came from cache or was rebuilt.
 * The caller can use `source === 'rebuilt'` to know a full scan was done.
 */
export function loadIndex(
    reviewsDir: string,
    options: { maxStalenessMs?: number; forceRebuild?: boolean; readOnly?: boolean } = {}
): ReviewsIndexLoadResult {
    if (currentProcessOwnsReviewTransactionLock(reviewsDir)) {
        const transactionSnapshot = getInProcessReviewTransactionSnapshot(reviewsDir);
        if (transactionSnapshot) {
            return {
                index: transactionSnapshot,
                source: 'cache'
            };
        }
    }

    return withReviewTransactionReadBarrier(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);

        if (!options.forceRebuild && !isIndexStale(indexPath, reviewsDir, options.maxStalenessMs)) {
            const cached = readIndexFile(indexPath);
            if (cached) {
                return { index: cached, source: 'cache' };
            }
        }

        if (options.readOnly) {
            return {
                index: rebuildIndex(reviewsDir),
                source: 'rebuilt' as const
            };
        }

        return withIndexUpdateLock(reviewsDir, () => {
            if (!options.forceRebuild && !isIndexStale(indexPath, reviewsDir, options.maxStalenessMs)) {
                const cached = readIndexFile(indexPath);
                if (cached) {
                    return { index: cached, source: 'cache' as const };
                }
            }

            const index = rebuildIndex(reviewsDir);
            try {
                writeIndex(indexPath, index);
            } catch {
                // Non-fatal: return the fresh index even if we can't persist it
            }
            return { index, source: 'rebuilt' as const };
        });
    }, { readOnly: options.readOnly === true });
}

export function rebuildAndPersistIndex(reviewsDir: string): ReviewsIndexMutationResult {
    const indexPath = resolveIndexPath(reviewsDir);
    try {
        return withIndexUpdateLock(reviewsDir, () => {
            const index = rebuildIndex(reviewsDir);
            writeIndex(indexPath, index);
            return {
                status: 'updated' as const,
                index_path: indexPath
            };
        });
    } catch (error: unknown) {
        return {
            status: 'failed',
            index_path: indexPath,
            error: getErrorMessage(error)
        };
    }
}

/**
 * Add or update a single entry in the index without a full rebuild.
 * If the index doesn't exist or is corrupt, a full rebuild is triggered.
 */
export function upsertEntry(reviewsDir: string, fileName: string): ReviewsIndexMutationResult {
    const indexPath = resolveIndexPath(reviewsDir);
    const parsed = parseReviewArtifactFileName(fileName);
    if (!parsed) {
        return {
            status: 'skipped_unparseable_name',
            index_path: indexPath,
            file_name: fileName
        };
    }

    try {
        return withIndexUpdateLock(reviewsDir, () => {
            const fullPath = path.join(reviewsDir, fileName);
            let stat: fs.Stats;
            try {
                stat = fs.statSync(fullPath);
                if (!stat.isFile()) {
                    return {
                        status: 'skipped_missing_artifact' as const,
                        index_path: indexPath,
                        file_name: fileName
                    };
                }
            } catch {
                return {
                    status: 'skipped_missing_artifact' as const,
                    index_path: indexPath,
                    file_name: fileName
                };
            }

            let index = readIndexFile(indexPath);

            if (!index) {
                index = rebuildIndex(reviewsDir);
            } else {
                const existingIdx = index.entries.findIndex(e => e.fileName === fileName);
                const entry: ReviewsIndexEntry = {
                    fileName,
                    taskId: parsed.taskId,
                    artifactType: parsed.artifactType,
                    mtimeMs: stat.mtimeMs,
                    sizeBytes: stat.size
                };

                if (existingIdx >= 0) {
                    index.entries[existingIdx] = entry;
                } else {
                    index.entries.push(entry);
                }

                refreshIndexDirectoryMetadata(index, reviewsDir);
            }

            writeIndex(indexPath, index);
            return {
                status: 'updated' as const,
                index_path: indexPath,
                file_name: fileName
            };
        });
    } catch (error: unknown) {
        return {
            status: 'failed',
            index_path: indexPath,
            file_name: fileName,
            error: getErrorMessage(error)
        };
    }
}

/**
 * Remove entries for the given file names from the index.
 * If none of the names are in the index, this is a no-op.
 */
export function removeEntries(reviewsDir: string, fileNames: string[]): void {
    if (fileNames.length === 0) return;

    withIndexUpdateLock(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);
        const index = readIndexFile(indexPath);
        if (!index) return;

        const removeSet = new Set(fileNames);
        const originalLength = index.entries.length;
        index.entries = index.entries.filter(e => !removeSet.has(e.fileName));

        if (index.entries.length === originalLength) return;

        refreshIndexDirectoryMetadata(index, reviewsDir);

        try {
            writeIndex(indexPath, index);
        } catch {
            // Non-fatal
        }
    });
}

/**
 * Invalidate (delete) the index file, forcing a full rebuild on next load.
 */
export function invalidateIndex(reviewsDir: string): void {
    withIndexUpdateLock(reviewsDir, () => {
        const indexPath = resolveIndexPath(reviewsDir);
        try {
            fs.rmSync(indexPath, { force: true });
        } catch {
            // Non-fatal
        }
    });
}

/**
 * Get all entries for a specific task id.
 */
export function entriesForTask(index: ReviewsIndex, taskId: string): ReviewsIndexEntry[] {
    return index.entries.filter(e => e.taskId === taskId);
}

/**
 * Get all entries matching a specific artifact type suffix (e.g. 'handshake.json').
 */
export function entriesByArtifactSuffix(
    index: ReviewsIndex,
    suffix: string
): ReviewsIndexEntry[] {
    return index.entries.filter(e => e.artifactType.endsWith(suffix));
}

/**
 * Get unique task IDs present in the index.
 */
export function taskIds(index: ReviewsIndex): string[] {
    return [...new Set(index.entries.map(e => e.taskId))];
}

/**
 * Group entries by task id.
 */
export function groupByTask(index: ReviewsIndex): Map<string, ReviewsIndexEntry[]> {
    const groups = new Map<string, ReviewsIndexEntry[]>();
    for (const entry of index.entries) {
        const group = groups.get(entry.taskId) || [];
        group.push(entry);
        groups.set(entry.taskId, group);
    }
    return groups;
}
