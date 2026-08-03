import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../../core/filesystem';
import { isPathRealpathInsideRoot, stringSha256, joinOrchestratorPath, normalizePath } from '../shared/helpers';
import { getWorkspaceSnapshot } from '../compile/compile-gate';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { normalizeGitRepoRelativePath } from '../../core/git-change-classification';
import { getSafeWorktreePathState } from './worktree-path-state';
import { normalizeGitChangeClassificationEvidence } from '../../core/git-change-classification';

const CACHE_VERSION = 4;
const CACHE_RELATIVE_PATH = path.join('runtime', 'cache', 'workspace-snapshot.json');
const MAX_IN_PROCESS_CACHE_ENTRIES = 32;

interface InProcessSnapshotCacheEntry {
    repoKey: string;
    snapshot: WorkspaceSnapshot;
}

const inProcessSnapshotCache = new Map<string, InProcessSnapshotCacheEntry>();
const workspaceSnapshotRequestRoots = new WeakMap<WorkspaceSnapshotRequest, string>();

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

export type ResolvedWorkspaceSnapshot = WorkspaceSnapshot & { cache_hit: boolean };

export interface WorkspaceSnapshotRequest {
    readonly repo_root: string;
    read(
        detectionSource: string,
        includeUntracked: boolean,
        explicitChangedFiles: string[]
    ): ResolvedWorkspaceSnapshot;
}

interface WorkspaceSnapshotRequestEntry {
    snapshot: ResolvedWorkspaceSnapshot | null;
    error: unknown;
}

function normalizeExplicitChangedFiles(explicitChangedFiles: string[]): string[] {
    return [...new Set(
        (explicitChangedFiles || [])
            .map((filePath) => normalizeGitRepoRelativePath(filePath))
            .filter((filePath): filePath is string => filePath !== null)
    )].sort();
}

function normalizeSnapshotRequestKey(
    detectionSource: string,
    includeUntracked: boolean,
    explicitChangedFiles: string[]
): string {
    const normalizedSource = String(detectionSource || 'git_auto').trim().toLowerCase() || 'git_auto';
    const effectiveIncludeUntracked = normalizedSource === 'git_staged_only' ? false : includeUntracked;
    return JSON.stringify([
        normalizedSource,
        effectiveIncludeUntracked,
        normalizeExplicitChangedFiles(explicitChangedFiles)
    ]);
}

function sameStringList(left: readonly string[], right: readonly string[]): boolean {
    return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function authenticateWorkspaceSnapshot(snapshot: ResolvedWorkspaceSnapshot): void {
    const changedFiles = normalizeExplicitChangedFiles(snapshot.changed_files);
    const authorizedFiles = normalizeExplicitChangedFiles(snapshot.authorized_files);
    if (
        !sameStringList(changedFiles, snapshot.changed_files)
        || snapshot.changed_files_count !== changedFiles.length
        || snapshot.changed_files_sha256 !== stringSha256(changedFiles.join('\n'))
    ) {
        throw new Error('Workspace snapshot authentication failed: changed-file binding is inconsistent.');
    }
    if (
        !sameStringList(authorizedFiles, snapshot.authorized_files)
        || snapshot.authorized_files_count !== authorizedFiles.length
        || snapshot.authorized_files_sha256 !== stringSha256(authorizedFiles.join('\n'))
    ) {
        throw new Error('Workspace snapshot authentication failed: authorized-file binding is inconsistent.');
    }
    const normalizedClassification = normalizeGitChangeClassificationEvidence(snapshot.git_change_classification);
    if (
        snapshot.git_change_classification != null
        && (
            !normalizedClassification
            || !sameStringList(normalizedClassification.effective_changed_files, changedFiles)
        )
    ) {
        throw new Error('Workspace snapshot authentication failed: canonical Git classification is inconsistent.');
    }
    for (const hash of [snapshot.changed_files_sha256, snapshot.scope_content_sha256, snapshot.scope_sha256]) {
        if (!/^[0-9a-f]{64}$/u.test(String(hash || '').trim().toLowerCase())) {
            throw new Error('Workspace snapshot authentication failed: scope hash is invalid.');
        }
    }
}

function deepFreezeSnapshot<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const nested of Object.values(value as Record<string, unknown>)) {
        deepFreezeSnapshot(nested);
    }
    return Object.freeze(value);
}

/**
 * Build a request-local, parameter-keyed reader for fresh canonical workspace
 * snapshots. Equivalent consumers receive the same authenticated immutable
 * object, including the same cached failure, while a later request starts from
 * a new workspace generation.
 */
