import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, normalizePath, joinOrchestratorPath } from './helpers';

const CACHE_VERSION = 1;

/**
 * Per-file metadata entry used to decide whether a cached SHA-256 is still current.
 * Staleness is determined by comparing exact mtimeMs and byte size.
 */
export interface ProtectedHashCacheEntry {
    size: number;
    mtime_ms: number;
    sha256: string;
}

/**
 * Persisted hash cache for protected control-plane files.
 * Keyed by normalized relative path (POSIX forward-slash style).
 */
export interface ProtectedHashCache {
    cache_version: number;
    entries: Record<string, ProtectedHashCacheEntry>;
}

/**
 * Resolve the persisted protected hash cache path inside the runtime directory.
 */
export function resolveProtectedHashCachePath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'protected-hash-cache.json'));
}

/**
 * Read the persisted hash cache from disk.
 * Returns null if the file is missing, unreadable, or has an incompatible schema.
 */
export function readProtectedHashCache(cachePath: string): ProtectedHashCache | null {
    try {
        const resolved = path.resolve(cachePath);
        if (!fs.existsSync(resolved)) return null;
        const raw = fs.readFileSync(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.cache_version !== CACHE_VERSION) return null;
        if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return null;
        const entries = parsed.entries as Record<string, unknown>;
        for (const key of Object.keys(entries)) {
            const entry = entries[key];
            if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
            const record = entry as Record<string, unknown>;
            if (typeof record.size !== 'number') return null;
            if (typeof record.mtime_ms !== 'number') return null;
            if (typeof record.sha256 !== 'string') return null;
        }
        return parsed as unknown as ProtectedHashCache;
    } catch {
        return null;
    }
}

/**
 * Write the hash cache to disk atomically (write-rename).
 */
export function writeProtectedHashCache(cachePath: string, cache: ProtectedHashCache): void {
    const resolved = path.resolve(cachePath);
    const dir = path.dirname(resolved);
    fs.mkdirSync(dir, { recursive: true });
    const tmpPath = resolved + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify(cache, null, 2) + '\n', 'utf8');
    fs.renameSync(tmpPath, resolved);
}

/**
 * Check whether a cached entry is still current for the given file.
 * Returns the cached sha256 if mtime and size match, null otherwise.
 */
export function getCachedHashIfCurrent(
    entry: ProtectedHashCacheEntry,
    fullPath: string
): string | null {
    try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) return null;
        if (stat.size !== entry.size) return null;
        if (stat.mtimeMs !== entry.mtime_ms) return null;
        return entry.sha256;
    } catch {
        return null;
    }
}

/**
 * Compute the SHA-256 hash of a single protected file, leveraging the cache
 * when the file's metadata (mtime, size) matches the cached entry.
 *
 * When a cache miss occurs the hash is computed from disk and the cache
 * entry is updated in-place for later persistence.
 *
 * Returns the hash string, or '<error>' if the file cannot be read.
 */
export function hashFileWithCache(
    fullPath: string,
    relPath: string,
    cache: ProtectedHashCache
): string {
    const existing = cache.entries[relPath];
    if (existing) {
        const cached = getCachedHashIfCurrent(existing, fullPath);
        if (cached) return cached;
    }

    // Cache miss — compute from disk
    try {
        const stat = fs.statSync(fullPath);
        if (!stat.isFile()) return '<error>';
        const hash = fileSha256(fullPath);
        if (!hash) return '<error>';

        cache.entries[relPath] = {
            size: stat.size,
            mtime_ms: stat.mtimeMs,
            sha256: hash
        };
        return hash;
    } catch {
        return '<error>';
    }
}

/**
 * Scan protected roots with incremental hashing.
 *
 * Drop-in replacement for the original `scanProtectedPathHashes()`:
 * returns a map of relative-path → SHA-256 for every file under the
 * given protected roots.  Unchanged files (same mtime + size as the
 * previous scan) reuse the cached hash instead of re-reading the
 * file contents.  Edge-case difference: files that exist but cannot
 * be read appear as `'<error>'` in the result map rather than being
 * silently omitted (the original omitted them because `fileSha256`
 * returned `null` and the outer catch was unreachable).  This makes
 * drift detection slightly more conservative.
 *
 * The cache is loaded from disk at the start, updated in-place during
 * the scan, pruned of stale entries (files that no longer appear in
 * the scan), and persisted atomically at the end.
 *
 * Fallback: if the cache is missing, corrupt, or unreadable, the scan
 * proceeds from scratch — correctness is never sacrificed.
 */
export function scanProtectedPathHashesIncremental(
    repoRoot: string,
    protectedRoots: string[],
    readOnly: boolean = false
): Record<string, string> {
    const cachePath = resolveProtectedHashCachePath(repoRoot);
    const cache = readProtectedHashCache(cachePath) || { cache_version: CACHE_VERSION, entries: {} };
    const results: Record<string, string> = {};

    const scan = (currentDir: string) => {
        let entries: fs.Dirent[];
        try {
            entries = fs.readdirSync(currentDir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const entry of entries) {
            const fullPath = path.join(currentDir, entry.name);
            const relPath = normalizePath(path.relative(repoRoot, fullPath));

            if (entry.isDirectory()) {
                scan(fullPath);
            } else if (entry.isFile()) {
                results[relPath] = hashFileWithCache(fullPath, relPath, cache);
            }
        }
    };

    for (const root of protectedRoots) {
        const normalizedRoot = normalizePath(root).replace(/\/$/, '');
        if (!normalizedRoot) continue;
        const fullRoot = path.resolve(repoRoot, normalizedRoot);
        if (!fs.existsSync(fullRoot)) continue;

        try {
            const stat = fs.statSync(fullRoot);
            if (stat.isDirectory()) {
                scan(fullRoot);
            } else if (stat.isFile()) {
                const relPath = normalizePath(path.relative(repoRoot, fullRoot));
                results[relPath] = hashFileWithCache(fullRoot, relPath, cache);
            }
        } catch {
            // Non-stattable root — skip gracefully
        }
    }

    // Prune cache entries that are no longer in the scan results
    const scannedPaths = new Set(Object.keys(results));
    for (const cachedPath of Object.keys(cache.entries)) {
        if (!scannedPaths.has(cachedPath)) {
            delete cache.entries[cachedPath];
        }
    }

    // Persist updated cache when allowed; failure is non-fatal.
    // readOnly=true prevents writes so read-only commands (status, doctor) honour their contract.
    if (!readOnly) {
        try {
            writeProtectedHashCache(cachePath, cache);
        } catch {
            // Cache write failure is non-fatal; next scan will recompute
        }
    }

    return results;
}
