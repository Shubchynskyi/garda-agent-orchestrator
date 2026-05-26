import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import { normalizePath, joinOrchestratorPath } from './path-utils';
import { fileSha256, stringSha256 } from './hashing-metrics';

const CACHE_VERSION = 1;

export interface ProtectedHashScanOptions {
    /** Read existing cache but do not persist updates. */
    readOnly?: boolean;
    /** Bypass cache hits and hash from the current filesystem state. */
    noCache?: boolean;
}

/**
 * Per-file metadata entry used to decide whether a cached SHA-256 is still current.
 * Staleness is determined by comparing exact mtimeMs and byte size.
 */
export interface ProtectedHashCacheEntry {
    size: number;
    mtime_ms: number;
    sha256: string;
    path_type?: 'file' | 'symlink';
    link_target?: string;
    target_status?: 'file' | 'directory' | 'special' | 'broken' | 'outside_repo';
    target_path?: string | null;
    target_size?: number | null;
    target_mtime_ms?: number | null;
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
    writeFileAtomically(resolved, JSON.stringify(cache, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

/**
 * Check whether a cached entry is still current for the given file.
 * Returns the cached sha256 if mtime and size match, null otherwise.
 */
export function getCachedHashIfCurrent(
    entry: ProtectedHashCacheEntry,
    fullPath: string,
    options: ProtectedHashScanOptions = {}
): string | null {
    if (options.noCache) return null;
    try {
        const stat = fs.lstatSync(fullPath);
        if (stat.size !== entry.size) return null;
        if (stat.mtimeMs !== entry.mtime_ms) return null;
        if (stat.isSymbolicLink()) {
            if (entry.path_type !== 'symlink') return null;
            if (normalizePath(fs.readlinkSync(fullPath)) !== normalizePath(entry.link_target || '')) return null;
            if (entry.target_status === 'file') {
                const targetStat = fs.statSync(fullPath);
                if (!targetStat.isFile()) return null;
                if (targetStat.size !== entry.target_size) return null;
                if (targetStat.mtimeMs !== entry.target_mtime_ms) return null;
            }
            return entry.sha256;
        }
        if (!stat.isFile()) return null;
        if (entry.path_type && entry.path_type !== 'file') return null;
        return entry.sha256;
    } catch {
        return null;
    }
}

function buildSymlinkHashPayload(fullPath: string, repoRoot: string | undefined): {
    hash: string;
    entry: Omit<ProtectedHashCacheEntry, 'sha256'>;
} {
    const stat = fs.lstatSync(fullPath);
    const linkTarget = fs.readlinkSync(fullPath);
    const entry: Omit<ProtectedHashCacheEntry, 'sha256'> = {
        size: stat.size,
        mtime_ms: stat.mtimeMs,
        path_type: 'symlink',
        link_target: normalizePath(linkTarget),
        target_status: 'broken',
        target_path: null,
        target_size: null,
        target_mtime_ms: null
    };
    const payload: Record<string, unknown> = {
        path_type: 'symlink',
        link_target: normalizePath(linkTarget),
        target_status: entry.target_status,
        target_path: null,
        target_sha256: null
    };

    try {
        const resolvedTargetPath = path.resolve(path.dirname(fullPath), linkTarget);
        const targetRealPath = fs.realpathSync(resolvedTargetPath);
        const repoRealPath = repoRoot ? fs.realpathSync(repoRoot) : null;
        const targetInsideRepo = repoRealPath
            ? normalizePath(path.relative(repoRealPath, targetRealPath)).split('/')[0] !== '..'
                && !path.isAbsolute(path.relative(repoRealPath, targetRealPath))
            : false;
        if (!targetInsideRepo) {
            entry.target_status = 'outside_repo';
            payload.target_status = entry.target_status;
            return {
                hash: stringSha256(JSON.stringify(payload)) || '<error>',
                entry
            };
        }

        const targetStat = fs.statSync(resolvedTargetPath);
        const targetPath = normalizePath(path.relative(repoRealPath || repoRoot || process.cwd(), targetRealPath));
        entry.target_path = targetPath || null;
        payload.target_path = entry.target_path;
        if (targetStat.isFile()) {
            const targetHash = fileSha256(targetRealPath);
            entry.target_status = 'file';
            entry.target_size = targetStat.size;
            entry.target_mtime_ms = targetStat.mtimeMs;
            payload.target_status = entry.target_status;
            payload.target_sha256 = targetHash || '<error>';
        } else if (targetStat.isDirectory()) {
            entry.target_status = 'directory';
            payload.target_status = entry.target_status;
        } else {
            entry.target_status = 'special';
            payload.target_status = entry.target_status;
        }
    } catch {
        entry.target_status = 'broken';
        payload.target_status = entry.target_status;
    }

    return {
        hash: stringSha256(JSON.stringify(payload)) || '<error>',
        entry
    };
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
    cache: ProtectedHashCache,
    options: ProtectedHashScanOptions & { repoRoot?: string } = {}
): string {
    const existing = cache.entries[relPath];
    if (existing) {
        const cached = getCachedHashIfCurrent(existing, fullPath, options);
        if (cached) return cached;
    }

    try {
        const stat = fs.lstatSync(fullPath);
        if (stat.isSymbolicLink()) {
            const symlinkPayload = buildSymlinkHashPayload(fullPath, options.repoRoot);
            cache.entries[relPath] = {
                ...symlinkPayload.entry,
                sha256: symlinkPayload.hash
            };
            return symlinkPayload.hash;
        }
        if (!stat.isFile()) return '<error>';
        const hash = fileSha256(fullPath);
        if (!hash) return '<error>';

        cache.entries[relPath] = {
            size: stat.size,
            mtime_ms: stat.mtimeMs,
            sha256: hash,
            path_type: 'file'
        };
        return hash;
    } catch {
        return '<error>';
    }
}

function coerceScanOptions(readOnlyOrOptions: boolean | ProtectedHashScanOptions | undefined): ProtectedHashScanOptions {
    if (typeof readOnlyOrOptions === 'boolean') {
        return { readOnly: readOnlyOrOptions };
    }
    return readOnlyOrOptions || {};
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
    readOnlyOrOptions: boolean | ProtectedHashScanOptions = false
): Record<string, string> {
    const options = coerceScanOptions(readOnlyOrOptions);
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
            } else if (entry.isFile() || entry.isSymbolicLink()) {
                results[relPath] = hashFileWithCache(fullPath, relPath, cache, { ...options, repoRoot });
            }
        }
    };

    for (const root of protectedRoots) {
        const normalizedRoot = normalizePath(root).replace(/\/$/, '');
        if (!normalizedRoot) continue;
        const fullRoot = path.resolve(repoRoot, normalizedRoot);
        if (!fs.existsSync(fullRoot)) continue;

        try {
            const stat = fs.lstatSync(fullRoot);
            if (stat.isDirectory()) {
                scan(fullRoot);
            } else if (stat.isFile() || stat.isSymbolicLink()) {
                const relPath = normalizePath(path.relative(repoRoot, fullRoot));
                results[relPath] = hashFileWithCache(fullRoot, relPath, cache, { ...options, repoRoot });
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
    if (!options.readOnly) {
        try {
            writeProtectedHashCache(cachePath, cache);
        } catch {
            // Cache write failure is non-fatal; next scan will recompute
        }
    }

    return results;
}
