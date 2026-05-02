import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getWorkspaceSnapshot } from '../../../src/gates/compile-gate';
import { computeCodeReviewScopeFingerprint } from '../../../src/gates/review-reuse';
import {
    assertReviewTreeStateFresh,
    buildReviewTreeState,
    createReviewTreeStateFreshnessCache,
    getReviewTreeStateFreshnessCacheStats
} from '../../../src/gates/review-tree-state';
import { computeSnapshotFingerprint } from '../../../src/gates/workspace-snapshot-cache';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    });
    assert.equal(result.status, 0, String(result.stderr || result.error || 'git command failed'));
}

describe('gates/review-tree-state', () => {
    it('shares current freshness snapshots across repeated review artifact checks', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-cache-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
            runGit(repoRoot, ['add', 'src/app.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

            const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', false, ['src/app.ts']);
            const treeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: false,
                changedFiles: snapshot.changed_files,
                metrics: {
                    changed_files_sha256: snapshot.changed_files_sha256,
                    scope_content_sha256: snapshot.scope_content_sha256,
                    scope_sha256: snapshot.scope_sha256
                }
            });
            const reviewContext = { tree_state: treeState };
            const freshnessCache = createReviewTreeStateFreshnessCache();

            assertReviewTreeStateFresh({
                repoRoot,
                reviewContext,
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-code-review-context.json'),
                gateName: 'required-reviews-check',
                freshnessCache
            });
            assert.deepEqual(getReviewTreeStateFreshnessCacheStats(freshnessCache), {
                current_scope_snapshot_count: 1,
                current_tree_state_count: 1
            });

            assertReviewTreeStateFresh({
                repoRoot,
                reviewContext,
                contextPath: path.join(repoRoot, 'runtime', 'reviews', 'T-1-security-review-context.json'),
                gateName: 'required-reviews-check',
                freshnessCache
            });
            assert.deepEqual(getReviewTreeStateFreshnessCacheStats(freshnessCache), {
                current_scope_snapshot_count: 1,
                current_tree_state_count: 1
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('binds in-repo symlink targets into review and reuse fingerprints', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-tree-state-symlink-target-'));
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
            const targetPath = path.join(repoRoot, 'src', 'target.ts');
            const linkPath = path.join(repoRoot, 'src', 'link.ts');
            fs.writeFileSync(targetPath, 'export const value = "alpha";\n', 'utf8');
            runGit(repoRoot, ['add', 'src/target.ts']);
            runGit(repoRoot, ['commit', '-m', 'baseline']);
            try {
                fs.symlinkSync(targetPath, linkPath, 'file');
            } catch (error) {
                t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const preflight = {
                detection_source: 'explicit_changed_files',
                changed_files: ['src/link.ts']
            };
            const alphaSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/link.ts']);
            const alphaTreeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: alphaSnapshot.changed_files,
                metrics: {
                    changed_files_sha256: alphaSnapshot.changed_files_sha256,
                    scope_content_sha256: alphaSnapshot.scope_content_sha256,
                    scope_sha256: alphaSnapshot.scope_sha256
                }
            });
            const alphaCacheFingerprint = computeSnapshotFingerprint(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/link.ts']
            );
            const alphaReuseScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);

            fs.writeFileSync(targetPath, 'export const value = "bravo";\n', 'utf8');

            const bravoSnapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/link.ts']);
            const bravoTreeState = buildReviewTreeState({
                repoRoot,
                detectionSource: 'explicit_changed_files',
                includeUntracked: true,
                changedFiles: bravoSnapshot.changed_files,
                metrics: {
                    changed_files_sha256: bravoSnapshot.changed_files_sha256,
                    scope_content_sha256: bravoSnapshot.scope_content_sha256,
                    scope_sha256: bravoSnapshot.scope_sha256
                }
            });
            const bravoCacheFingerprint = computeSnapshotFingerprint(
                repoRoot,
                'explicit_changed_files',
                true,
                ['src/link.ts']
            );
            const bravoReuseScope = computeCodeReviewScopeFingerprint(preflight, repoRoot);

            assert.equal(alphaTreeState.entries[0]?.worktree.status, 'symbolic_link');
            assert.equal(alphaTreeState.entries[0]?.worktree.target_status, 'file');
            assert.equal(alphaTreeState.entries[0]?.worktree.target_path, 'src/target.ts');
            assert.match(String(alphaTreeState.entries[0]?.worktree.target_sha256 || ''), /^[0-9a-f]{64}$/);
            assert.notEqual(bravoTreeState.tree_state_sha256, alphaTreeState.tree_state_sha256);
            assert.notEqual(bravoSnapshot.scope_content_sha256, alphaSnapshot.scope_content_sha256);
            assert.notEqual(bravoCacheFingerprint.fingerprint, alphaCacheFingerprint.fingerprint);
            assert.notEqual(bravoReuseScope.code_scope_sha256, alphaReuseScope.code_scope_sha256);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
