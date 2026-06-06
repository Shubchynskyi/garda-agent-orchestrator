import * as path from 'node:path';

import { getRepoRoot } from '../build';
import { CLEAN_WORKTREE_DIRTY_PATH_LIMIT, type CleanWorktreePreflightResult } from './types';
import { formatGitFailure, parsePorcelainDirtyPaths, runGit } from './shared';

export function validateCleanWorktreePreflight(repoRoot: string): CleanWorktreePreflightResult {
    const normalizedRoot = path.resolve(repoRoot);
    const violations: string[] = [];
    const remediation = 'Commit intentional changes or explicitly roll back/remove accidental tracked and untracked files before creating a release archive.';

    let headSha: string | null = null;
    let branchName: string | null = null;
    let detachedHead = false;
    let dirtyPaths: string[] = [];

    const headResult = runGit(normalizedRoot, ['rev-parse', '--verify', 'HEAD']);
    if (headResult.status !== 0) {
        violations.push(formatGitFailure('Cannot resolve git HEAD for release preflight', headResult));
    } else {
        headSha = String(headResult.stdout || '').trim() || null;
    }

    const branchResult = runGit(normalizedRoot, ['branch', '--show-current']);
    if (branchResult.status !== 0) {
        violations.push(formatGitFailure('Cannot resolve git branch for release preflight', branchResult));
    } else {
        branchName = String(branchResult.stdout || '').trim() || null;
        detachedHead = branchName === null;
    }

    const statusResult = runGit(normalizedRoot, [
        '-c',
        'core.quotepath=false',
        'status',
        '--porcelain=v1',
        '--untracked-files=all'
    ]);
    if (statusResult.status !== 0) {
        violations.push(formatGitFailure('Cannot inspect git worktree status for release preflight', statusResult));
    } else {
        dirtyPaths = parsePorcelainDirtyPaths(String(statusResult.stdout || ''));
        if (dirtyPaths.length > 0) {
            violations.push(`Release worktree must be clean; found ${dirtyPaths.length} dirty path(s).`);
        }
    }

    return {
        passed: violations.length === 0,
        repoRoot: normalizedRoot,
        headSha,
        branchName,
        detachedHead,
        dirtyPaths,
        violations,
        remediation
    };
}

export function formatCleanWorktreePreflightResult(result: CleanWorktreePreflightResult): string {
    const lines: string[] = [];

    lines.push(result.passed ? 'RELEASE_CLEAN_WORKTREE_OK' : 'RELEASE_CLEAN_WORKTREE_FAILED');
    lines.push(`RepoRoot: ${result.repoRoot}`);
    lines.push(`Head: ${result.headSha || 'unresolved'}`);
    lines.push(`Branch: ${result.branchName || 'DETACHED'}`);
    lines.push(`DetachedHead: ${result.detachedHead ? 'yes (allowed)' : 'no'}`);
    lines.push(`DirtyPaths: ${result.dirtyPaths.length}`);

    if (!result.passed) {
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
        const visibleDirtyPaths = result.dirtyPaths.slice(0, CLEAN_WORKTREE_DIRTY_PATH_LIMIT);
        for (const dirtyPath of visibleDirtyPaths) {
            lines.push(`  - ${dirtyPath}`);
        }
        if (result.dirtyPaths.length > visibleDirtyPaths.length) {
            lines.push(`  - ... ${result.dirtyPaths.length - visibleDirtyPaths.length} more`);
        }
        lines.push(`Remediation: ${result.remediation}`);
    }

    return lines.join('\n');
}

export function runCleanWorktreePreflight(): CleanWorktreePreflightResult {
    const result = validateCleanWorktreePreflight(getRepoRoot());
    console.log(formatCleanWorktreePreflightResult(result));
    if (!result.passed) {
        process.exit(1);
    }
    return result;
}
