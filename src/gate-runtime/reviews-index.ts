import * as fs from 'node:fs';
import * as path from 'node:path';
import { withFilesystemLock } from './task-events-locking';

// ---------------------------------------------------------------------------
// Reviews Index — bounded metadata cache for runtime/reviews artifacts
// ---------------------------------------------------------------------------
//
// Avoids full `readdirSync` scans growing linearly with historical
// handshake/task-mode artifacts. The index is a JSON file that stores
// per-artifact metadata (task id, artifact type, mtime, size) and is
// refreshed only when the directory mtime changes or when the index
// itself is stale.
// ---------------------------------------------------------------------------

const INDEX_FILE_NAME = 'reviews-index.json';
const DEFAULT_INDEX_LOCK_TIMEOUT_MS = 1000;
const DEFAULT_INDEX_LOCK_RETRY_MS = 25;
const DEFAULT_INDEX_LOCK_STALE_MS = 30 * 1000;

// Known artifact type suffixes used to split task-id from artifact-type.
// Ordered longest-first so greedy suffix matching selects the right boundary.
const KNOWN_SUFFIXES: readonly string[] = Object.freeze([
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

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

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
 * - the reviews directory mtime changed (files added/removed)
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
    if (currentDirSnapshot.mtimeMs !== cached.directoryMtimeMs) return true;
    if (typeof cached.directoryCtimeMs === 'number' && currentDirSnapshot.ctimeMs !== cached.directoryCtimeMs) return true;
    if (typeof cached.directoryEntryCount === 'number' && getDirectoryEntryCount(reviewsDir) !== cached.directoryEntryCount) return true;

    if (Date.now() - cached.generatedAtMs > maxStalenessMs) return true;

    return false;
}

// ---------------------------------------------------------------------------
// Rebuild
// ---------------------------------------------------------------------------

function parseArtifactType(fileName: string): { taskId: string; artifactType: string } | null {
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
        const parsed = parseArtifactType(fileName);
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
 * After the rename, re-snapshots the directory mtime so the
 * stored value reflects the write itself (the rename changes
 * the directory mtime on most filesystems).
 */
export function writeIndex(indexPath: string, index: ReviewsIndex): void {
    const dir = path.dirname(indexPath);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = `${indexPath}.tmp-${process.pid}-${Date.now()}`;
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, indexPath);
        // The rename changed the directory mtime. Re-snapshot and
        // overwrite in-place so the stored mtime matches the current state.
        // An in-place write is used (not temp+rename) because overwriting
        // an existing file does not change the directory mtime.
        const currentDirSnapshot = getDirectoryTimestampSnapshot(dir);
        if (
            currentDirSnapshot.mtimeMs !== index.directoryMtimeMs
            || currentDirSnapshot.ctimeMs !== index.directoryCtimeMs
        ) {
            index.directoryMtimeMs = currentDirSnapshot.mtimeMs;
            index.directoryCtimeMs = currentDirSnapshot.ctimeMs;
            index.directoryEntryCount = getDirectoryEntryCount(dir);
            fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
        }
    } catch (error: unknown) {
        try { fs.rmSync(tmpPath, { force: true }); } catch { /* best-effort */ }
        throw error;
    }
}

// ---------------------------------------------------------------------------
// Load (cache-first with rebuild-on-stale)
// ---------------------------------------------------------------------------

export function resolveIndexPath(reviewsDir: string): string {
    return path.join(reviewsDir, INDEX_FILE_NAME);
}

export function resolveIndexLockPath(reviewsDir: string): string {
    return path.join(path.dirname(reviewsDir), '.reviews-index.lock');
}

function withIndexUpdateLock<T>(reviewsDir: string, callback: () => T): T {
    const { result } = withFilesystemLock(resolveIndexLockPath(reviewsDir), {
        timeoutMs: DEFAULT_INDEX_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_INDEX_LOCK_RETRY_MS,
        staleMs: DEFAULT_INDEX_LOCK_STALE_MS
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
    const indexPath = resolveIndexPath(reviewsDir);

    if (!options.forceRebuild && !isIndexStale(indexPath, reviewsDir, options.maxStalenessMs)) {
        const cached = readIndexFile(indexPath);
        if (cached) {
            return { index: cached, source: 'cache' };
        }
    }

    if (options.readOnly) {
        return { index: rebuildIndex(reviewsDir), source: 'rebuilt' };
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
}

// ---------------------------------------------------------------------------
// Incremental upsert — used after writing a single artifact
// ---------------------------------------------------------------------------

/**
 * Add or update a single entry in the index without a full rebuild.
 * If the index doesn't exist or is corrupt, a full rebuild is triggered.
 */
export function upsertEntry(reviewsDir: string, fileName: string): void {
    const parsed = parseArtifactType(fileName);
    if (!parsed) return;

    const indexPath = resolveIndexPath(reviewsDir);
    withIndexUpdateLock(reviewsDir, () => {
        const fullPath = path.join(reviewsDir, fileName);
        let stat: fs.Stats;
        try {
            stat = fs.statSync(fullPath);
            if (!stat.isFile()) return;
        } catch {
            return;
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

            const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
            index.directoryMtimeMs = dirSnapshot.mtimeMs;
            index.directoryCtimeMs = dirSnapshot.ctimeMs;
            index.directoryEntryCount = getDirectoryEntryCount(reviewsDir);
            index.generatedAtMs = Date.now();
        }

        try {
            writeIndex(indexPath, index);
        } catch {
            // Non-fatal
        }
    });
}

// ---------------------------------------------------------------------------
// Removal — used after cleanup deletes artifacts
// ---------------------------------------------------------------------------

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

        const dirSnapshot = getDirectoryTimestampSnapshot(reviewsDir);
        index.directoryMtimeMs = dirSnapshot.mtimeMs;
        index.directoryCtimeMs = dirSnapshot.ctimeMs;
        index.directoryEntryCount = getDirectoryEntryCount(reviewsDir);
        index.generatedAtMs = Date.now();

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

// ---------------------------------------------------------------------------
// Query helpers — operate on a loaded index without filesystem access
// ---------------------------------------------------------------------------

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
