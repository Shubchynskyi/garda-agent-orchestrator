import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    captureDirtyWorkspaceBaseline,
    detectProtectedDirtyWorkspaceDrift,
    deriveProtectedDirtyWorkspaceScope,
    deriveTaskOwnedDirtyWorkspaceScope,
    getProtectedDirtyWorkspaceScopeFromPreflight,
    getTaskOwnedDirtyWorkspaceFilesFromPreflight,
    getUntouchedDirtyWorkspaceBaselineFilesFromPreflight
} from '../../../../src/gates/workspace/dirty-worktree-protection';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';

function runGit(repoRoot: string, args: string[]): void {
    execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
}

function createBaselineRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dirty-ownership-'));
    writeFile(repoRoot, '.gitignore', 'src/ignored-local.ts\n');
    writeFile(repoRoot, 'src/app.ts', 'export const app = "initial";\n');
    writeFile(repoRoot, 'src/renamed-source.ts', 'export const renamed = "initial";\n');
    writeFile(repoRoot, 'src/recreated.ts', 'export const recreated = "initial";\n');
    writeFile(repoRoot, 'src/untouched.ts', 'export const untouched = "initial";\n');
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'tests@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);
    return repoRoot;
}

describe('gates/workspace/dirty-worktree-protection', () => {
    it('reads only repo-bound task-owned and untouched baseline paths from preflight triggers', () => {
        const repoRoot = createBaselineRepo();
        const preflight = {
            triggers: {
                dirty_workspace_task_owned_files: [
                    'src/task.ts',
                    'src/task.ts',
                    'src\\nested.ts',
                    '../outside.ts',
                    path.resolve(repoRoot, '..', 'outside-absolute.ts')
                ],
                dirty_workspace_untouched_baseline_files: ['src/local.ts', 'src/local.ts', '../outside.ts'],
                dirty_workspace_protected_files: ['src/local.ts', '../outside.ts'],
                dirty_workspace_protected_file_hashes: {
                    'src/local.ts': 'local-hash',
                    '../outside.ts': 'outside-hash'
                }
            }
        };

        try {
            assert.deepEqual(getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot, preflight), [
                'src/nested.ts',
                'src/task.ts'
            ]);
            assert.deepEqual(
                getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot, preflight),
                ['src/local.ts']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('derives ownership from explicit selection and entry-time dirty deltas without taking untouched baseline files', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            writeFile(repoRoot, 'src/renamed-source.ts', 'export const renamed = "dirty baseline";\n');
            writeFile(repoRoot, 'src/recreated.ts', 'export const recreated = "dirty baseline";\n');
            writeFile(repoRoot, 'src/untouched.ts', 'export const untouched = "dirty baseline";\n');
            writeFile(repoRoot, 'src/untracked.ts', 'export const untracked = "dirty baseline";\n');
            writeFile(repoRoot, 'src/ignored-local.ts', 'export const ignored = "dirty baseline";\n');

            const baseline = captureDirtyWorkspaceBaseline(repoRoot, [
                'src/app.ts',
                'src/ignored-local.ts'
            ]);

            assert.deepEqual(baseline.entry_authorized_files, ['src/app.ts', 'src/ignored-local.ts']);
            assert.ok(baseline.changed_files.includes('src/ignored-local.ts'));

            fs.renameSync(
                path.join(repoRoot, 'src/renamed-source.ts'),
                path.join(repoRoot, 'src/renamed-target.ts')
            );
            fs.rmSync(path.join(repoRoot, 'src/recreated.ts'));
            writeFile(repoRoot, 'src/recreated.ts', 'export const recreated = "task replacement";\n');
            writeFile(repoRoot, 'src/untracked.ts', 'export const untracked = "task update";\n');
            writeFile(repoRoot, 'src/ignored-local.ts', 'export const ignored = "task update";\n');

            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                [
                    'src/app.ts',
                    'src/renamed-source.ts',
                    'src/renamed-target.ts',
                    'src/recreated.ts',
                    'src/untracked.ts'
                ],
                {
                    isExplicitTaskScope: true,
                    plannedChangedFiles: ['src/app.ts', 'src/ignored-local.ts']
                }
            );

            assert.ok(taskOwnedScope);
            assert.deepEqual(taskOwnedScope.owned_files, [
                'src/app.ts',
                'src/ignored-local.ts',
                'src/recreated.ts',
                'src/renamed-source.ts',
                'src/renamed-target.ts',
                'src/untracked.ts'
            ]);
            assert.deepEqual(taskOwnedScope.explicitly_selected_preexisting_files, [
                'src/app.ts',
                'src/recreated.ts',
                'src/renamed-source.ts',
                'src/untracked.ts'
            ]);
            assert.deepEqual(taskOwnedScope.untouched_preexisting_files, ['src/untouched.ts']);
            assert.deepEqual(
                deriveProtectedDirtyWorkspaceScope(repoRoot, baseline, taskOwnedScope.owned_files)?.protected_files,
                ['src/untouched.ts']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('owns a pre-existing dirty file deleted by the task without taking untouched baseline files', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "dirty baseline";\n');
            writeFile(repoRoot, 'src/untouched.ts', 'export const untouched = "dirty baseline";\n');
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);

            fs.rmSync(path.join(repoRoot, 'src/app.ts'));

            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                ['src/app.ts']
            );

            assert.ok(taskOwnedScope);
            assert.deepEqual(taskOwnedScope.owned_files, ['src/app.ts']);
            assert.deepEqual(taskOwnedScope.owned_preexisting_files, ['src/app.ts']);
            assert.deepEqual(taskOwnedScope.delta_changed_preexisting_files, ['src/app.ts']);
            assert.deepEqual(taskOwnedScope.explicitly_selected_preexisting_files, []);
            assert.deepEqual(taskOwnedScope.untouched_preexisting_files, ['src/untouched.ts']);
            assert.deepEqual(
                deriveProtectedDirtyWorkspaceScope(repoRoot, baseline, taskOwnedScope.owned_files)?.protected_files,
                ['src/untouched.ts']
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('batches tracked planned paths while retaining existing ignored planned files', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/ignored-local.ts', 'export const ignored = "baseline";\n');

            const baseline = captureDirtyWorkspaceBaseline(repoRoot, [
                'src/app.ts',
                'src/renamed-source.ts',
                'src/recreated.ts',
                'src/untouched.ts',
                'src/ignored-local.ts'
            ]);

            assert.deepEqual(baseline.changed_files, ['src/ignored-local.ts']);
            assert.deepEqual(baseline.entry_authorized_files, ['src/ignored-local.ts']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('owns both sides of a staged rename for a file that was dirty at task entry', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/renamed-source.ts', 'export const renamed = "dirty baseline";\n');
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);

            runGit(repoRoot, ['mv', 'src/renamed-source.ts', 'src/staged-target.ts']);
            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.deepEqual(stagedSnapshot.changed_files, ['src/staged-target.ts']);
            assert.ok(taskOwnedScope);
            assert.deepEqual(taskOwnedScope.owned_files, [
                'src/renamed-source.ts',
                'src/staged-target.ts'
            ]);
            assert.deepEqual(taskOwnedScope.delta_changed_preexisting_files, ['src/renamed-source.ts']);
            assert.deepEqual(taskOwnedScope.untouched_preexisting_files, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects traversal, absolute, and external-symlink evidence paths before hashing', (t) => {
        const repoRoot = createBaselineRepo();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dirty-ownership-outside-'));
        try {
            const outsideFile = path.join(outsideRoot, 'secret.ts');
            fs.writeFileSync(outsideFile, 'export const secret = "outside";\n', 'utf8');
            const externalLink = path.join(repoRoot, 'src', 'external-link.ts');
            try {
                fs.symlinkSync(outsideFile, externalLink, 'file');
            } catch {
                t.skip('Creating a file symlink is unavailable in this environment.');
                return;
            }
            const traversalPath = path.relative(repoRoot, outsideFile).replace(/\\/g, '/');
            const absolutePath = path.resolve(outsideFile);
            const baseline = {
                detection_source: 'git_auto',
                include_untracked: true,
                changed_files: [traversalPath, absolutePath, 'src/external-link.ts'],
                changed_files_sha256: 'untrusted',
                scope_sha256: null,
                file_hashes: {
                    [traversalPath]: 'outside-hash',
                    [absolutePath]: 'outside-hash',
                    'src/external-link.ts': 'outside-hash'
                }
            };

            const ownedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                [traversalPath, absolutePath, 'src/external-link.ts'],
                { isExplicitTaskScope: true }
            );
            const protectedScope = deriveProtectedDirtyWorkspaceScope(repoRoot, baseline, []);
            const drift = detectProtectedDirtyWorkspaceDrift(repoRoot, {
                protected_files: [traversalPath, absolutePath, 'src/external-link.ts'],
                protected_files_sha256: 'untrusted',
                protected_file_hashes: baseline.file_hashes
            });

            assert.ok(ownedScope);
            assert.deepEqual(ownedScope.owned_files, []);
            assert.deepEqual(ownedScope.current_file_hashes, {});
            assert.deepEqual(protectedScope?.protected_files, []);
            assert.equal(drift.status, 'NOT_APPLICABLE');
            const preflight = {
                triggers: {
                    dirty_workspace_task_owned_files: [traversalPath, absolutePath, 'src/external-link.ts'],
                    dirty_workspace_untouched_baseline_files: [traversalPath, absolutePath, 'src/external-link.ts'],
                    dirty_workspace_protected_files: [traversalPath, absolutePath, 'src/external-link.ts'],
                    dirty_workspace_protected_file_hashes: baseline.file_hashes
                }
            };
            assert.deepEqual(getTaskOwnedDirtyWorkspaceFilesFromPreflight(repoRoot, preflight), []);
            assert.deepEqual(getUntouchedDirtyWorkspaceBaselineFilesFromPreflight(repoRoot, preflight), []);
            assert.equal(
                detectProtectedDirtyWorkspaceDrift(
                    repoRoot,
                    getProtectedDirtyWorkspaceScopeFromPreflight(preflight)
                ).status,
                'NOT_APPLICABLE'
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
            fs.rmSync(outsideRoot, { recursive: true, force: true });
        }
    });
});
