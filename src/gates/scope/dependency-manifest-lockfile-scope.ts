import {
    normalizePath
} from '../shared/helpers';

const NODE_DEPENDENCY_MANIFEST = 'package.json';
const NODE_DEPENDENCY_LOCKFILES = new Set([
    'package-lock.json',
    'npm-shrinkwrap.json',
    'pnpm-lock.yaml',
    'yarn.lock',
    'bun.lock',
    'bun.lockb'
]);

function splitDirectoryAndBasename(repoPath: string): { directory: string; basename: string } {
    const normalized = normalizePath(repoPath);
    const parts = normalized.split('/').filter(Boolean);
    const basename = parts.pop() || '';
    return {
        directory: parts.join('/'),
        basename
    };
}

function sameDirectory(left: string, right: string): boolean {
    return splitDirectoryAndBasename(left).directory === splitDirectoryAndBasename(right).directory;
}

export function isDependencyManifestLockfilePair(left: string, right: string): boolean {
    const leftPath = splitDirectoryAndBasename(left);
    const rightPath = splitDirectoryAndBasename(right);
    if (!leftPath.basename || !rightPath.basename || leftPath.directory !== rightPath.directory) {
        return false;
    }
    return (
        leftPath.basename === NODE_DEPENDENCY_MANIFEST
        && NODE_DEPENDENCY_LOCKFILES.has(rightPath.basename)
    ) || (
        rightPath.basename === NODE_DEPENDENCY_MANIFEST
        && NODE_DEPENDENCY_LOCKFILES.has(leftPath.basename)
    );
}

export function isDependencyManifestLockfileRelatedToAny(
    changedFile: string,
    plannedFiles: readonly string[]
): boolean {
    const normalizedChangedFile = normalizePath(changedFile);
    return plannedFiles.some((plannedFile) => {
        const normalizedPlannedFile = normalizePath(plannedFile);
        return normalizedPlannedFile
            && sameDirectory(normalizedChangedFile, normalizedPlannedFile)
            && isDependencyManifestLockfilePair(normalizedChangedFile, normalizedPlannedFile);
    });
}

export function expandDependencyManifestLockfileScope(
    scopeFiles: readonly string[],
    candidateChangedFiles: readonly string[]
): string[] {
    const normalizedScopeFiles = [...new Set(scopeFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    if (normalizedScopeFiles.length === 0) {
        return [];
    }
    const expanded = new Set(normalizedScopeFiles);
    const normalizedCandidates = [...new Set(candidateChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean))].sort();
    for (const candidateFile of normalizedCandidates) {
        if (isDependencyManifestLockfileRelatedToAny(candidateFile, normalizedScopeFiles)) {
            expanded.add(candidateFile);
        }
    }
    return [...expanded].sort();
}
