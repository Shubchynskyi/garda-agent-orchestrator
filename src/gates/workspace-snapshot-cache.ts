import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import { stringSha256, joinOrchestratorPath, normalizePath } from './helpers';
import { getWorkspaceSnapshot } from './compile-gate';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';

const CACHE_VERSION = 1;
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
 * Returns an empty list on any failure so the caller falls back to a more
 * conservative cache key instead of breaking the gate.
 */
function readGitStatusLines(repoRoot: string, includeUntracked: boolean): string[] {
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            String(repoRoot),
            'status',
            '--porcelain=v1',
            `--untracked-files=${includeUntracked ? 'all' : 'no'}`
        ], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) return [];
        return String(result.stdout || '')
            .split('\n')
            .map((line: string) => line.trimEnd())
            .filter(Boolean);
    } catch {
        return [];
    }
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

function buildPathStateToken(repoRoot: string, relativePath: string): string {
    const normalized = normalizePath(relativePath);
    if (!normalized) return 'missing';
    const fullPath = path.join(repoRoot, normalized);
    try {
        const stat = fs.statSync(fullPath);
        const kind = stat.isFile() ? 'file' : (stat.isDirectory() ? 'dir' : 'other');
        return `${kind}|${stat.size}|${stat.mtimeMs}`;
    } catch {
        return 'missing';
    }
}

function readGitCachedRawDiff(repoRoot: string): string {
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            String(repoRoot),
            'diff',
            '--cached',
            '--raw',
            '--find-renames',
            '--abbrev=40',
            '--diff-filter=ACMRTUXB'
        ], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 10 * 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) return '';
        return String(result.stdout || '').trimEnd();
    } catch {
        return '';
    }
}

function buildUntrackedFingerprintDescriptors(repoRoot: string): string[] {
    const descriptors: string[] = [];
    for (const line of readGitStatusLines(repoRoot, true)) {
        const entry = parseGitStatusLine(line);
        if (!entry || !entry.untracked) continue;
        if (isInternalSnapshotCachePath(repoRoot, entry.path)) continue;
        descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path)}`);
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

    if (stagedOnly) {
        const descriptors = [readGitCachedRawDiff(repoRoot)];
        if (includeUntracked) {
            descriptors.push(...buildUntrackedFingerprintDescriptors(repoRoot));
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
            descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path)}`);
            continue;
        }

        const indexStatus = entry.statusCode[0] || ' ';
        const worktreeStatus = entry.statusCode[1] || ' ';

        if (indexStatus === ' ' && worktreeStatus === ' ') continue;
        descriptors.push(
            `W|${entry.statusCode}|${entry.originalPath || ''}|${entry.path}|${buildPathStateToken(repoRoot, entry.path)}`
        );
    }

    return stringSha256(descriptors.join('\n')) || '';
}

function buildExplicitPathFingerprintHash(repoRoot: string, explicitChangedFiles: string[]): string {
    const normalizedExplicit = [...new Set(
        (explicitChangedFiles || []).map((filePath: string) => normalizePath(filePath)).filter(Boolean)
    )]
        .filter((relativePath: string) => !isInternalSnapshotCachePath(repoRoot, relativePath))
        .sort();

    const descriptors = normalizedExplicit.map((relativePath: string) => (
        `${relativePath}|${buildPathStateToken(repoRoot, relativePath)}`
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
    const fp = computeSnapshotFingerprint(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);

    // Attempt cache hit
    const cached = readSnapshotCache(cachePath);
    if (cached && cached.fingerprint === fp.fingerprint) {
        return { ...cached.snapshot, cache_hit: true };
    }

    // Cache miss — compute fresh
    const fresh = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);

    if (!options.readOnly) {
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
