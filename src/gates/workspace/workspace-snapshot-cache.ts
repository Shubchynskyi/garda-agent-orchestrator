import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../core/filesystem';
import { isPathRealpathInsideRoot, stringSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';
import { getWorkspaceSnapshot } from '../compile/compile-gate';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { getSafeWorktreePathState } from './worktree-path-state';

const CACHE_VERSION = 2;
const CACHE_RELATIVE_PATH = path.join('runtime', 'cache', 'workspace-snapshot.json');

export type WorkspaceSnapshot = ReturnType<typeof getWorkspaceSnapshot>;

export interface WorkspaceSnapshotCacheEntry {
    cache_version: number;
    fingerprint: string;
    snapshot: WorkspaceSnapshot;
    timestamp_utc: string;
    params: {
        repo_root: string;
        detection_source: string;
        include_untracked: boolean;
        explicit_changed_files_hash: string | null;
    };
    git_state: {
        head_sha: string | null;
        index_mtime_ms: number;
        index_size: number;
    };
}

export interface WorkspaceSnapshotCacheOptions {
    /** Disable cache entirely; always compute fresh. Default: false. */
    noCache?: boolean;
    /** Skip writing the cache file after a fresh computation. Default: false. */
    readOnly?: boolean;
}

/**
 * Read HEAD SHA cheaply via git rev-parse.
 * Returns null on any failure (no-commit repo, not a git repo, etc.).
 */
export function readHeadSha(repoRoot: string): string | null {
    try {
        const result = spawnSyncWithTimeout('git', ['-C', String(repoRoot), 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        if (result.status !== 0 || result.timedOut || result.error) return null;
        return String(result.stdout || '').trim() || null;
    } catch {
        return null;
    }
}

/**
 * Stat the git index file (.git/index) to detect staged-state changes.
 * Returns mtime (ms floor) and byte size.  Falls back to zeros on error.
 */
export function statGitIndex(repoRoot: string): { mtime_ms: number; size: number } {
    try {
        const gitDir = path.join(path.resolve(repoRoot), '.git');
        // Handle gitdir files (submodules, worktrees)
        let indexPath: string;
        const gitDirStat = fs.statSync(gitDir);
        if (gitDirStat.isFile()) {
            const content = fs.readFileSync(gitDir, 'utf8').trim();
            const match = content.match(/^gitdir:\s*(.+)$/);
            if (match) {
                indexPath = path.resolve(path.dirname(gitDir), match[1], 'index');
            } else {
                return { mtime_ms: 0, size: 0 };
            }
        } else {
            indexPath = path.join(gitDir, 'index');
        }
        const stat = fs.statSync(indexPath);
        return { mtime_ms: Math.floor(stat.mtimeMs), size: stat.size };
    } catch {
        return { mtime_ms: 0, size: 0 };
    }
}

/**
 * Compute the parameters component of the cache fingerprint.
 */
function computeParamsHash(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): string {
    const normalizedExplicit = [...new Set(
        (explicitChangedFiles || []).map((f: string) => normalizePath(f)).filter(Boolean)
    )].sort();
    const key = `${path.resolve(repoRoot)}|${detectionSource}|${includeUntracked}|${normalizedExplicit.join(',')}`;
    return stringSha256(key) || '';
}

/**
 * Read git porcelain status lines for the repo.
 * Throws on probe failure so cache fingerprinting never treats an unreadable
 * working tree as an empty working tree and reuses stale snapshots.
 */
function readGitStatusLines(repoRoot: string, includeUntracked: boolean): string[] {
    const args = [
        '-C',
        String(repoRoot),
        'status',
        '--porcelain=v1',
        `--untracked-files=${includeUntracked ? 'all' : 'no'}`
    ];
    const result = spawnSyncWithTimeout('git', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0 || result.timedOut || result.error) {
        throw new Error(formatGitFingerprintProbeFailure(repoRoot, args, result));
    }
    return String(result.stdout || '')
        .split('\n')
        .map((line: string) => line.trimEnd())
        .filter(Boolean);
}

interface GitStatusEntry {
    statusCode: string;
    path: string;
    originalPath: string | null;
    untracked: boolean;
}

/**
 * Parse a porcelain-v1 line into a compact status entry.
 * The parser is intentionally conservative; unparsable lines are ignored.
 */
function parseGitStatusLine(line: string): GitStatusEntry | null {
    if (!line) return null;
    if (line.startsWith('?? ')) {
        const untrackedPath = normalizePath(line.slice(3));
        if (!untrackedPath) return null;
        return {
            statusCode: '??',
            path: untrackedPath,
            originalPath: null,
            untracked: true
        };
    }
    if (line.length < 4) return null;

    const statusCode = `${line[0] || ' '}${line[1] || ' '}`;
    const payload = line.slice(3).trim();
    if (!payload) return null;

    const renameMatch = /^(.*) -> (.*)$/.exec(payload);
    const originalPath = renameMatch ? normalizePath(renameMatch[1]) : null;
    const currentPath = normalizePath(renameMatch ? renameMatch[2] : payload);
    if (!currentPath) return null;

    return {
        statusCode,
        path: currentPath,
        originalPath,
        untracked: false
    };
}

function resolveSnapshotCacheRepoRelativePath(repoRoot: string): string {
    return normalizePath(path.relative(repoRoot, resolveSnapshotCachePath(repoRoot)));
}

function isInternalSnapshotCachePath(repoRoot: string, relativePath: string | null | undefined): boolean {
    const normalized = normalizePath(relativePath || '');
    if (!normalized) return false;
    return normalized === resolveSnapshotCacheRepoRelativePath(repoRoot);
}

function readRepoRealPath(repoRoot: string): string | null {
    try {
        return fs.realpathSync(repoRoot);
    } catch {
        return null;
    }
}

function buildPathStateToken(repoRoot: string, relativePath: string, repoRealPath: string | null): string {
    const normalized = normalizePath(relativePath);
    if (!normalized) return 'missing';
    const state = getSafeWorktreePathState(
        repoRoot,
        normalized,
        repoRealPath ? { repoRealPath } : undefined
    );
    if (state.status === 'file') {
        return `file|${state.size ?? 0}|${state.sha256 || ''}`;
    }
    if (state.status === 'symbolic_link') {
        return [
            'symlink',
            state.size ?? 0,
            state.link_sha256 || '',
            state.target_status || 'unknown',
            state.target_path || '',
            state.target_mode ?? 0,
            state.target_size ?? 0,
            state.target_sha256 || ''
        ].join('|');
    }
    if (state.status === 'unreviewable_symlink') {
        return [
            'unreviewable_symlink',
            state.size ?? 0,
            state.link_sha256 || '',
            state.target_status || 'unknown',
            state.target_path || '',
            state.target_mode ?? 0,
            state.target_size ?? 0
        ].join('|');
    }
    if (state.status === 'directory') {
        try {
            const fullPath = path.join(repoRoot, normalized);
            const entries = fs.readdirSync(fullPath, { withFileTypes: true })
                .map((entry) => `${entry.isDirectory() ? 'dir' : entry.isFile() ? 'file' : entry.isSymbolicLink() ? 'symlink' : 'other'}:${entry.name}`)
                .sort();
            return `dir|${stringSha256(entries.join('\n')) || ''}`;
        } catch {
            return 'missing';
        }
    }
    if (state.status === 'special') {
        return `other|${state.mode ?? 0}|${state.size ?? 0}`;
    }
    return state.status;
}

function formatGitFingerprintProbeFailure(repoRoot: string, args: string[], result: ReturnType<typeof spawnSyncWithTimeout>): string {
    const reason = result.timedOut
        ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
        : result.error
            ? String(result.error)
            : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
    return `Unable to compute workspace snapshot cache fingerprint: git ${args.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`;
}

function readGitCachedRawDiff(repoRoot: string): string {
    const args = [
        '-C',
        String(repoRoot),
        'diff',
        '--cached',
        '--raw',
        '--find-renames',
        '--abbrev=40',
        '--diff-filter=ACDMRTUXB'
    ];
    const result = spawnSyncWithTimeout('git', args, {
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024
    });
    if (result.status !== 0 || result.timedOut || result.error) {
        throw new Error(formatGitFingerprintProbeFailure(repoRoot, args, result));
    }
    return String(result.stdout || '').trimEnd();
}

export function parseGitCachedRawDiffDeletedPaths(repoRoot: string, rawDiff: string): string[] {
    const deletedPaths = new Set<string>();
    for (const rawLine of String(rawDiff || '').split('\n')) {
        const line = rawLine.trimEnd();
        if (!line) continue;
        const tabParts = line.split('\t');
        if (tabParts.length < 2) continue;
        const metadataFields = tabParts[0].trim().split(/\s+/);
        const statusToken = metadataFields[metadataFields.length - 1] || '';
        if (!statusToken.startsWith('D')) continue;
        const deletedPath = normalizePath(tabParts[1]);
        if (!deletedPath || isInternalSnapshotCachePath(repoRoot, deletedPath)) continue;
        deletedPaths.add(deletedPath);
    }
    return [...deletedPaths].sort();
}

function buildUntrackedFingerprintDescriptors(repoRoot: string, repoRealPath: string | null): string[] {
    const descriptors: string[] = [];
    for (const line of readGitStatusLines(repoRoot, true)) {
        const entry = parseGitStatusLine(line);
        if (!entry || !entry.untracked) continue;
        if (isInternalSnapshotCachePath(repoRoot, entry.path)) continue;
        descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`);
    }
    return descriptors;
}

function buildGitStatusFingerprintHash(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean
): string {
    const normalizedSource = (detectionSource || 'git_auto').trim().toLowerCase();
    const stagedOnly = normalizedSource === 'git_staged_only' || normalizedSource === 'git_staged_plus_untracked';
    const repoRealPath = readRepoRealPath(repoRoot);

    if (stagedOnly) {
        const descriptors = includeUntracked
            ? buildUntrackedFingerprintDescriptors(repoRoot, repoRealPath)
            : [];
        const cachedRawDiff = readGitCachedRawDiff(repoRoot);
        descriptors.unshift(cachedRawDiff);
        for (const deletedPath of parseGitCachedRawDiffDeletedPaths(repoRoot, cachedRawDiff)) {
            descriptors.push(`D|${deletedPath}|${buildPathStateToken(repoRoot, deletedPath, repoRealPath)}`);
        }
        return stringSha256(descriptors.join('\n')) || '';
    }

    const descriptors: string[] = [];

    for (const line of readGitStatusLines(repoRoot, includeUntracked)) {
        const entry = parseGitStatusLine(line);
        if (!entry) continue;
        if (isInternalSnapshotCachePath(repoRoot, entry.path) || isInternalSnapshotCachePath(repoRoot, entry.originalPath)) {
            continue;
        }

        if (entry.untracked) {
            if (!includeUntracked) continue;
            descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`);
            continue;
        }

        const indexStatus = entry.statusCode[0] || ' ';
        const worktreeStatus = entry.statusCode[1] || ' ';

        if (indexStatus === ' ' && worktreeStatus === ' ') continue;
        descriptors.push(
            `W|${entry.statusCode}|${entry.originalPath || ''}|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`
        );
    }

    return stringSha256(descriptors.join('\n')) || '';
}

function buildExplicitPathFingerprintHash(repoRoot: string, explicitChangedFiles: string[]): string {
    const repoRealPath = readRepoRealPath(repoRoot);
    const normalizedExplicit = [...new Set(
        (explicitChangedFiles || []).map((filePath: string) => normalizePath(filePath)).filter(Boolean)
    )]
        .filter((relativePath: string) => !isInternalSnapshotCachePath(repoRoot, relativePath))
        .sort();

    const descriptors = normalizedExplicit.map((relativePath: string) => (
        `${relativePath}|${buildPathStateToken(repoRoot, relativePath, repoRealPath)}`
    ));

    return stringSha256(descriptors.join('\n')) || '';
}

/**
 * Compute a cheap fingerprint representing the current workspace state
 * combined with the call parameters. The fingerprint changes when:
 *   - HEAD moves (commit, reset, checkout)
 *   - staged/index changes move staged-only snapshots
 *   - relevant tracked or untracked worktree content changes
 *   - call parameters differ (detection source, untracked flag, explicit files)
 */
export function computeSnapshotFingerprint(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): { fingerprint: string; headSha: string | null; indexMtimeMs: number; indexSize: number } {
    const normalizedSource = (detectionSource || 'git_auto').trim().toLowerCase();
    const headSha = readHeadSha(repoRoot);
    const indexStat = statGitIndex(repoRoot);
    const paramsHash = computeParamsHash(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
    const stateHash = normalizedSource === 'explicit_changed_files'
        ? buildExplicitPathFingerprintHash(repoRoot, explicitChangedFiles)
        : buildGitStatusFingerprintHash(repoRoot, normalizedSource, includeUntracked);
    const raw = [
        `v${CACHE_VERSION}`,
        normalizedSource,
        headSha || 'null',
        stateHash,
        '0',
        '0',
        paramsHash
    ].join('|');
    const fingerprint = stringSha256(raw) || '';

    return {
        fingerprint,
        headSha,
        indexMtimeMs: indexStat.mtime_ms,
        indexSize: indexStat.size
    };
}

/**
 * Resolve the on-disk cache file path.
 */
export function resolveSnapshotCachePath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, CACHE_RELATIVE_PATH);
}