export function createWorkspaceSnapshotRequest(repoRoot: string): WorkspaceSnapshotRequest {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const entries = new Map<string, WorkspaceSnapshotRequestEntry>();
    const request = Object.freeze({
        repo_root: normalizePath(resolvedRepoRoot),
        read(
            detectionSource: string,
            includeUntracked: boolean,
            explicitChangedFiles: string[]
        ): ResolvedWorkspaceSnapshot {
            const key = normalizeSnapshotRequestKey(detectionSource, includeUntracked, explicitChangedFiles);
            const existing = entries.get(key);
            if (existing) {
                if (existing.snapshot) return existing.snapshot;
                throw existing.error;
            }
            try {
                const snapshot = getWorkspaceSnapshotCached(
                    resolvedRepoRoot,
                    detectionSource,
                    includeUntracked,
                    explicitChangedFiles,
                    { noCache: true, readOnly: true }
                );
                authenticateWorkspaceSnapshot(snapshot);
                const immutableSnapshot = deepFreezeSnapshot(snapshot);
                entries.set(key, { snapshot: immutableSnapshot, error: null });
                return immutableSnapshot;
            } catch (error: unknown) {
                entries.set(key, { snapshot: null, error });
                throw error;
            }
        }
    });
    workspaceSnapshotRequestRoots.set(request, normalizeRepoCacheKey(resolvedRepoRoot));
    return request;
}

/**
 * Reuse only factory-created requests that are bound to the same repository.
 * This prevents public audit/report injection points from accepting a foreign
 * workspace generation or a structurally compatible forged reader.
 */
export function resolveWorkspaceSnapshotRequest(
    repoRoot: string,
    request?: WorkspaceSnapshotRequest
): WorkspaceSnapshotRequest {
    if (!request) {
        return createWorkspaceSnapshotRequest(repoRoot);
    }
    const expectedRepoRoot = normalizeRepoCacheKey(repoRoot);
    const registeredRepoRoot = typeof request === 'object' && request !== null
        ? workspaceSnapshotRequestRoots.get(request)
        : undefined;
    const declaredRepoRoot = typeof request?.repo_root === 'string'
        ? normalizeRepoCacheKey(request.repo_root)
        : null;
    if (registeredRepoRoot !== expectedRepoRoot || declaredRepoRoot !== expectedRepoRoot) {
        throw new Error('Workspace snapshot request is not factory-authenticated for the requested repository root.');
    }
    return request;
}

function normalizeRepoCacheKey(repoRoot: string): string {
    const resolved = normalizePath(path.resolve(repoRoot));
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function makeInProcessCacheKey(repoRoot: string, fingerprint: string): string {
    return `${normalizeRepoCacheKey(repoRoot)}|${fingerprint}`;
}

function cloneWorkspaceSnapshot(snapshot: WorkspaceSnapshot): WorkspaceSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as WorkspaceSnapshot;
}

function rememberInProcessSnapshot(repoRoot: string, fingerprint: string, snapshot: WorkspaceSnapshot): void {
    const cacheKey = makeInProcessCacheKey(repoRoot, fingerprint);
    inProcessSnapshotCache.delete(cacheKey);
    inProcessSnapshotCache.set(cacheKey, {
        repoKey: normalizeRepoCacheKey(repoRoot),
        snapshot: cloneWorkspaceSnapshot(snapshot)
    });
    while (inProcessSnapshotCache.size > MAX_IN_PROCESS_CACHE_ENTRIES) {
        const oldestKey = inProcessSnapshotCache.keys().next().value as string | undefined;
        if (!oldestKey) break;
        inProcessSnapshotCache.delete(oldestKey);
    }
}

function forgetInProcessSnapshots(repoRoot: string): boolean {
    const repoKey = normalizeRepoCacheKey(repoRoot);
    let removed = false;
    for (const [cacheKey, entry] of inProcessSnapshotCache) {
        if (entry.repoKey === repoKey) {
            inProcessSnapshotCache.delete(cacheKey);
            removed = true;
        }
    }
    return removed;
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
    const normalizedExplicit = normalizeExplicitChangedFiles(explicitChangedFiles);
    const key = `${path.resolve(repoRoot)}|${detectionSource}|${includeUntracked}|${normalizedExplicit.join(',')}`;
    return stringSha256(key) || '';
}

interface GitFingerprintStatusEntry {
    statusCode: string;
    path: string;
    previousPath: string | null;
    untracked: boolean;
}

/**
 * Read only the porcelain candidates required for cache invalidation.
 * This intentionally avoids the canonical content classifier: a cache hit
 * must not pay the full snapshot-discovery cost that the cache exists to skip.
 */
