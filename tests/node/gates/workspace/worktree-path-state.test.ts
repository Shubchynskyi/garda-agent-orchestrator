import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { getSafeWorktreePathState } from '../../../../src/gates/workspace/worktree-path-state';

describe('worktree path state', () => {
    it('keeps content hashing enabled by default and lets bounded callers disable it', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            const relativePath = 'tracked.txt';
            fs.writeFileSync(path.join(repoRoot, relativePath), 'reviewable content\n', 'utf8');

            const defaultState = getSafeWorktreePathState(repoRoot, relativePath);
            const metadataOnlyState = getSafeWorktreePathState(repoRoot, relativePath, {
                includeContentHashes: false
            });

            assert.equal(defaultState.status, 'file');
            assert.match(defaultState.sha256 || '', /^[0-9a-f]{64}$/u);
            assert.deepEqual(metadataOnlyState, {
                status: 'file',
                mode: defaultState.mode,
                size: defaultState.size,
                sha256: null
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('lets bounded callers disable content hashing for symlink targets', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            const targetPath = 'target.txt';
            const linkPath = 'link.txt';
            fs.writeFileSync(path.join(repoRoot, targetPath), 'reviewable content\n', 'utf8');
            try {
                fs.symlinkSync(targetPath, path.join(repoRoot, linkPath), 'file');
            } catch {
                t.skip('File symlink creation is unavailable in this Windows environment.');
                return;
            }

            const defaultState = getSafeWorktreePathState(repoRoot, linkPath);
            const metadataOnlyState = getSafeWorktreePathState(repoRoot, linkPath, {
                includeContentHashes: false
            });

            assert.equal(defaultState.status, 'symbolic_link');
            assert.equal(defaultState.target_status, 'file');
            assert.match(defaultState.target_sha256 || '', /^[0-9a-f]{64}$/u);
            assert.equal(metadataOnlyState.status, 'symbolic_link');
            assert.equal(metadataOnlyState.target_status, 'file');
            assert.equal(metadataOnlyState.target_sha256, null);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('distinguishes non-missing filesystem failures only for opted-in callers', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            const invalidPath = `invalid\0path`;

            assert.deepEqual(getSafeWorktreePathState(repoRoot, invalidPath), {
                status: 'missing'
            });
            assert.deepEqual(getSafeWorktreePathState(repoRoot, invalidPath, {
                distinguishAccessErrors: true
            }), {
                status: 'unreviewable'
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('continues to classify genuinely absent paths as missing for opted-in callers', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            assert.deepEqual(getSafeWorktreePathState(repoRoot, 'absent.txt', {
                distinguishAccessErrors: true
            }), {
                status: 'missing'
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('continues to classify ENOTDIR paths as missing for opted-in callers', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'regular-file'), 'content\n', 'utf8');

            assert.deepEqual(getSafeWorktreePathState(repoRoot, 'regular-file/child.txt', {
                distinguishAccessErrors: true
            }), {
                status: 'missing'
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('distinguishes an unreviewable symlink target from a broken symlink for opted-in callers', (t) => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-worktree-state-'));
        try {
            const relativePath = 'loop.txt';
            try {
                fs.symlinkSync(relativePath, path.join(repoRoot, relativePath), 'file');
            } catch {
                t.skip('File symlink creation is unavailable in this Windows environment.');
                return;
            }

            const defaultState = getSafeWorktreePathState(repoRoot, relativePath);
            const failClosedState = getSafeWorktreePathState(repoRoot, relativePath, {
                distinguishAccessErrors: true
            });

            assert.equal(defaultState.status, 'symbolic_link');
            assert.equal(defaultState.target_status, 'missing');
            assert.equal(failClosedState.status, 'symbolic_link');
            assert.equal(failClosedState.target_status, 'unreviewable');
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
