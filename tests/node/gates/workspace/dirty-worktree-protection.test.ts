import { describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as gitChangeClassification from '../../../../src/core/git-change-classification';
import { DEFAULT_GIT_TIMEOUT_MS } from '../../../../src/core/subprocess';
import {
    buildStagedBaselineTrustInputFingerprint,
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

function readGit(repoRoot: string, args: string[]): string {
    return execFileSync('git', ['-C', repoRoot, ...args], {
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
    it('passes the shared finite Git timeout to mandatory baseline classification', () => {
        const repoRoot = createBaselineRepo();
        const observedTimeouts: Array<number | undefined> = [];
        const originalClassifyGitChanges = gitChangeClassification.classifyGitChanges;
        const classifyMock = mock.method(
            gitChangeClassification,
            'classifyGitChanges',
            ((...args: Parameters<typeof originalClassifyGitChanges>) => {
                observedTimeouts.push(args[1]?.timeoutMs);
                return originalClassifyGitChanges(...args);
            }) as typeof originalClassifyGitChanges
        );
        try {
            captureDirtyWorkspaceBaseline(repoRoot);

            assert.deepEqual(observedTimeouts, [DEFAULT_GIT_TIMEOUT_MS]);
        } finally {
            classifyMock.mock.restore();
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

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
            assert.ok(baseline.git_change_classification);
            assert.deepEqual(
                baseline.git_change_classification.effective_changed_files,
                baseline.changed_files.filter((entry) => entry !== 'src/ignored-local.ts')
            );
            assert.deepEqual(baseline.git_change_classification.ignored_eol_only_files, []);

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

    it('authenticates a valid staged dirty baseline without exposing raw staged object ids or content', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const rawStagedIndex = readGit(repoRoot, ['ls-files', '-s', '--', 'src/app.ts']);
            const rawObjectId = rawStagedIndex.trim().split(/\s+/)[1];
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);

            assert.deepEqual(baseline.staged_files, ['src/app.ts']);
            assert.ok(baseline.staged_trust?.files['src/app.ts']);
            const serializedTrust = JSON.stringify(baseline.staged_trust);
            assert.ok(rawObjectId);
            assert.equal(serializedTrust.includes(rawObjectId), false);
            assert.equal(serializedTrust.includes('staged baseline'), false);

            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'PASS');
            assert.deepEqual(taskOwnedScope.staged_baseline_trust_violations, []);
            assert.deepEqual(taskOwnedScope.owned_files, ['src/app.ts']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('authenticates a valid staged deletion dirty baseline without requiring a live index blob', () => {
        const repoRoot = createBaselineRepo();
        try {
            runGit(repoRoot, ['rm', 'src/recreated.ts']);
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);

            assert.deepEqual(baseline.staged_files, ['src/recreated.ts']);
            assert.equal(baseline.staged_trust?.files['src/recreated.ts']?.status, 'deleted');
            assert.ok(baseline.staged_trust?.files['src/recreated.ts']?.object_id_sha256);
            assert.equal(JSON.stringify(baseline.staged_trust).includes('export const recreated'), false);

            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'PASS');
            assert.deepEqual(taskOwnedScope.staged_baseline_trust_violations, []);
            assert.deepEqual(taskOwnedScope.owned_files, ['src/recreated.ts']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fingerprints staged trust inputs so scoped caches invalidate when evidence changes', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);

            const initialFingerprint = buildStagedBaselineTrustInputFingerprint(baseline, repoRoot);
            assert.match(String(initialFingerprint), /^[0-9a-f]{64}$/);

            const changedSaltBaseline = JSON.parse(JSON.stringify(baseline));
            changedSaltBaseline.staged_trust.salt = 'changed-salt';
            assert.notEqual(
                buildStagedBaselineTrustInputFingerprint(changedSaltBaseline, repoRoot),
                initialFingerprint
            );

            const changedEvidenceBaseline = JSON.parse(JSON.stringify(baseline));
            changedEvidenceBaseline.staged_trust.files['src/app.ts'].object_id_sha256 = '0'.repeat(64);
            assert.notEqual(
                buildStagedBaselineTrustInputFingerprint(changedEvidenceBaseline, repoRoot),
                initialFingerprint
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects staged baseline ownership when staged trust evidence is missing', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);
            baseline.staged_trust = null;

            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'FAIL');
            assert.deepEqual(taskOwnedScope.owned_files, []);
            assert.match(taskOwnedScope.staged_baseline_trust_violations.join(' '), /Missing staged dirty-baseline trust evidence/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects staged baseline ownership when any required staged trust fingerprint is missing', () => {
        const requiredFingerprintCases = [
            {
                field: 'object_id_sha256',
                violation: /object fingerprint mismatch/
            },
            {
                field: 'content_sha256',
                violation: /content fingerprint mismatch/
            },
            {
                field: 'line_fingerprint_sha256',
                violation: /line fingerprint mismatch/
            }
        ] as const;

        for (const { field, violation } of requiredFingerprintCases) {
            const repoRoot = createBaselineRepo();
            try {
                writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
                runGit(repoRoot, ['add', 'src/app.ts']);
                const baseline = captureDirtyWorkspaceBaseline(repoRoot);
                const appTrust = baseline.staged_trust?.files['src/app.ts'];
                assert.ok(appTrust);
                delete (appTrust as Partial<Record<typeof field, string>>)[field];

                const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
                const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                    repoRoot,
                    baseline,
                    stagedSnapshot.changed_files,
                    { isExplicitTaskScope: true, useStaged: true }
                );

                assert.ok(taskOwnedScope);
                assert.equal(taskOwnedScope.staged_baseline_trust_status, 'FAIL');
                assert.deepEqual(taskOwnedScope.owned_files, []);
                assert.match(taskOwnedScope.staged_baseline_trust_violations.join(' '), violation);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        }
    });

    it('rejects forged staged object fingerprints before authorizing staged baseline ownership', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);
            const appTrust = baseline.staged_trust?.files['src/app.ts'];
            assert.ok(appTrust);
            appTrust.object_id_sha256 = '0'.repeat(64);

            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'FAIL');
            assert.deepEqual(taskOwnedScope.owned_files, []);
            assert.match(taskOwnedScope.staged_baseline_trust_violations.join(' '), /object fingerprint mismatch/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects staged trust evidence when its salt changes', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "staged baseline";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);
            assert.ok(baseline.staged_trust);
            baseline.staged_trust.salt = 'changed-salt';

            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'FAIL');
            assert.deepEqual(taskOwnedScope.owned_files, []);
            assert.match(taskOwnedScope.staged_baseline_trust_violations.join(' '), /fingerprint mismatch/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps legacy non-staged dirty-baseline fallback behavior when staged trust is absent', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "dirty baseline";\n');
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);
            delete baseline.staged_trust;
            writeFile(repoRoot, 'src/app.ts', 'export const app = "task update";\n');

            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                ['src/app.ts'],
                { isExplicitTaskScope: true, useStaged: false }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'NOT_APPLICABLE');
            assert.deepEqual(taskOwnedScope.staged_baseline_trust_violations, []);
            assert.deepEqual(taskOwnedScope.owned_files, ['src/app.ts']);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not require staged trust for an unstaged dirty baseline later staged by task work', () => {
        const repoRoot = createBaselineRepo();
        try {
            writeFile(repoRoot, 'src/app.ts', 'export const app = "dirty baseline";\n');
            const baseline = captureDirtyWorkspaceBaseline(repoRoot);
            assert.deepEqual(baseline.staged_files, []);
            assert.equal(baseline.staged_trust, null);

            writeFile(repoRoot, 'src/app.ts', 'export const app = "task staged update";\n');
            runGit(repoRoot, ['add', 'src/app.ts']);
            const stagedSnapshot = getWorkspaceSnapshot(repoRoot, 'git_staged_only', false, []);
            const taskOwnedScope = deriveTaskOwnedDirtyWorkspaceScope(
                repoRoot,
                baseline,
                stagedSnapshot.changed_files,
                { isExplicitTaskScope: true, useStaged: true }
            );

            assert.ok(taskOwnedScope);
            assert.equal(taskOwnedScope.staged_baseline_trust_status, 'NOT_APPLICABLE');
            assert.deepEqual(taskOwnedScope.staged_baseline_trust_violations, []);
            assert.deepEqual(taskOwnedScope.owned_files, ['src/app.ts']);
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