function readGitFingerprintStatusEntries(
    repoRoot: string,
    includeUntracked: boolean
): GitFingerprintStatusEntry[] {
    const args = [
        '-C',
        String(repoRoot),
        '--no-pager',
        'status',
        '--porcelain=v1',
        '-z',
        `--untracked-files=${includeUntracked ? 'all' : 'no'}`,
        '--ignore-submodules=none',
        '--renames'
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

    const fields = String(result.stdout || '').split('\0');
    const entries: GitFingerprintStatusEntry[] = [];
    let index = 0;
    while (index < fields.length) {
        const record = String(fields[index++] || '');
        if (!record) continue;
        if (record.length < 4 || record.charAt(2) !== ' ') {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: malformed git porcelain record.');
        }
        const xStatus = record.charAt(0);
        const yStatus = record.charAt(1);
        const currentPath = normalizeGitRepoRelativePath(record.slice(3));
        if (!currentPath) {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: git porcelain path is invalid.');
        }
        const renameOrCopy = /[RC]/u.test(xStatus) || /[RC]/u.test(yStatus);
        const previousPath = renameOrCopy
            ? normalizeGitRepoRelativePath(String(fields[index++] || ''))
            : null;
        if (renameOrCopy && !previousPath) {
            throw new Error('Unable to compute workspace snapshot cache fingerprint: git porcelain rename source is invalid.');
        }
        entries.push({
            statusCode: `${xStatus}${yStatus}`,
            path: currentPath,
            previousPath,
            untracked: xStatus === '?' && yStatus === '?'
        });
    }
    return entries;
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
    const displayArgs = args[0] === '-C' ? args.slice(2) : args;
    const reason = result.timedOut
        ? `timed out after ${DEFAULT_GIT_TIMEOUT_MS}ms`
        : result.error
            ? String(result.error)
            : String(result.stderr || result.stdout || `exit status ${result.status}`).trim();
    return `Unable to compute workspace snapshot cache fingerprint: git ${displayArgs.join(' ')} failed in '${normalizePath(repoRoot)}' (${reason}).`;
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

function buildGitStatusFingerprintHash(
    repoRoot: string,
    detectionSource: string,
    includeUntracked: boolean
): string {
    const normalizedSource = (detectionSource || 'git_auto').trim().toLowerCase();
    const stagedOnly = normalizedSource === 'git_staged_only' || normalizedSource === 'git_staged_plus_untracked';
    const repoRealPath = readRepoRealPath(repoRoot);
    const descriptors: string[] = [];
    let hasStagedChanges = false;

    for (const entry of readGitFingerprintStatusEntries(repoRoot, includeUntracked)) {
        if (
            isInternalSnapshotCachePath(repoRoot, entry.path)
            || isInternalSnapshotCachePath(repoRoot, entry.previousPath)
        ) {
            continue;
        }

        if (entry.untracked) {
            if (includeUntracked) {
                descriptors.push(`U|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`);
            }
            continue;
        }

        const indexStatus = entry.statusCode.charAt(0) || ' ';
        const worktreeStatus = entry.statusCode.charAt(1) || ' ';
        if (indexStatus !== ' ' && indexStatus !== '?') {
            hasStagedChanges = true;
            descriptors.push(`S|${indexStatus}|${entry.previousPath || ''}|${entry.path}`);
        }
        if (!stagedOnly && worktreeStatus !== ' ' && worktreeStatus !== '?') {
            descriptors.push(
                `W|${worktreeStatus}|${entry.previousPath || ''}|${entry.path}|${buildPathStateToken(repoRoot, entry.path, repoRealPath)}`
            );
        }
    }

    if (stagedOnly || hasStagedChanges) {
        const cachedRawDiff = readGitCachedRawDiff(repoRoot);
        descriptors.unshift(cachedRawDiff);
        for (const deletedPath of parseGitCachedRawDiffDeletedPaths(repoRoot, cachedRawDiff)) {
            descriptors.push(`D|${deletedPath}|${buildPathStateToken(repoRoot, deletedPath, repoRealPath)}`);
        }
    }

    return stringSha256(descriptors.join('\n')) || '';
}

function buildExplicitPathFingerprintHash(repoRoot: string, explicitChangedFiles: string[]): string {
    const repoRealPath = readRepoRealPath(repoRoot);
    const normalizedExplicit = normalizeExplicitChangedFiles(explicitChangedFiles)
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
    const removedFromMemory = forgetInProcessSnapshots(repoRoot);
    try {
        const cachePath = resolveSnapshotCachePath(repoRoot);
        if (!isSnapshotCachePathSafe(repoRoot, cachePath)) {
            return removedFromMemory;
        }
        if (fs.existsSync(cachePath)) {
            fs.unlinkSync(cachePath);
            return true;
        }
        return removedFromMemory;
    } catch {
        return removedFromMemory;
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
    const inProcessCacheKey = makeInProcessCacheKey(repoRoot, fp.fingerprint);

    const inProcessCached = cachePathSafe ? inProcessSnapshotCache.get(inProcessCacheKey) : null;
    if (inProcessCached) {
        inProcessSnapshotCache.delete(inProcessCacheKey);
        inProcessSnapshotCache.set(inProcessCacheKey, inProcessCached);
        return { ...cloneWorkspaceSnapshot(inProcessCached.snapshot), cache_hit: true };
    }

    // Attempt cache hit
    const cached = cachePathSafe ? readSnapshotCache(cachePath) : null;
    if (cached && cached.fingerprint === fp.fingerprint) {
        rememberInProcessSnapshot(repoRoot, fp.fingerprint, cached.snapshot);
        return { ...cached.snapshot, cache_hit: true };
    }

    // Cache miss — compute fresh
    const fresh = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, explicitChangedFiles);
    if (cachePathSafe) {
        rememberInProcessSnapshot(repoRoot, fp.fingerprint, fresh);
    }

    if (!options.readOnly && cachePathSafe) {
        const normalizedExplicit = normalizeExplicitChangedFiles(explicitChangedFiles);

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
