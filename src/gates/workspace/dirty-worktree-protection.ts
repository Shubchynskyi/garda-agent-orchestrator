import * as fs from 'node:fs';
import * as path from 'node:path';

import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../../core/subprocess';
import { getWorkspaceSnapshot } from '../compile/compile-gate';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    normalizePath,
    stringSha256,
    toPlainRecord
} from '../shared/helpers';

export interface DirtyWorkspaceBaseline {
    detection_source: string;
    include_untracked: boolean;
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    file_hashes: Record<string, string | null>;
    entry_authorized_files?: string[];
}

export interface TaskOwnedDirtyWorkspaceScope {
    owned_files: string[];
    owned_files_sha256: string | null;
    owned_preexisting_files: string[];
    owned_new_files: string[];
    explicitly_selected_preexisting_files: string[];
    delta_changed_preexisting_files: string[];
    untouched_preexisting_files: string[];
    explicitly_authorized_preexisting_files: string[];
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
}

export interface DeriveTaskOwnedDirtyWorkspaceScopeOptions {
    isExplicitTaskScope?: boolean;
    plannedChangedFiles?: string[];
    useStaged?: boolean;
}

export interface ProtectedDirtyWorkspaceScope {
    protected_files: string[];
    protected_files_sha256: string | null;
    protected_file_hashes: Record<string, string | null>;
}

export interface ProtectedDirtyWorkspaceDriftResult {
    status: 'NOT_APPLICABLE' | 'PASS' | 'DRIFT_DETECTED';
    assessment: 'NOT_APPLICABLE' | 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE' | 'PROTECTED_LOCAL_BASELINE_DRIFT';
    protected_files: string[];
    protected_files_sha256: string | null;
    baseline_file_hashes: Record<string, string | null>;
    current_file_hashes: Record<string, string | null>;
    changed_files: string[];
    violations: string[];
}

function normalizeRelativePaths(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizePath(value))
            .filter(Boolean)
    )].sort();
}

function normalizeFileHashRecord(value: unknown, allowedPaths: string[]): Record<string, string | null> {
    const source = toPlainRecord(value) || {};
    const result: Record<string, string | null> = {};
    for (const relativePath of allowedPaths) {
        if (!Object.prototype.hasOwnProperty.call(source, relativePath)) {
            result[relativePath] = null;
            continue;
        }
        const hashValue = source[relativePath];
        if (hashValue == null || String(hashValue).trim() === '') {
            result[relativePath] = null;
            continue;
        }
        result[relativePath] = String(hashValue).trim().toLowerCase();
    }
    return result;
}

function resolveWorkspacePath(repoRoot: string, relativePath: string): string | null {
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, relativePath);
    const relativeFromRoot = path.relative(resolvedRoot, resolvedPath);
    if (!relativeFromRoot || relativeFromRoot.startsWith('..') || path.isAbsolute(relativeFromRoot)) {
        return null;
    }
    return resolvedPath;
}

export function normalizeWorkspaceRelativePath(repoRoot: string, value: unknown): string | null {
    const rawPath = String(value || '').trim();
    if (!rawPath || rawPath.includes('\0')) {
        return null;
    }
    const portablePath = rawPath.replace(/\\/g, '/');
    if (
        path.isAbsolute(rawPath)
        || path.win32.isAbsolute(rawPath)
        || path.posix.isAbsolute(portablePath)
        || /^[a-z]:/i.test(portablePath)
        || portablePath.split('/').some((segment) => segment === '..')
    ) {
        return null;
    }
    const normalizedPath = normalizePath(portablePath);
    if (!normalizedPath || normalizedPath === '.') {
        return null;
    }
    const resolvedPath = resolveWorkspacePath(repoRoot, normalizedPath);
    if (!resolvedPath || !isPathRealpathInsideRoot(resolvedPath, repoRoot, { allowMissing: true })) {
        return null;
    }
    return normalizedPath;
}

export function normalizeWorkspaceRelativePaths(repoRoot: string, values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((value) => normalizeWorkspaceRelativePath(repoRoot, value))
            .filter((value): value is string => !!value)
    )].sort();
}

