import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import mutableFs from 'node:fs';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it } from 'node:test';

import {
    captureAndSuspendSplitRequiredWip,
    restoreSplitRequiredWip
} from '../../../../src/gates/split-required/split-required-wip';
import {
    applyAdvancedRestorePlan,
    buildGitApplyIncludeArgs,
    normalizeSelectedPaths,
    planAdvancedRestore,
    selectedFiles,
    validateNoSymlinkPath
} from '../../../../src/gates/split-required/split-required-wip-restore-plan';
import type {
    SplitRequiredWipManifest,
    SplitRequiredWipTrackedFileEvidence,
    SplitRequiredWipUntrackedFileEvidence
} from '../../../../src/gates/split-required/split-required-wip-contracts';
import { traceGitCommands } from '../git-command-trace';

const TASK_ID = 'T-WIP-RESTORE-PLAN';

function runGit(repoRoot: string, args: string[]): string {
    return childProcess.execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const filePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function sha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function makeRepo(onCleanup: (callback: () => void) => void): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-restore-plan-'));
    onCleanup(() => fs.rmSync(repoRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Test User']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.eol', 'lf']);
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'TASK.md', [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow | Restore plan | gpt-5.5 | 2026-06-30 | strict | Test. |`,
        ''
    ].join('\n'));
    writeFile(repoRoot, 'src/a.ts', 'export const a = 1;\n');
    writeFile(repoRoot, 'src/b.ts', 'export const b = 1;\n');
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'initial']);
    return repoRoot;
}

function writePreflight(repoRoot: string, changedFiles: string[]): string {
    const preflightPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'reviews',
        `${TASK_ID}-preflight.json`
    );
    fs.mkdirSync(path.dirname(preflightPath), { recursive: true });
    fs.writeFileSync(preflightPath, `${JSON.stringify({
        task_id: TASK_ID,
        changed_files: changedFiles,
        required_reviews: {},
        metrics: {
            changed_files_count: changedFiles.length,
            changed_lines_total: changedFiles.length
        }
    }, null, 2)}\n`, 'utf8');
    return preflightPath;
}

describe('split-required WIP restore planning', () => {
    it('keeps advanced restore Git subprocess count constant as the selected set grows', (context) => {
        const measure = (count: number) => {
            const repoRoot = makeRepo((callback) => context.after(callback));
            const changedFiles = Array.from({ length: count }, (_, index) => `src/batch file ${index}.ts`);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 1;\n`);
            }
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', `seed ${count} restore files`]);
            for (const [index, relativePath] of changedFiles.entries()) {
                writeFile(repoRoot, relativePath, `export const batch${index} = 2;\n`);
            }
            runGit(repoRoot, ['add', '--', ...changedFiles]);
            const captured = captureAndSuspendSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                preflightPath: writePreflight(repoRoot, changedFiles),
                guardKind: 'scope_budget',
                guardReason: 'advanced restore batch benchmark'
            });
            assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
            assert.ok(captured.manifest_path);
            writeFile(repoRoot, `src/child-${count}.ts`, `export const child${count} = true;\n`);
            runGit(repoRoot, ['add', '.']);
            runGit(repoRoot, ['commit', '-m', `advance after ${count} captured files`]);

            const traced = traceGitCommands(() => restoreSplitRequiredWip({
                repoRoot,
                taskId: TASK_ID,
                manifestPath: captured.manifest_path!,
                includePaths: changedFiles,
                dryRun: true
            }));
            assert.equal(traced.value.status, 'DRY_RUN_OK', traced.value.violations.join('\n'));
            return traced.commands;
        };

        const singleFileCommands = measure(1);
        const multiFileCommands = measure(12);
        assert.equal(multiFileCommands.length, singleFileCommands.length);
        assert.equal(multiFileCommands.filter((args) => args[0] === 'checkout-index').length, 1);
        assert.equal(multiFileCommands.some((args) => args[0] === 'ls-tree'), false);
        const catFileCommands = multiFileCommands.filter((args) => args[0] === 'cat-file');
        assert.ok(catFileCommands.length >= 5);
        assert.ok(catFileCommands.every((args) => (
            args.includes('--batch') || args.some((arg) => arg.startsWith('--batch-check='))
        )));
        assert.equal(multiFileCommands.some((args) => args[0] === 'ls-files'), false);
        assert.equal(
            multiFileCommands.some((args) => args[0] === 'diff' && args.includes('--name-only')),
            false
        );
    });

    it('restores selected paths while preserving unrelated unmerged index stages', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/a.ts']),
            guardKind: 'scope_budget',
            guardReason: 'unrelated conflict stage preservation'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);

        writeFile(repoRoot, 'src/child.ts', 'export const child = true;\n');
        runGit(repoRoot, ['add', 'src/child.ts']);
        runGit(repoRoot, ['commit', '-m', 'advance after capture']);
        const conflictObjectId = runGit(repoRoot, ['rev-parse', 'HEAD:src/b.ts']).trim();
        const zeroObjectId = '0'.repeat(conflictObjectId.length);
        childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'update-index', '-z', '--index-info'],
            {
                input: Buffer.from([
                    `0 ${zeroObjectId}\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 1\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 2\tsrc/b.ts\0`,
                    `100644 ${conflictObjectId} 3\tsrc/b.ts\0`
                ].join(''), 'utf8'),
                stdio: ['pipe', 'pipe', 'pipe']
            }
        );
        const conflictStagesBefore = runGit(repoRoot, ['ls-files', '--unmerged', '--stage', '--', 'src/b.ts']);

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path,
            includePaths: ['src/a.ts']
        });

        assert.equal(restored.status, 'RESTORED', restored.violations.join('\n'));
        assert.equal(fs.readFileSync(path.join(repoRoot, 'src', 'a.ts'), 'utf8'), 'export const a = 2;\n');
        assert.equal(
            runGit(repoRoot, ['ls-files', '--unmerged', '--stage', '--', 'src/b.ts']),
            conflictStagesBefore
        );
    });

    it('rejects an unstaged candidate index entry that changes a tracked file into a symlink', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-symlink-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const modifiedIndexPath = path.join(tempRoot, 'modified.index');
        fs.copyFileSync(indexPath, modifiedIndexPath);
        const environment = {
            ...process.env,
            GIT_INDEX_FILE: modifiedIndexPath
        };
        const linkBlob = childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'hash-object', '-w', '--stdin'],
            {
                encoding: 'utf8',
                input: 'missing-target\n'
            }
        ).trim();
        childProcess.execFileSync(
            'git',
            ['-C', repoRoot, 'update-index', '--add', '--cacheinfo', `120000,${linkBlob},src/a.ts`],
            {
                env: environment,
                stdio: ['ignore', 'pipe', 'pipe']
            }
        );
        const unstagedPatchPath = path.join(tempRoot, 'unstaged.patch');
        fs.writeFileSync(
            unstagedPatchPath,
            childProcess.execFileSync(
                'git',
                ['-C', repoRoot, 'diff', '--cached', '--binary', '--full-index', '--', 'src/a.ts'],
                {
                    encoding: 'utf8',
                    env: environment
                }
            ),
            'utf8'
        );
        const stagedPatchPath = path.join(tempRoot, 'staged.patch');
        fs.writeFileSync(stagedPatchPath, '', 'utf8');
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: runGit(repoRoot, ['rev-parse', 'HEAD:src/a.ts']).trim(),
            worktree_sha256: sha256(path.join(repoRoot, 'src', 'a.ts')),
            staged: false,
            unstaged: true
        };
        const manifest: SplitRequiredWipManifest = {
            schema_version: 1,
            kind: 'split_required_wip',
            status: 'suspended',
            task_id: TASK_ID,
            guard_kind: 'scope_budget',
            guard_reason: 'candidate symlink validation',
            created_at_utc: '2026-06-30T00:00:00.000Z',
            base_commit: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            preflight_path: '',
            preflight_sha256: '',
            patches: {
                staged: {
                    path: stagedPatchPath,
                    sha256: sha256(stagedPatchPath),
                    bytes: 0,
                    empty: true
                },
                unstaged: {
                    path: unstagedPatchPath,
                    sha256: sha256(unstagedPatchPath),
                    bytes: fs.statSync(unstagedPatchPath).size,
                    empty: false
                }
            },
            tracked_files: [trackedFile],
            untracked_files: [],
            unrelated_untracked_files: [],
            ignored_runtime_artifacts: [],
            restore_commands: {
                list: '',
                preview_full: '',
                restore_full: '',
                preview_partial_template: '',
                restore_partial_template: '',
                retire: ''
            }
        };

        const result = planAdvancedRestore(
            repoRoot,
            manifest,
            new Set(['src/a.ts']),
            [trackedFile]
        );
        if (result.plan) {
            fs.rmSync(result.plan.tempRoot, { recursive: true, force: true });
        }

        assert.equal(result.plan, null);
        assert.ok(result.violations.some((violation) => violation.includes(
            'candidate index target is a symbolic link: src/a.ts'
        )));
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('normalizes selected paths and treats Git apply includes as literals', () => {
        const selectedPaths = normalizeSelectedPaths([
            '\\src\\file[1].ts',
            'src/file[1].ts',
            'src/other?.ts'
        ]);

        assert.deepEqual([...selectedPaths], ['src/file[1].ts', 'src/other?.ts']);
        assert.deepEqual(buildGitApplyIncludeArgs(selectedPaths), [
            '--include=src/file\\[1\\].ts',
            '--include=src/other\\?.ts'
        ]);
        assert.deepEqual(
            selectedFiles([{ path: 'src/file[1].ts' }, { path: 'src/b.ts' }], selectedPaths),
            [{ path: 'src/file[1].ts' }]
        );
    });

    it('restores the index and selected files when atomic index promotion fails', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-candidate-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const originalFileSha256 = sha256(path.join(repoRoot, 'src', 'a.ts'));
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: path.join(tempRoot, 'missing-candidate.index'),
            candidateWorktreeRoot,
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([['src/a.ts', originalFileSha256]])
        }, [trackedFile], []);

        assert.equal(violations.length, 1);
        assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
        assert.equal(sha256(indexPath), originalIndexSha256);
        assert.equal(sha256(path.join(repoRoot, 'src', 'a.ts')), originalFileSha256);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('removes staged candidate files when target replacement fails before rename', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-candidate-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const candidateWorktreeRoot = path.join(tempRoot, 'worktree');
        writeFile(candidateWorktreeRoot, 'src/a.ts', 'export const a = 2;\n');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const targetPath = path.join(repoRoot, 'src', 'a.ts');
        const originalFileSha256 = sha256(targetPath);
        const token = path.basename(tempRoot);
        const stagedPath = `${targetPath}.garda-${token}.tmp`;
        const originalRenameSync = mutableFs.renameSync;
        context.mock.method(mutableFs, 'renameSync', (
            sourcePath: fs.PathLike,
            destinationPath: fs.PathLike
        ) => {
            if (path.resolve(String(sourcePath)) === path.resolve(stagedPath)) {
                throw new Error('injected target replacement failure');
            }
            originalRenameSync(sourcePath, destinationPath);
        });
        const trackedFile: SplitRequiredWipTrackedFileEvidence = {
            path: 'src/a.ts',
            head_sha256: originalFileSha256,
            worktree_sha256: originalFileSha256,
            staged: true,
            unstaged: false
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: indexPath,
            candidateWorktreeRoot,
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([['src/a.ts', originalFileSha256]])
        }, [trackedFile], []);

        assert.equal(violations.length, 1);
        assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
        assert.equal(fs.existsSync(stagedPath), false);
        assert.equal(sha256(indexPath), originalIndexSha256);
        assert.equal(sha256(targetPath), originalFileSha256);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });

    it('rejects dangling symlinks even when their targets do not exist', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const linkPath = path.join(repoRoot, 'src', 'dangling.ts');
        fs.symlinkSync(
            path.join(repoRoot, 'missing-symlink-target'),
            linkPath,
            process.platform === 'win32' ? 'junction' : 'file'
        );

        assert.equal(fs.existsSync(linkPath), false);
        assert.equal(fs.lstatSync(linkPath).isSymbolicLink(), true);
        assert.deepEqual(
            validateNoSymlinkPath(repoRoot, 'src/dangling.ts'),
            ['selected restore path contains a symbolic link: src/dangling.ts']
        );
    });

    it('blocks ordinary untracked restore through a symlinked ancestor', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-restore-external-'));
        context.after(() => fs.rmSync(externalRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        writeFile(repoRoot, 'src/linked/new.ts', 'export const escaped = true;\n');
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/linked/new.ts']),
            guardKind: 'scope_budget',
            guardReason: 'ordinary restore symlink boundary'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        fs.rmSync(path.join(repoRoot, 'src', 'linked'), { recursive: true, force: true });
        fs.symlinkSync(
            externalRoot,
            path.join(repoRoot, 'src', 'linked'),
            process.platform === 'win32' ? 'junction' : 'dir'
        );

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.ok(restored.violations.some((violation) => violation.includes('symbolic link')));
        assert.equal(fs.existsSync(path.join(externalRoot, 'new.ts')), false);
    });

    it('rechecks untracked artifact integrity immediately before advanced restore apply', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-wip-plan-artifact-'));
        context.after(() => fs.rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
        const artifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'wip',
            'new.ts'
        );
        writeFile(repoRoot, path.relative(repoRoot, artifactPath), 'export const original = true;\n');
        const expectedSha256 = sha256(artifactPath);
        fs.writeFileSync(artifactPath, 'export const tampered = true;\n', 'utf8');
        const gitIndexPath = runGit(repoRoot, ['rev-parse', '--git-path', 'index']).trim();
        const indexPath = path.isAbsolute(gitIndexPath)
            ? path.resolve(gitIndexPath)
            : path.resolve(repoRoot, gitIndexPath);
        const originalIndexSha256 = sha256(indexPath);
        const targetPath = path.join(repoRoot, 'src', 'new.ts');
        const untrackedFile: SplitRequiredWipUntrackedFileEvidence = {
            path: 'src/new.ts',
            artifact_path: artifactPath,
            sha256: expectedSha256,
            bytes: Buffer.byteLength('export const original = true;\n')
        };

        const violations = applyAdvancedRestorePlan(repoRoot, {
            tempRoot,
            candidateIndexPath: indexPath,
            candidateWorktreeRoot: path.join(tempRoot, 'worktree'),
            currentHead: runGit(repoRoot, ['rev-parse', 'HEAD']).trim(),
            currentIndexSha256: originalIndexSha256,
            targetSha256: new Map([['src/new.ts', null]])
        }, [], [untrackedFile]);

        assert.equal(violations.length, 1);
        assert.match(violations[0], /^three-way restore failed without retained mutations:/u);
        assert.match(violations[0], /sha256 mismatch/u);
        assert.equal(fs.existsSync(targetPath), false);
        assert.equal(sha256(indexPath), originalIndexSha256);
        assert.deepEqual(
            fs.readdirSync(path.dirname(targetPath)).filter((name) => name.includes('.garda-')),
            []
        );
    });

    it('reports a stable patch failure without mutating the suspended workspace', (context) => {
        const repoRoot = makeRepo((callback) => context.after(callback));
        writeFile(repoRoot, 'src/a.ts', 'export const a = 2;\n');
        runGit(repoRoot, ['add', 'src/a.ts']);
        const captured = captureAndSuspendSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            preflightPath: writePreflight(repoRoot, ['src/a.ts']),
            guardKind: 'scope_budget',
            guardReason: 'restore plan characterization'
        });
        assert.equal(captured.status, 'CAPTURED', captured.violations.join('\n'));
        assert.ok(captured.manifest_path);
        const manifest = JSON.parse(fs.readFileSync(captured.manifest_path, 'utf8')) as SplitRequiredWipManifest;
        const patchPath = manifest.patches.staged.path;
        fs.writeFileSync(patchPath, 'not a patch\n', 'utf8');
        manifest.patches.staged.sha256 = sha256(patchPath);
        manifest.patches.staged.bytes = fs.statSync(patchPath).size;
        manifest.patches.staged.empty = false;
        fs.writeFileSync(captured.manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

        const restored = restoreSplitRequiredWip({
            repoRoot,
            taskId: TASK_ID,
            manifestPath: captured.manifest_path
        });

        assert.equal(restored.status, 'BLOCKED');
        assert.deepEqual(restored.restored_files, []);
        assert.equal(restored.violations.length, 1);
        assert.match(restored.violations[0], /^patch restore failed:/u);
        assert.equal(runGit(repoRoot, ['status', '--short']).trim(), '');
    });
});
