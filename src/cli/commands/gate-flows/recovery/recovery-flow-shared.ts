import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizeDirtyWorkspaceBaseline } from '../../../../gates/workspace/dirty-worktree-protection';

export function normalizeChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => gateHelpers.normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}

export function excludeUnchangedDirtyWorkspaceBaselineFiles(
    repoRoot: string,
    changedFiles: readonly unknown[],
    dirtyWorkspaceBaseline: unknown
): string[] {
    const normalizedChangedFiles = normalizeChangedFiles(changedFiles);
    const normalizedBaseline = normalizeDirtyWorkspaceBaseline(dirtyWorkspaceBaseline, repoRoot);
    if (!normalizedBaseline) {
        return normalizedChangedFiles;
    }
    const unchangedBaselineFiles = new Set(normalizedBaseline.changed_files.filter((relativePath) => {
        const expectedHash = normalizedBaseline.file_hashes[relativePath];
        const absolutePath = path.join(repoRoot, ...relativePath.split('/'));
        return !!expectedHash
            && /^[a-f0-9]{64}$/u.test(expectedHash)
            && fs.existsSync(absolutePath)
            && fs.statSync(absolutePath).isFile()
            && gateHelpers.fileSha256(absolutePath) === expectedHash;
    }));
    return normalizedChangedFiles.filter((entry) => !unchangedBaselineFiles.has(entry));
}
