import * as path from 'node:path';

import { getWorkspaceSnapshot } from '../compile/compile-gate';
import { fileSha256, normalizePath, stringSha256, toPlainRecord } from '../shared/helpers';

export interface DirtyWorkspaceBaseline {
    detection_source: string;
    include_untracked: boolean;
    changed_files: string[];
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    file_hashes: Record<string, string | null>;
}

export interface ProtectedDirtyWorkspaceScope {
    protected_files: string[];
    protected_files_sha256: string | null;
    protected_file_hashes: Record<string, string | null>;
}

export interface ProtectedDirtyWorkspaceDriftResult {
    status: 'NOT_APPLICABLE' | 'PASS' | 'DRIFT_DETECTED';
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

function buildFileHashMap(repoRoot: string, relativePaths: string[]): Record<string, string | null> {
    const normalizedPaths = normalizeRelativePaths(relativePaths);
    const fileHashes: Record<string, string | null> = {};
    for (const relativePath of normalizedPaths) {
        fileHashes[relativePath] = fileSha256(path.join(repoRoot, relativePath));
    }
    return fileHashes;
}

export function captureDirtyWorkspaceBaseline(repoRoot: string): DirtyWorkspaceBaseline {
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
            file_hashes: {}
        };
    }
    return {
        detection_source: snapshot.detection_source,
        include_untracked: !!snapshot.include_untracked,
        changed_files: [...snapshot.changed_files],
        changed_files_sha256: snapshot.changed_files_sha256,
        scope_sha256: snapshot.scope_sha256,
        file_hashes: buildFileHashMap(repoRoot, snapshot.changed_files)
    };
}

export function normalizeDirtyWorkspaceBaseline(value: unknown): DirtyWorkspaceBaseline | null {
    const baseline = toPlainRecord(value);
    if (!baseline) {
        return null;
    }
    const changedFiles = normalizeRelativePaths(baseline.changed_files);
    return {
        detection_source: String(baseline.detection_source || 'git_auto').trim() || 'git_auto',
        include_untracked: baseline.include_untracked == null ? true : !!baseline.include_untracked,
        changed_files: changedFiles,
        changed_files_sha256: String(
            baseline.changed_files_sha256 || stringSha256(changedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        scope_sha256: String(baseline.scope_sha256 || '').trim().toLowerCase() || null,
        file_hashes: normalizeFileHashRecord(baseline.file_hashes, changedFiles)
    };
}

export function deriveProtectedDirtyWorkspaceScope(
    baseline: DirtyWorkspaceBaseline | null,
    taskScopeChangedFiles: string[]
): ProtectedDirtyWorkspaceScope | null {
    if (!baseline) {
        return null;
    }
    const scopeFiles = new Set(normalizeRelativePaths(taskScopeChangedFiles));
    const protectedFiles = baseline.changed_files.filter((relativePath) => !scopeFiles.has(relativePath)).sort();
    return {
        protected_files: protectedFiles,
        protected_files_sha256: stringSha256(protectedFiles.join('\n')),
        protected_file_hashes: normalizeFileHashRecord(baseline.file_hashes, protectedFiles)
    };
}

export function normalizeProtectedDirtyWorkspaceScope(value: unknown): ProtectedDirtyWorkspaceScope | null {
    const scope = toPlainRecord(value);
    if (!scope) {
        return null;
    }
    const protectedFiles = normalizeRelativePaths(scope.protected_files);
    return {
        protected_files: protectedFiles,
        protected_files_sha256: String(
            scope.protected_files_sha256 || stringSha256(protectedFiles.join('\n')) || ''
        ).trim().toLowerCase() || null,
        protected_file_hashes: normalizeFileHashRecord(scope.protected_file_hashes, protectedFiles)
    };
}

export function getProtectedDirtyWorkspaceScopeFromPreflight(preflight: unknown): ProtectedDirtyWorkspaceScope | null {
    const preflightObject = toPlainRecord(preflight);
    const triggers = preflightObject ? toPlainRecord(preflightObject.triggers) : null;
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
    if (!scope || scope.protected_files.length === 0) {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: [],
            protected_files_sha256: null,
            baseline_file_hashes: {},
            current_file_hashes: {},
            changed_files: [],
            violations: []
        };
    }

    const currentFileHashes = buildFileHashMap(repoRoot, scope.protected_files);
    const changedFiles = scope.protected_files.filter((relativePath) => {
        return scope.protected_file_hashes[relativePath] !== currentFileHashes[relativePath];
    });
    const violations = changedFiles.length > 0
        ? [
            `Protected pre-existing workspace edits changed outside task scope: ${changedFiles.join(', ')}. ` +
            'These files were already dirty at task-mode entry and were not included in the explicit task scope.'
        ]
        : [];

    return {
        status: changedFiles.length > 0 ? 'DRIFT_DETECTED' : 'PASS',
        protected_files: [...scope.protected_files],
        protected_files_sha256: scope.protected_files_sha256,
        baseline_file_hashes: { ...scope.protected_file_hashes },
        current_file_hashes: currentFileHashes,
        changed_files: changedFiles,
        violations
    };
}
