import * as fs from 'node:fs';
import * as path from 'node:path';

import { fileSha256, isPathInsideRoot, normalizePath, stringSha256 } from '../shared/helpers';

export type SafeWorktreePathStatus =
    | 'file'
    | 'directory'
    | 'special'
    | 'symbolic_link'
    | 'unreviewable_symlink'
    | 'outside_repo'
    | 'missing';

export interface SafeWorktreePathState {
    status: SafeWorktreePathStatus;
    mode?: number;
    size?: number;
    sha256?: string | null;
    link_sha256?: string | null;
    link_target?: string | null;
    target_path?: string | null;
    target_status?: SafeWorktreePathStatus;
    target_mode?: number;
    target_size?: number;
    target_sha256?: string | null;
}

export interface SafeWorktreePathStateOptions {
    repoRealPath?: string;
}

function resolveRepoRelativePath(repoRoot: string, relativeFile: string): string | null {
    const normalized = normalizePath(relativeFile);
    if (!normalized) {
        return null;
    }
    const resolvedRoot = path.resolve(repoRoot);
    const resolvedPath = path.resolve(resolvedRoot, normalized);
    if (!isPathInsideRoot(resolvedPath, resolvedRoot)) {
        return null;
    }
    return resolvedPath;
}

export function getSafeWorktreePathState(
    repoRoot: string,
    relativeFile: string,
    options: SafeWorktreePathStateOptions = {}
): SafeWorktreePathState {
    const resolvedPath = resolveRepoRelativePath(repoRoot, relativeFile);
    if (!resolvedPath) {
        return normalizePath(relativeFile) ? { status: 'outside_repo' } : { status: 'missing' };
    }
    try {
        const stat = fs.lstatSync(resolvedPath);
        const repoRealPath = options.repoRealPath || fs.realpathSync(repoRoot);
        if (stat.isSymbolicLink()) {
            const linkTarget = fs.readlinkSync(resolvedPath);
            const linkBase = {
                mode: stat.mode,
                size: stat.size,
                link_sha256: stringSha256(linkTarget) || null,
                link_target: linkTarget
            };
            try {
                const worktreeRealPath = fs.realpathSync(resolvedPath);
                if (!isPathInsideRoot(worktreeRealPath, repoRealPath)) {
                    return { status: 'outside_repo' };
                }
                const targetStat = fs.statSync(resolvedPath);
                const targetPath = normalizePath(path.relative(repoRealPath, worktreeRealPath)) || null;
                const targetBase = {
                    ...linkBase,
                    target_path: targetPath,
                    target_mode: targetStat.mode,
                    target_size: targetStat.size
                };
                if (targetStat.isFile()) {
                    return {
                        ...targetBase,
                        status: 'symbolic_link',
                        target_status: 'file',
                        target_sha256: fileSha256(worktreeRealPath) || null
                    };
                }
                return {
                    ...targetBase,
                    status: 'unreviewable_symlink',
                    target_status: targetStat.isDirectory() ? 'directory' : 'special'
                };
            } catch {
                // Broken symlinks have no target content to hash; keep the link text reviewable.
                return {
                    ...linkBase,
                    status: 'symbolic_link',
                    target_status: 'missing'
                };
            }
        }
        const worktreeRealPath = fs.realpathSync(resolvedPath);
        if (!isPathInsideRoot(worktreeRealPath, repoRealPath)) {
            return { status: 'outside_repo' };
        }
        const base = {
            mode: stat.mode,
            size: stat.size
        };
        if (stat.isFile()) {
            return {
                ...base,
                status: 'file',
                sha256: fileSha256(resolvedPath) || null
            };
        }
        if (stat.isDirectory()) {
            return { ...base, status: 'directory' };
        }
        return { ...base, status: 'special' };
    } catch {
        return { status: 'missing' };
    }
}