function getGitTrackedPaths(repoRoot: string, relativePaths: string[]): Set<string> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    if (normalizedPaths.length === 0) {
        return new Set();
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'ls-files',
            '-z',
            '--',
            ...normalizedPaths.map((relativePath) => `:(literal)${relativePath}`)
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return new Set();
        }
        return new Set(normalizeWorkspaceRelativePaths(repoRoot, String(result.stdout || '').split('\0')));
    } catch {
        return new Set();
    }
}

function getStagedRenameSourcePaths(repoRoot: string, currentScopeChangedFiles: string[]): string[] {
    const currentFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles));
    if (currentFileSet.size === 0) {
        return [];
    }
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'diff',
            '--cached',
            '--name-status',
            '-z',
            '--find-renames',
            '--diff-filter=R'
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 1024 * 1024
        });
        if (result.status !== 0) {
            return [];
        }
        const entries = String(result.stdout || '').split('\0');
        const renamedSources: string[] = [];
        for (let index = 0; index < entries.length;) {
            const status = String(entries[index++] || '').trim();
            if (!/^R\d*$/.test(status)) {
                continue;
            }
            const sourcePath = normalizeWorkspaceRelativePath(repoRoot, entries[index++] || '');
            const targetPath = normalizeWorkspaceRelativePath(repoRoot, entries[index++] || '');
            if (sourcePath && targetPath && currentFileSet.has(targetPath)) {
                renamedSources.push(sourcePath);
            }
        }
        return normalizeWorkspaceRelativePaths(repoRoot, renamedSources);
    } catch {
        return [];
    }
}

function collectExplicitlyAuthorizedDirtyPaths(
    repoRoot: string,
    changedFiles: string[],
    plannedChangedFiles: string[]
): string[] {
    const changedFileSet = new Set(normalizeWorkspaceRelativePaths(repoRoot, changedFiles));
    const normalizedPlannedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles);
    const trackedFileSet = getGitTrackedPaths(repoRoot, normalizedPlannedFiles);
    const result: string[] = [];
    for (const relativePath of normalizedPlannedFiles) {
        if (changedFileSet.has(relativePath) || trackedFileSet.has(relativePath)) {
            continue;
        }
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        if (!absolutePath) {
            continue;
        }
        try {
            const stat = fs.lstatSync(absolutePath);
            if (stat.isFile() || stat.isSymbolicLink()) {
                result.push(relativePath);
            }
        } catch {
            // A missing planned path is not a pre-task dirty baseline entry.
        }
    }
    return [...new Set(result)].sort();
}

function buildFileHashMap(repoRoot: string, relativePaths: string[]): Record<string, string | null> {
    const normalizedPaths = normalizeWorkspaceRelativePaths(repoRoot, relativePaths);
    const fileHashes: Record<string, string | null> = {};
    for (const relativePath of normalizedPaths) {
        const absolutePath = resolveWorkspacePath(repoRoot, relativePath);
        fileHashes[relativePath] = absolutePath ? fileSha256(absolutePath) : null;
    }
    return fileHashes;
}

export function captureDirtyWorkspaceBaseline(
    repoRoot: string,
    plannedChangedFiles: string[] = []
): DirtyWorkspaceBaseline {
    let snapshot: ReturnType<typeof getWorkspaceSnapshot>;
    try {
        snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    } catch {
        return {
            detection_source: 'git_auto',
            include_untracked: true,
            changed_files: [],
            changed_files_sha256: stringSha256(''),
            scope_sha256: null,
            file_hashes: {},
            entry_authorized_files: []
        };
    }
    const snapshotChangedFiles = normalizeWorkspaceRelativePaths(repoRoot, snapshot.changed_files);
    const changedFiles = [...new Set([
        ...snapshotChangedFiles,
        ...collectExplicitlyAuthorizedDirtyPaths(repoRoot, snapshot.changed_files, plannedChangedFiles)
    ])].sort();
    const changedFileSet = new Set(changedFiles);
    const entryAuthorizedFiles = normalizeWorkspaceRelativePaths(repoRoot, plannedChangedFiles)
        .filter((relativePath) => changedFileSet.has(relativePath));
    return {
        detection_source: snapshot.detection_source,
        include_untracked: !!snapshot.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: stringSha256(changedFiles.join('\n')),
        scope_sha256: changedFiles.length === snapshotChangedFiles.length
            ? snapshot.scope_sha256
            : stringSha256(`${snapshot.scope_sha256 || ''}|${changedFiles.join('\n')}`),
        file_hashes: buildFileHashMap(repoRoot, changedFiles),
        entry_authorized_files: entryAuthorizedFiles
    };
}

