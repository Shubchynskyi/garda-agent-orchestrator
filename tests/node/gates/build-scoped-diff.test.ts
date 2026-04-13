import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';

import { buildScopedDiff, runGitDiff } from '../../../src/gates/build-scoped-diff';

test('runGitDiff handles repo roots and pathspecs with spaces', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scoped-diff-'));
    const repoRoot = path.join(tempDir, 'repo with spaces');
    const srcDir = path.join(repoRoot, 'src');
    const changedFilePath = path.join(srcDir, 'app with spaces.ts');

    try {
        fs.mkdirSync(srcDir, { recursive: true });
        execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Garda Test'], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'garda@example.com'], { stdio: 'ignore' });

        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'initial'], { stdio: 'ignore' });

        fs.writeFileSync(changedFilePath, 'export const value = 2;\n', 'utf8');

        const diff = runGitDiff(repoRoot, false, ['src/app with spaces.ts']);
        assert.match(diff, /diff --git a\/src\/app with spaces\.ts b\/src\/app with spaces\.ts/);
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
        execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'config', 'user.name', 'Garda Test'], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'config', 'user.email', 'garda@example.com'], { stdio: 'ignore' });

        fs.writeFileSync(changedFilePath, 'export const value = 1;\n', 'utf8');
        execFileSync('git', ['-C', repoRoot, 'add', '.'], { stdio: 'ignore' });
        execFileSync('git', ['-C', repoRoot, 'commit', '-m', 'initial'], { stdio: 'ignore' });
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
