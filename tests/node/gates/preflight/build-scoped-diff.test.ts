import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

import {
    buildScopedDiff,
    runGitDiff,
    SCOPED_DIFF_UNTRACKED_TOTAL_MAX_CHARS
} from '../../../../src/gates/preflight/build-scoped-diff';

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function sleepSync(delayMs: number): void {
    if (delayMs <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function runGit(args: readonly string[]): void {
    const gitArgs = [
        '-c', 'init.defaultBranch=main',
        '-c', 'commit.gpgsign=false',
        '-c', 'tag.gpgsign=false',
        '-c', 'core.autocrlf=false',
        '-c', 'core.eol=lf',
        '-c', 'core.safecrlf=false',
        ...args
    ];
    const retryDelaysMs = [0, 25, 100];
    let lastResult: ReturnType<typeof spawnSync> | null = null;
    for (const delayMs of retryDelaysMs) {
        sleepSync(delayMs);
        const result = spawnSync('git', gitArgs, {
            encoding: 'utf8',
            windowsHide: true
        });
        lastResult = result;
        if (result.status === 0) {
            return;
        }
    }

    const stdout = String(lastResult?.stdout || '').trim();
    const stderr = String(lastResult?.stderr || '').trim();
    assert.fail(`git ${args.join(' ')} failed with status ${lastResult?.status}: ${[stdout, stderr].filter(Boolean).join('\n')}`);
}

test('runGitDiff handles repo roots and pathspecs with spaces', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-'));
    const repoRoot = path.join(tempDir, 'repo with spaces');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'app with spaces.ts');

    try {
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);

        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);

        fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

        const diff = runGitDiff(repoRoot, false, ['src/app with spaces.ts']);
        assert.match(diff, /diff --git a\/src\/app with spaces\.ts b\/src\/app with spaces\.ts/);
        assert.match(diff, /\+export const value = 2;/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('runGitDiff disables configured external diff and textconv helpers', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-hardened-'));
    const repoRoot = path.join(tempDir, 'repo');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'app.ts');

    try {
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);

        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);
        runGit(['-C', repoRoot, 'config', 'diff.external', 'definitely-missing-garda-diff-helper']);
        fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

        const diff = runGitDiff(repoRoot, false, ['src/app.ts']);
        assert.match(diff, /\+export const value = 2;/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff fails fast when the metadata artifact is locked by a live writer', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-locked-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'app.ts');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);

        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);
        fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot, 'T-700-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const outputPath = path.join(reviewsRoot, 'T-700-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-700-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-700',
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^src/']
            }
        }, null, 2), 'utf8');

        const lockPath = `${metadataPath}.lock`;
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => buildScopedDiff({
                reviewType: 'security',
                preflightPath,
                pathsConfigPath,
                outputPath,
                metadataPath,
                repoRoot
            }),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(outputPath), false);
        assert.equal(fs.existsSync(metadataPath), false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff treats git pathspecs literally and rejects pathspec magic', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-literal-pathspec-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        fs.writeFileSync(path.join(srcDir, '[ab].ts'), 'export const literal = 1;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const broadened = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);
        fs.writeFileSync(path.join(srcDir, '[ab].ts'), 'export const literal = 2;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export const broadened = 2;\n', 'utf8');

        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^src/']
            }
        }, null, 2), 'utf8');
        const preflightPath = path.join(reviewsRoot, 'T-702-preflight.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-702',
            detection_source: 'explicit_changed_files',
            changed_files: ['src/[ab].ts']
        }, null, 2), 'utf8');
        const outputPath = path.join(reviewsRoot, 'T-702-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-702-security-scoped.json');
        buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            repoRoot
        });

        const output = fs.readFileSync(outputPath, 'utf8');
        assert.match(output, /diff --git a\/src\/\[ab\]\.ts b\/src\/\[ab\]\.ts/);
        assert.doesNotMatch(output, /diff --git a\/src\/a\.ts b\/src\/a\.ts/);

        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-702',
            detection_source: 'explicit_changed_files',
            changed_files: [':(glob)src/*.ts']
        }, null, 2), 'utf8');
        assert.throws(
            () => buildScopedDiff({
                reviewType: 'security',
                preflightPath,
                pathsConfigPath,
                outputPath,
                metadataPath,
                repoRoot
            }),
            /unsafe path/
        );
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff derives staged mode from staged-only preflight scope', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-staged-mode-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'app.ts');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);

        fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', 'src/app.ts']);
        fs.writeFileSync(changedFilePath, 'export const value = 3;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot, 'T-703-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const outputPath = path.join(reviewsRoot, 'T-703-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-703-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-703',
            detection_source: 'git_staged_only',
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^src/']
            }
        }, null, 2), 'utf8');

        const result = buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            repoRoot
        });
        const output = fs.readFileSync(outputPath, 'utf8');

        assert.match(output, /\+export const value = 2;/);
        assert.doesNotMatch(output, /\+export const value = 3;/);
        assert.equal(result.detection_source, 'git_staged_only');
        assert.equal(result.use_staged, true);
        assert.equal(result.use_staged_source, 'preflight_detection_source');
        assert.equal(result.include_untracked, false);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff fallback stays limited to preflight changed files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-fallback-scope-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const scoped = 1;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'unrelated.ts'), 'export const unrelated = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);
        fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const scoped = 2;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'unrelated.ts'), 'export const unrelated = 2;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot, 'T-704-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const outputPath = path.join(reviewsRoot, 'T-704-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-704-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-704',
            detection_source: 'explicit_changed_files',
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^security-only/']
            }
        }, null, 2), 'utf8');

        const result = buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            repoRoot
        });
        const output = fs.readFileSync(outputPath, 'utf8');

        assert.equal(result.fallback_to_full_diff, true);
        assert.match(output, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
        assert.doesNotMatch(output, /diff --git a\/src\/unrelated\.ts b\/src\/unrelated\.ts/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff artifact fallback stays limited to preflight changed files', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-artifact-fallback-scope-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const scoped = 1;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'unrelated.ts'), 'export const unrelated = 1;\n', 'utf8');
        runGit(['-C', repoRoot, 'add', '.']);
        runGit(['-C', repoRoot, 'commit', '-m', 'initial']);
        fs.writeFileSync(path.join(srcDir, 'app.ts'), 'export const scoped = 2;\n', 'utf8');
        fs.writeFileSync(path.join(srcDir, 'unrelated.ts'), 'export const unrelated = 2;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot, 'T-705-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const fullDiffPath = path.join(reviewsRoot, 'T-705-full.diff');
        const outputPath = path.join(reviewsRoot, 'T-705-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-705-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-705',
            detection_source: 'explicit_changed_files',
            changed_files: ['src/app.ts']
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^security-only/']
            }
        }, null, 2), 'utf8');
        fs.writeFileSync(fullDiffPath, runGitDiff(repoRoot, false, []), 'utf8');

        const result = buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            fullDiffPath,
            repoRoot
        });
        const output = fs.readFileSync(outputPath, 'utf8');

        assert.equal(result.fallback_to_full_diff, true);
        assert.equal(result.full_diff_source, 'artifact_scoped');
        assert.match(output, /diff --git a\/src\/app\.ts b\/src\/app\.ts/);
        assert.doesNotMatch(output, /diff --git a\/src\/unrelated\.ts b\/src\/unrelated\.ts/);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff includes untracked explicit changed files in scoped metadata', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-untracked-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'new-auth.ts');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        runGit(['-C', repoRoot, 'commit', '--allow-empty', '-m', 'initial']);
        fs.writeFileSync(changedFilePath, 'export const auth = true;\n', 'utf8');

        const preflightPath = path.join(reviewsRoot, 'T-701-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const outputPath = path.join(reviewsRoot, 'T-701-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-701-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-701',
            detection_source: 'explicit_changed_files',
            changed_files: ['src/new-auth.ts'],
            metrics: {
                changed_files_sha256: 'b'.repeat(64),
                scope_content_sha256: 'c'.repeat(64),
                scope_sha256: 'd'.repeat(64)
            }
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^src/']
            }
        }, null, 2), 'utf8');

        const result = buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            repoRoot
        });

        const output = fs.readFileSync(outputPath, 'utf8');
        assert.match(output, /diff --git a\/src\/new-auth\.ts b\/src\/new-auth\.ts/);
        assert.match(output, /\+export const auth = true;/);
        assert.equal(result.include_untracked, true);
        assert.equal(typeof result.preflight_sha256, 'string');
        assert.equal(String(result.preflight_sha256).length, 64);
        assert.equal(result.changed_files_sha256, 'b'.repeat(64));
        assert.equal(result.scope_content_sha256, 'c'.repeat(64));
        assert.equal(result.scope_sha256, 'd'.repeat(64));
        assert.equal(result.output_diff_sha256, sha256Text(output));
        assert.deepEqual(result.changed_files, ['src/new-auth.ts']);
        assert.equal(result.changed_files_count, 1);
        assert.deepEqual(result.untracked_files, ['src/new-auth.ts']);
        assert.ok(Number(result.output_diff_line_count) > 0);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});

