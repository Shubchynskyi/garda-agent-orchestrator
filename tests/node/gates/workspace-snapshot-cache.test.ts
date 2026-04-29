import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    computeSnapshotFingerprint,
    getWorkspaceSnapshotCached,
    invalidateSnapshotCache,
    readHeadSha,
    readSnapshotCache,
    resolveSnapshotCachePath,
    statGitIndex,
    writeSnapshotCache
} from '../../../src/gates/workspace-snapshot-cache';
import type { WorkspaceSnapshotCacheEntry } from '../../../src/gates/workspace-snapshot-cache';

function initTestRepo(): string {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-cache-'));
    const repoRoot = path.join(tempDir, 'repo');
    fs.mkdirSync(repoRoot, { recursive: true });
    execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
    fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 1;\n', 'utf8');
    execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
    execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'init'], { stdio: 'ignore' });
    return tempDir;
}

function cleanupTestRepo(tempDir: string): void {
    try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

describe('gates/workspace-snapshot-cache', () => {
    let tempDir: string;
    let repoRoot: string;

    beforeEach(() => {
        tempDir = initTestRepo();
        repoRoot = path.join(tempDir, 'repo');
    });

    afterEach(() => {
        cleanupTestRepo(tempDir);
    });

    describe('readHeadSha', () => {
        it('returns HEAD sha for a valid repo', () => {
            const sha = readHeadSha(repoRoot);
            assert.ok(sha, 'HEAD sha should be non-null');
            assert.match(sha, /^[0-9a-f]{40}$/);
        });

        it('returns null for non-repo directory', () => {
            const sha = readHeadSha(tempDir);
            assert.equal(sha, null);
        });
    });

    describe('statGitIndex', () => {
        it('returns non-zero mtime and size for a valid repo', () => {
            const stat = statGitIndex(repoRoot);
            assert.ok(stat.mtime_ms > 0);
            assert.ok(stat.size > 0);
        });

        it('returns zeros for non-repo directory', () => {
            const noGit = path.join(tempDir, 'nodir');
            fs.mkdirSync(noGit, { recursive: true });
            const stat = statGitIndex(noGit);
            assert.equal(stat.mtime_ms, 0);
            assert.equal(stat.size, 0);
        });
    });

    describe('computeSnapshotFingerprint', () => {
        it('returns a stable fingerprint for unchanged state', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.equal(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when HEAD moves', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'new.ts'), 'export const b = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'second'], { stdio: 'ignore' });
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when files are staged', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'staged.ts'), 'export const c = 3;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'staged.ts'], { stdio: 'ignore' });
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when tracked worktree content changes without staging', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 42;\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when untracked file content changes and includeUntracked=true', () => {
            fs.writeFileSync(path.join(repoRoot, 'draft.ts'), 'one\n', 'utf8');
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            fs.writeFileSync(path.join(repoRoot, 'draft.ts'), 'one\ntwo\nthree\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });

        it('fingerprint changes when parameters differ', () => {
            const fp1 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, []);
            const fp2 = computeSnapshotFingerprint(repoRoot, 'git_auto', false, []);
            const fp3 = computeSnapshotFingerprint(repoRoot, 'git_staged_only', true, []);
            const fp4 = computeSnapshotFingerprint(repoRoot, 'git_auto', true, ['file.ts']);
            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
            assert.notEqual(fp1.fingerprint, fp3.fingerprint);
            assert.notEqual(fp1.fingerprint, fp4.fingerprint);
        });
    });

    describe('readSnapshotCache / writeSnapshotCache', () => {
        it('round-trips a valid cache entry', () => {
            const cachePath = path.join(tempDir, 'cache.json');
            const entry: WorkspaceSnapshotCacheEntry = {
                cache_version: 1,
                fingerprint: 'abc123',
                snapshot: {
                    detection_source: 'git_auto',
                    use_staged: false,
                    include_untracked: true,
                    changed_files: ['file.ts'],
                    changed_files_count: 1,
                    additions_total: 1,
                    deletions_total: 0,
                    changed_lines_total: 1,
                    changed_files_sha256: 'deadbeef',
                    scope_content_sha256: 'feedface',
                    scope_sha256: 'cafebabe'
                },
                timestamp_utc: new Date().toISOString(),
                params: {
                    repo_root: '/repo',
                    detection_source: 'git_auto',
                    include_untracked: true,
                    explicit_changed_files_hash: null
                },
                git_state: {
                    head_sha: 'abc',
                    index_mtime_ms: 12345,
                    index_size: 678
                }
            };
            writeSnapshotCache(cachePath, entry);
            const read = readSnapshotCache(cachePath);
            assert.ok(read);
            assert.equal(read.fingerprint, 'abc123');
            assert.deepEqual(read.snapshot.changed_files, ['file.ts']);
        });

        it('returns null for missing file', () => {
            const read = readSnapshotCache(path.join(tempDir, 'nonexistent.json'));
            assert.equal(read, null);
        });

        it('returns null for invalid JSON', () => {
            const cachePath = path.join(tempDir, 'bad.json');
            fs.writeFileSync(cachePath, 'not json', 'utf8');
            assert.equal(readSnapshotCache(cachePath), null);
        });

        it('returns null for wrong cache version', () => {
            const cachePath = path.join(tempDir, 'old.json');
            fs.writeFileSync(cachePath, JSON.stringify({ cache_version: 99, fingerprint: 'x', snapshot: {} }), 'utf8');
            assert.equal(readSnapshotCache(cachePath), null);
        });
    });

    describe('getWorkspaceSnapshotCached', () => {
        it('returns a correct snapshot on first call (cache miss)', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
            assert.equal(result.changed_files_count, 1);
            assert.ok(result.changed_lines_total > 0);
        });

        it('returns cache_hit=true on second call with no state change', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, true);
            assert.deepEqual(second.changed_files, first.changed_files);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.equal(second.scope_sha256, first.scope_sha256);
        });

        it('invalidates cache when file is staged', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            // Stage the file — changes git index
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, false);
        });

        it('invalidates cache when tracked worktree content changes without staging', () => {
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_files.includes('file.ts'));
            assert.ok(second.changed_lines_total > 0);
        });

        it('invalidates cache when HEAD changes', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'change'], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
        });

        it('invalidates cache when parameters change', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(result.cache_hit, false);
        });

        it('respects noCache option', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, [], { noCache: true });
            assert.equal(result.cache_hit, false);
        });

        it('respects readOnly option (does not write cache file)', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, [], { readOnly: true });

            const cachePath = resolveSnapshotCachePath(repoRoot);
            assert.equal(fs.existsSync(cachePath), false);
        });

        it('includes untracked files when requested', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.ok(result.changed_files.includes('untracked.ts'));
        });

        it('invalidates cache when untracked file content changes and includeUntracked=true', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'line one\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'line one\nline two\nline three\n', 'utf8');
            const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_lines_total > first.changed_lines_total);
        });

        it('excludes untracked files when not requested', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.ok(!result.changed_files.includes('untracked.ts'));
        });

        it('handles explicit_changed_files detection source', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
            assert.equal(result.detection_source, 'explicit_changed_files');
        });

        it('invalidates explicit_changed_files cache when explicit file content changes', () => {
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 99;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
            assert.ok(second.changed_files.includes('file.ts'));
        });

        it('changes scope hash when file content changes without changing line totals', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');
            const future = new Date(Date.now() + 1000);
            fs.utimesSync(path.join(repoRoot, 'file.ts'), future, future);

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.equal(second.changed_files_sha256, first.changed_files_sha256);
            assert.notEqual(second.scope_content_sha256, first.scope_content_sha256);
            assert.notEqual(second.scope_sha256, first.scope_sha256);
        });

        it('cached result matches fresh result for same state', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

            const fresh = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], { noCache: true });
            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            // Second call should hit cache (after first wrote it)
            const fromCache = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            assert.deepEqual(fromCache.changed_files, fresh.changed_files);
            assert.equal(fromCache.changed_lines_total, fresh.changed_lines_total);
            assert.equal(fromCache.scope_sha256, fresh.scope_sha256);
            assert.equal(fromCache.changed_files_sha256, fresh.changed_files_sha256);
        });
    });

    describe('invalidateSnapshotCache', () => {
        it('removes existing cache file', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            const cachePath = resolveSnapshotCachePath(repoRoot);
            assert.ok(fs.existsSync(cachePath));

            const removed = invalidateSnapshotCache(repoRoot);
            assert.equal(removed, true);
            assert.equal(fs.existsSync(cachePath), false);
        });

        it('returns false when no cache file exists', () => {
            const removed = invalidateSnapshotCache(repoRoot);
            assert.equal(removed, false);
        });

        it('forces fresh computation on next call', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

            invalidateSnapshotCache(repoRoot);

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
        });
    });

    describe('edge cases', () => {
        it('handles repo with spaces in path', () => {
            const spacedDir = path.join(tempDir, 'repo with spaces');
            fs.mkdirSync(spacedDir, { recursive: true });
            execFileSync('git', ['init', spacedDir], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'config', 'user.email', 'test@test.com'], { stdio: 'ignore' });
            fs.writeFileSync(path.join(spacedDir, 'app.ts'), 'export const x = 1;\n', 'utf8');
            execFileSync('git', ['-C', spacedDir, 'add', '.'], { stdio: 'ignore' });
            execFileSync('git', ['-C', spacedDir, 'commit', '-m', 'init'], { stdio: 'ignore' });

            fs.writeFileSync(path.join(spacedDir, 'app.ts'), 'export const x = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(spacedDir, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('app.ts'));

            const cached = getWorkspaceSnapshotCached(spacedDir, 'git_auto', false, []);
            assert.equal(cached.cache_hit, true);
        });

        it('handles empty workspace (no changes)', () => {
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.changed_files_count, 0);
            assert.equal(result.changed_lines_total, 0);

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(cached.cache_hit, true);
            assert.equal(cached.changed_files_count, 0);
        });

        it('handles staged-only detection source', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(result.detection_source, 'git_staged_only');
            assert.equal(result.use_staged, true);
            assert.ok(result.changed_files.includes('file.ts'));

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(cached.cache_hit, true);
        });

        it('keeps staged-only cache hit when only unstaged tracked changes appear later', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });

            const first = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 3;\n', 'utf8');

            const second = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(second.cache_hit, true);
            assert.equal(second.changed_lines_total, first.changed_lines_total);
            assert.deepEqual(second.changed_files, first.changed_files);
        });

        it('survives corrupt cache file gracefully', () => {
            const cachePath = resolveSnapshotCachePath(repoRoot);
            fs.mkdirSync(path.dirname(cachePath), { recursive: true });
            fs.writeFileSync(cachePath, '{{{{not json', 'utf8');

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
            assert.equal(result.cache_hit, false);
            assert.ok(result.changed_files.includes('file.ts'));
        });
    });
});