function isSnapshotCachePathSafe(repoRoot: string, cachePath: string): boolean {
    const cacheRoot = path.dirname(resolveSnapshotCachePath(repoRoot));
    return isPathRealpathInsideRoot(cachePath, repoRoot, { allowMissing: true })
        && isPathRealpathInsideRoot(cachePath, cacheRoot, { allowMissing: true });
}

/**
 * Read the persisted snapshot cache from disk.
 * Returns null if the file is missing, corrupt, or schema-incompatible.
 */
export function readSnapshotCache(cachePath: string): WorkspaceSnapshotCacheEntry | null {
    try {
        const resolved = path.resolve(cachePath);
        if (!fs.existsSync(resolved)) return null;
        const raw = fs.readFileSync(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.cache_version !== CACHE_VERSION) return null;
        if (typeof parsed.fingerprint !== 'string' || !parsed.fingerprint) return null;
        if (!parsed.snapshot || typeof parsed.snapshot !== 'object') return null;
        const snapshot = parsed.snapshot as Record<string, unknown>;
        if (!snapshot.changed_file_stats || typeof snapshot.changed_file_stats !== 'object') return null;
        if (!parsed.params || typeof parsed.params !== 'object') return null;
        if (!parsed.git_state || typeof parsed.git_state !== 'object') return null;
        return parsed as unknown as WorkspaceSnapshotCacheEntry;
    } catch {
        return null;
    }
}