export function normalizeDirtyWorkspaceBaseline(value: unknown, repoRoot?: string): DirtyWorkspaceBaseline | null {
    const baseline = toPlainRecord(value);
    if (!baseline) {
        return null;
    }
    const changedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, baseline.changed_files)
        : normalizeRelativePaths(baseline.changed_files);
    return {
        detection_source: String(baseline.detection_source || 'git_auto').trim() || 'git_auto',
        include_untracked: baseline.include_untracked == null ? true : !!baseline.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: String(
            baseline.changed_files_sha256 || stringSha256(changedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        scope_sha256: String(baseline.scope_sha256 || '').trim().toLowerCase() || null,
        file_hashes: normalizeFileHashRecord(baseline.file_hashes, changedFiles),
        entry_authorized_files: (repoRoot
            ? normalizeWorkspaceRelativePaths(repoRoot, baseline.entry_authorized_files)
            : normalizeRelativePaths(baseline.entry_authorized_files))
            .filter((relativePath) => changedFiles.includes(relativePath))
    };
}

export function deriveTaskOwnedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    currentScopeChangedFiles: string[],
    options: DeriveTaskOwnedDirtyWorkspaceScopeOptions = {}
): TaskOwnedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }

    const currentFiles = normalizeWorkspaceRelativePaths(repoRoot, currentScopeChangedFiles);
    const baselineFileSet = new Set(normalizedBaseline.changed_files);
    const currentFileSet = new Set(currentFiles);
    const stagedRenameSourceSet = new Set(
        options.useStaged === true
            ? getStagedRenameSourcePaths(repoRoot, currentFiles)
            : []
    );
    const explicitlyAuthorizedPreexistingFiles = normalizeWorkspaceRelativePaths(repoRoot, [
        ...(normalizedBaseline.entry_authorized_files || []),
        ...(options.plannedChangedFiles || [])
    ]).filter((relativePath) => baselineFileSet.has(relativePath));
    const explicitlyAuthorizedPreexistingSet = new Set(explicitlyAuthorizedPreexistingFiles);
    const candidateFiles = [...new Set([
        ...normalizedBaseline.changed_files,
        ...currentFiles,
        ...explicitlyAuthorizedPreexistingFiles
    ])].sort();
    const currentFileHashes = buildFileHashMap(repoRoot, candidateFiles);
    const deltaChangedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (
            !currentFileSet.has(relativePath)
            && !explicitlyAuthorizedPreexistingSet.has(relativePath)
            && !stagedRenameSourceSet.has(relativePath)
        ) {
            return false;
        }
        return normalizedBaseline.file_hashes[relativePath] !== currentFileHashes[relativePath];
    });
    const explicitlySelectedPreexistingFiles = normalizedBaseline.changed_files.filter((relativePath) => {
        if (!currentFileSet.has(relativePath)) {
            return false;
        }
        return options.isExplicitTaskScope === true || explicitlyAuthorizedPreexistingSet.has(relativePath);
    });
    const ownedPreexistingFiles = [...new Set([
        ...deltaChangedPreexistingFiles,
        ...explicitlySelectedPreexistingFiles
    ])].sort();
    const ownedPreexistingSet = new Set(ownedPreexistingFiles);
    const ownedNewFiles = currentFiles.filter((relativePath) => !baselineFileSet.has(relativePath));
    const ownedFiles = [...new Set([
        ...ownedPreexistingFiles,
        ...ownedNewFiles
    ])].sort();

    return {
        owned_files: ownedFiles,
        owned_files_sha256: stringSha256(ownedFiles.join('\n')),
        owned_preexisting_files: ownedPreexistingFiles,
        owned_new_files: ownedNewFiles,
        explicitly_selected_preexisting_files: explicitlySelectedPreexistingFiles,
        delta_changed_preexisting_files: deltaChangedPreexistingFiles,
        untouched_preexisting_files: normalizedBaseline.changed_files
            .filter((relativePath) => !ownedPreexistingSet.has(relativePath)),
        explicitly_authorized_preexisting_files: explicitlyAuthorizedPreexistingFiles,
        baseline_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, normalizedBaseline.changed_files),
        current_file_hashes: currentFileHashes
    };
}