test('buildScopedDiff bounds large untracked file content in scoped output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-untracked-large-'));
    const repoRoot = path.join(tempDir, 'repo');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const reviewsRoot = path.join(orchestratorRoot, 'runtime', 'reviews');
    const liveConfigRoot = path.join(orchestratorRoot, 'live', 'config');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'large.ts');

    try {
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(liveConfigRoot, { recursive: true });
        fs.mkdirSync(srcDir, { recursive: true });
        runGit(['init', repoRoot]);
        runGit(['-C', repoRoot, 'config', 'user.name', 'Garda Test']);
        runGit(['-C', repoRoot, 'config', 'user.email', 'garda@example.com']);
        runGit(['-C', repoRoot, 'commit', '--allow-empty', '-m', 'initial']);
        fs.writeFileSync(
            changedFilePath,
            `${'x'.repeat(SCOPED_DIFF_UNTRACKED_TOTAL_MAX_CHARS + 4096)}\nTAIL_SHOULD_NOT_APPEAR\n`,
            'utf8'
        );

        const preflightPath = path.join(reviewsRoot, 'T-706-preflight.json');
        const pathsConfigPath = path.join(liveConfigRoot, 'paths.json');
        const outputPath = path.join(reviewsRoot, 'T-706-security-scoped.diff');
        const metadataPath = path.join(reviewsRoot, 'T-706-security-scoped.json');
        fs.writeFileSync(preflightPath, JSON.stringify({
            task_id: 'T-706',
            detection_source: 'explicit_changed_files',
            changed_files: ['src/large.ts']
        }, null, 2), 'utf8');
        fs.writeFileSync(pathsConfigPath, JSON.stringify({
            triggers: {
                security: ['^src/']
            }
        }, null, 2), 'utf8');

        const result = buildScopedDiff({
            reviewType: 'security',
            preflightPath,
            pathsConfigPath,
            outputPath,
            metadataPath,
            repoRoot
        });

        const output = fs.readFileSync(outputPath, 'utf8');
        assert.match(output, /diff --git a\/src\/large\.ts b\/src\/large\.ts/);
        assert.match(output, /\[untracked file content truncated:/);
        assert.doesNotMatch(output, /TAIL_SHOULD_NOT_APPEAR/);
        assert.equal(result.untracked_diff_truncated, true);
        assert.ok(output.length <= SCOPED_DIFF_UNTRACKED_TOTAL_MAX_CHARS + 1);
        assert.deepEqual(result.untracked_files, ['src/large.ts']);
    } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
    }
});
