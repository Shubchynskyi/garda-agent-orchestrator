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
    parseGitCachedRawDiffDeletedPaths,
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

        it('fingerprint changes when an explicit symlink target content changes inside the repo', (t) => {
            const targetPath = path.join(repoRoot, 'target.ts');
            const symlinkPath = path.join(repoRoot, 'link.ts');
            fs.writeFileSync(targetPath, 'export const target = 1;\n', 'utf8');
            try {
                fs.symlinkSync(targetPath, symlinkPath, 'file');
            } catch (error) {
                t.skip(`file symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                return;
            }

            const fp1 = computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['link.ts']);
            fs.writeFileSync(targetPath, 'export const target = 2;\n', 'utf8');
            const fp2 = computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['link.ts']);

            assert.notEqual(fp1.fingerprint, fp2.fingerprint);
        });
    });

    describe('parseGitCachedRawDiffDeletedPaths', () => {
        it('derives staged deletion paths from cached raw diff output', () => {
            const rawDiff = [
                ':100644 000000 1111111111111111111111111111111111111111 0000000000000000000000000000000000000000 D\tfile.ts',
                ':100644 100644 2222222222222222222222222222222222222222 3333333333333333333333333333333333333333 M\tchanged.ts',
                ':100644 100644 4444444444444444444444444444444444444444 5555555555555555555555555555555555555555 R100\told.ts\tnew.ts',
                ':100644 000000 6666666666666666666666666666666666666666 0000000000000000000000000000000000000000 D\truntime/cache/workspace-snapshot.json'
            ].join('\n');

            assert.deepEqual(parseGitCachedRawDiffDeletedPaths(repoRoot, rawDiff), ['file.ts']);
        });
    });

    describe('performance characterization', () => {
        it('uses the cached raw diff as the only staged-only diff subprocess', () => {
            const originalSpawnSync = (require('node:child_process') as typeof import('node:child_process')).spawnSync;
            const diffCommands: string[][] = [];
            const childProcessModule = require('node:child_process') as typeof import('node:child_process');
            childProcessModule.spawnSync = ((command: string, args: string[], options: unknown) => {
                if (command === 'git' && args.includes('diff')) {
                    diffCommands.push([...args]);
                }
                return originalSpawnSync(command, args, options as never);
            }) as typeof originalSpawnSync;
            try {
                execFileSync('git', ['-C', repoRoot, 'rm', 'file.ts'], { stdio: 'ignore' });

                computeSnapshotFingerprint(repoRoot, 'git_staged_only', false, []);

                assert.equal(diffCommands.length, 1);
                assert.deepEqual(diffCommands[0].slice(0, 3), ['-C', repoRoot, 'diff']);
                assert.ok(diffCommands[0].includes('--raw'));
                assert.ok(!diffCommands[0].includes('--name-only'));
            } finally {
                childProcessModule.spawnSync = originalSpawnSync;
            }
        });

        it('resolves repo realpath once when hashing multiple explicit paths', () => {
            const extraPath = path.join(repoRoot, 'extra.ts');
            fs.writeFileSync(extraPath, 'export const extra = 1;\n', 'utf8');
            const fsModule = require('node:fs') as typeof import('node:fs');
            const originalRealpathSync = fsModule.realpathSync;
            let repoRealpathCalls = 0;
            fsModule.realpathSync = ((targetPath: fs.PathLike, options?: BufferEncoding | null) => {
                if (path.resolve(String(targetPath)) === path.resolve(repoRoot)) {
                    repoRealpathCalls += 1;
                }
                return originalRealpathSync(targetPath, options as never);
            }) as typeof fsModule.realpathSync;
            try {
                computeSnapshotFingerprint(repoRoot, 'explicit_changed_files', true, ['file.ts', 'extra.ts']);

                assert.equal(repoRealpathCalls, 1);
            } finally {
                fsModule.realpathSync = originalRealpathSync;
            }
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
                    ignored_generated_runtime_files: [],
                    ignored_generated_runtime_files_count: 0,
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

        it('does not read or write cache files through symlinked cache directories outside repo', (t) => {
            const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-snap-cache-outside-'));
            try {
                const cachePath = resolveSnapshotCachePath(repoRoot);
                fs.rmSync(path.dirname(cachePath), { recursive: true, force: true });
                fs.mkdirSync(path.dirname(path.dirname(cachePath)), { recursive: true });
                try {
                    fs.symlinkSync(outsideRoot, path.dirname(cachePath), process.platform === 'win32' ? 'junction' : 'dir');
                } catch (error) {
                    t.skip(`directory symlink creation unavailable in this environment: ${error instanceof Error ? error.message : String(error)}`);
                    return;
                }
                fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

                const first = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);
                const second = getWorkspaceSnapshotCached(repoRoot, 'git_auto', false, []);

                assert.equal(first.cache_hit, false);
                assert.equal(second.cache_hit, false);
                assert.equal(fs.existsSync(path.join(outsideRoot, 'workspace-snapshot.json')), false);
            } finally {
                fs.rmSync(outsideRoot, { recursive: true, force: true });
            }
        });

        it('includes untracked files when requested', () => {
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);
            assert.ok(result.changed_files.includes('untracked.ts'));
        });

        it('ignores generated runtime artifacts from git-auto untracked scope', () => {
            const generatedPath = path.join(
                repoRoot,
                'mnt',
                'wsl',
                'projects',
                'missing',
                'runtime',
                'task-events',
                'T-504.jsonl'
            );
            fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
            fs.writeFileSync(generatedPath, '{"event_type":"GENERATED"}\n', 'utf8');
            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, []);

            assert.deepEqual(result.changed_files, ['untracked.ts']);
            assert.equal(result.changed_files_count, 1);
            assert.deepEqual(result.ignored_generated_runtime_files, [
                'mnt/wsl/projects/missing/runtime/task-events/T-504.jsonl'
            ]);
            assert.equal(result.ignored_generated_runtime_files_count, 1);
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

        it('invalidates explicit_changed_files cache when same-size content changes with restored mtime', () => {
            const filePath = path.join(repoRoot, 'file.ts');
            fs.writeFileSync(filePath, 'export const a = 2;\n', 'utf8');
            const first = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(first.cache_hit, false);
            const stat = fs.statSync(filePath);

            fs.writeFileSync(filePath, 'export const b = 2;\n', 'utf8');
            fs.utimesSync(filePath, stat.atime, stat.mtime);

            const second = getWorkspaceSnapshotCached(repoRoot, 'explicit_changed_files', false, ['file.ts']);
            assert.equal(second.cache_hit, false);
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

        it('ignores generated runtime artifacts from staged snapshot scope', () => {
            const generatedRelativePath = 'garda-agent-orchestrator/runtime/task-events/T-504.jsonl';
            const generatedPath = path.join(repoRoot, ...generatedRelativePath.split('/'));
            fs.mkdirSync(path.dirname(generatedPath), { recursive: true });
            fs.writeFileSync(generatedPath, '{"event_type":"BASELINE"}\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', generatedRelativePath], { stdio: 'ignore' });
            execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'track generated artifact fixture'], { stdio: 'ignore' });

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            fs.writeFileSync(generatedPath, '{"event_type":"GENERATED"}\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts', generatedRelativePath], { stdio: 'ignore' });

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);

            assert.equal(result.detection_source, 'git_staged_only');
            assert.equal(result.use_staged, true);
            assert.deepEqual(result.changed_files, ['file.ts']);
            assert.equal(result.changed_files_count, 1);
            assert.deepEqual(result.ignored_generated_runtime_files, [generatedRelativePath]);
            assert.equal(result.ignored_generated_runtime_files_count, 1);
        });

        it('invalidates staged-only cache for staged deletions when the path is recreated untracked', () => {
            const clean = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(clean.changed_files_count, 0);

            execFileSync('git', ['-C', repoRoot, 'rm', 'file.ts'], { stdio: 'ignore' });
            const deleted = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(deleted.cache_hit, false);
            assert.deepEqual(deleted.changed_files, ['file.ts']);
            assert.equal(deleted.additions_total, 0);
            assert.equal(deleted.deletions_total, 1);

            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');

            const result = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(result.cache_hit, false);
            assert.deepEqual(result.changed_files, ['file.ts']);
            assert.equal(result.additions_total, 0);
            assert.equal(result.deletions_total, 1);

            const cached = getWorkspaceSnapshotCached(repoRoot, 'git_staged_only', false, []);
            assert.equal(cached.cache_hit, true);
            assert.deepEqual(cached.changed_files, ['file.ts']);
        });

        it('fails closed when staged-plus-untracked cache status fingerprint git probes fail', () => {
            fs.writeFileSync(path.join(repoRoot, 'file.ts'), 'export const a = 2;\n', 'utf8');
            execFileSync('git', ['-C', repoRoot, 'add', 'file.ts'], { stdio: 'ignore' });
            const first = getWorkspaceSnapshotCached(repoRoot, 'git_staged_plus_untracked', true, []);
            assert.equal(first.cache_hit, false);

            fs.writeFileSync(path.join(repoRoot, 'untracked.ts'), 'export const u = 1;\n', 'utf8');
            fs.renameSync(path.join(repoRoot, '.git'), path.join(repoRoot, '.git-offline'));
            assert.throws(
                () => getWorkspaceSnapshotCached(repoRoot, 'git_staged_plus_untracked', true, []),
                /Unable to compute workspace snapshot cache fingerprint: git -C .* status --porcelain=v1 --untracked-files=all/
            );
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