export function deriveProtectedDirtyWorkspaceScope(
    repoRoot: string,
    baseline: DirtyWorkspaceBaseline | null,
    taskScopeChangedFiles: string[]
): ProtectedDirtyWorkspaceScope | null {
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(baseline, repoRoot);
    if (!normalizedBaseline) {
        return null;
    }
    const scopeFiles = new Set(normalizeWorkspaceRelativePaths(repoRoot, taskScopeChangedFiles));
    const protectedFiles = normalizedBaseline.changed_files.filter((relativePath) => !scopeFiles.has(relativePath)).sort();
    return {
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        protected_file_hashes: normalizeFileHashRecord(normalizedBaseline.file_hashes, protectedFiles)
    };
}

export function normalizeProtectedDirtyWorkspaceScope(
    value: unknown,
    repoRoot?: string
): ProtectedDirtyWorkspaceScope | null {
    const scope = toPlainRecord(value);
    if (!scope) {
        return null;
    }
    const protectedFiles = repoRoot
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : normalizeRelativePaths(scope.protected_files);
    return {
        protected_files: protectedFiles,
        protected_files_sha256: String(
            scope.protected_files_sha256 || stringSha256(protectedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        protected_file_hashes: normalizeFileHashRecord(scope.protected_file_hashes, protectedFiles)
    };
}

function getPreflightTriggers(preflight: unknown): Record<string, unknown> | null {
    const preflightObject = toPlainRecord(preflight);
    return preflightObject ? toPlainRecord(preflightObject.triggers) : null;
}

export function getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_task_owned_files) : [];
}

export function getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot: string, preflight: unknown): string[] {
    const triggers = getPreflightTriggers(preflight);
    return triggers ? normalizeWorkspaceRelativePaths(repoRoot, triggers.dirty_workspace_untouched_baseline_files) : [];
}

export function getProtectedDirtyWorkspaceScopeFromPreflight(preflight: unknown): ProtectedDirtyWorkspaceScope | null {
    const triggers = getPreflightTriggers(preflight);
    if (!triggers) {
        return null;
    }
    return normalizeProtectedDirtyWorkspaceScope({
        protected_files: triggers.dirty_workspace_protected_files,
        protected_files_sha256: triggers.dirty_workspace_protected_files_sha256,
        protected_file_hashes: triggers.dirty_workspace_protected_file_hashes
    });
}

export function detectProtectedDirtyWorkspaceDrift(
    repoRoot: string,
    scope: ProtectedDirtyWorkspaceScope | null
): ProtectedDirtyWorkspaceDriftResult {
    const protectedFiles = scope
        ? normalizeWorkspaceRelativePaths(repoRoot, scope.protected_files)
        : [];
    if (protectedFiles.length === 0) {
        return {
            status: 'NOT_APPLICABLE',
            assessment: 'NOT_APPLICABLE',
            protected_files: [],
            protected_files_sha256: null,
            baseline_file_hashes: {},
            current_file_hashes: {},
            changed_files: [],
            violations: []
        };
    }

    const protectedFileHashes = normalizeFileHashRecord(scope?.protected_file_hashes, protectedFiles);
    const currentFileHashes = buildFileHashMap(repoRoot, protectedFiles);
    const changedFiles = protectedFiles.filter((relativePath) => {
        return protectedFileHashes[relativePath] !== currentFileHashes[relativePath];
    });
    const violations = changedFiles.length > 0
        ? [
            `Protected pre-existing workspace edits changed outside task scope: ${changedFiles.join(', ')}. ` +
            'These files were already dirty at task-mode entry, were not included in the explicit task scope, ' +
            'and no longer match the task-mode baseline. Clean/stash the local baseline drift or restart task mode ' +
            'with the intended files in scope before continuing.'
        ]
        : [];

    return {
        status: changedFiles.length > 0 ? 'DRIFT_DETECTED' : 'PASS',
        assessment: changedFiles.length > 0
            ? 'PROTECTED_LOCAL_BASELINE_DRIFT'
            : 'INFO_IGNORED_PROTECTED_LOCAL_BASELINE',
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        baseline_file_hashes: protectedFileHashes,
        current_file_hashes: currentFileHashes,
        changed_files: changedFiles,
        violations
    };
}