/**
 * Write the snapshot cache to disk atomically (write-rename).
 */
export function writeSnapshotCache(cachePath: string, entry: WorkspaceSnapshotCacheEntry): void {
    const resolved = path.resolve(cachePath);
    writeFileAtomically(resolved, JSON.stringify(entry, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

/**
 * Remove the snapshot cache file.
 */
export function invalidateSnapshotCache(repoRoot: string): boolean {
    try {
        const cachePath = resolveSnapshotCachePath(repoRoot);
        if (!isSnapshotCachePathSafe(repoRoot, cachePath)) {
            return false;
        }
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
            return true;
        }
        return false;
    } catch {
        return false;
    }
}

/**
 * Get a workspace snapshot, returning a cached result when the relevant
 * workspace state and call parameters have not changed.
 *
 * On cache miss the full snapshot is computed via `getWorkspaceSnapshot`
 * and persisted for subsequent calls. Correctness is preserved because the
 * fingerprint covers:
 *   - HEAD changes
 *   - staged/index changes for staged-only snapshots
 *   - worktree file metadata for the relevant tracked/untracked paths
 *   - different parameters / explicit file lists
 *
 * Callers in hot paths (compile-gate, required-reviews-check) benefit
 * when the workspace is stable between sequential gate invocations.
 */
export function getWorkspaceSnapshotCached(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[],
    options: WorkspaceSnapshotCacheOptions = {}
): WorkspaceSnapshot & { cache_hit: boolean } {
    if (options.noCache) {
        const fresh = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
        return { ...fresh, cache_hit: false };
    }

    const cachePath = resolveSnapshotCachePath(repoRoot);
    const cachePathSafe = isSnapshotCachePathSafe(repoRoot, cachePath);
    const fp = computeSnapshotFingerprint(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);

    // Attempt cache hit
    const cached = cachePathSafe ? readSnapshotCache(cachePath) : null;
    if (cached && cached.fingerprint === fp.fingerprint) {
        return { ...cached.snapshot, cache_hit: true };
    }

    // Cache miss — compute fresh
    const fresh = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);

    if (!options.readOnly && cachePathSafe) {
        const normalizedExplicit = [...new Set(
            (explicitChangedFiles || []).map((f: string) => normalizePath(f)).filter(Boolean)
        )].sort();

        const entry: WorkspaceSnapshotCacheEntry = {
            cache_version: CACHE_VERSION,
            fingerprint: fp.fingerprint,
            snapshot: fresh,
            timestamp_utc: new Date().toISOString(),
            params: {
                repo_root: normalizePath(path.resolve(repoRoot)),
                detection_source: detectionSource,
                include_untracked: includeUntracked,
                explicit_changed_files_hash: stringSha256(normalizedExplicit.join('\n'))
            },
            git_state: {
                head_sha: fp.headSha,
                index_mtime_ms: fp.indexMtimeMs,
                index_size: fp.indexSize
            }
        };

        try {
            writeSnapshotCache(cachePath, entry);
        } catch {
            // Best-effort write; cache failure must not break the gate
        }
    }

    return { ...fresh, cache_hit: false };
}
