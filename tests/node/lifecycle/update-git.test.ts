import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as childProcess from 'node:child_process';

import { runUpdateFromGit, buildGitCloneArgs } from '../../../src/lifecycle/update-git';
import { removePathRecursive } from '../../../src/lifecycle/common';

function git(args: string[], cwd: string) {
    const result = childProcess.spawnSync('git', args, {
        cwd,
        stdio: 'pipe',
        encoding: 'utf8'
    });

    if (result.status !== 0) {
        const errorText = String(result.stderr || result.stdout || '').trim();
        throw new Error(`git ${args.join(' ')} failed: ${errorText}`);
    }
}

function createGitUpdateRepo(version: string) {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-git-repo-'));
    fs.mkdirSync(path.join(repoRoot, 'scripts'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'build.js'), [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "const root = process.cwd();",
        "fs.mkdirSync(path.join(root, 'bin'), { recursive: true });",
        "fs.mkdirSync(path.join(root, 'dist', 'src'), { recursive: true });",
        "fs.writeFileSync(path.join(root, 'bin', 'garda.js'), '#!/usr/bin/env node\\n');",
        "fs.writeFileSync(path.join(root, 'dist', 'src', 'index.js'), 'module.exports = {};\\n');"
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version,
        scripts: {
            build: 'node scripts/build.js'
        }
    }, null, 2));
    fs.writeFileSync(path.join(repoRoot, 'README.md'), '# Updated bundle\n', 'utf8');

    git(['init'], repoRoot);
    git(['config', 'user.email', 'tests@example.com'], repoRoot);
    git(['config', 'user.name', 'Garda Tests'], repoRoot);
    git(['add', '.'], repoRoot);
    git(['commit', '-m', 'init'], repoRoot);
    return repoRoot;
}

function createDeployedWorkspace(version: string) {
    const targetRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-update-git-target-'));
    const bundleRoot = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(bundleRoot, { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), `${version}\n`, 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'dist', 'src', 'index.js'), 'module.exports = {};', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), JSON.stringify({
        name: 'garda-agent-orchestrator',
        version
    }, null, 2));
    return { targetRoot, bundleRoot };
}

describe('buildGitCloneArgs', () => {
    it('includes depth and repo path', () => {
        assert.deepEqual(
            buildGitCloneArgs('https://example.com/repo.git', null, 'C:/tmp/clone'),
            ['clone', '--depth', '1', 'https://example.com/repo.git', 'C:/tmp/clone']
        );
    });

    it('includes branch when provided', () => {
        assert.deepEqual(
            buildGitCloneArgs('https://example.com/repo.git', 'main', 'C:/tmp/clone'),
            ['clone', '--depth', '1', '--branch', 'main', '--single-branch', 'https://example.com/repo.git', 'C:/tmp/clone']
        );
    });
});

describe('runUpdateFromGit', () => {
    it('detects update availability from a local git repository in check-only mode', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            const result = await runUpdateFromGit({
                targetRoot,
                bundleRoot,
                repoUrl: repoRoot,
                checkOnly: true,
                noPrompt: true,
                trustOverride: true
            });

            assert.equal(result.sourceType, 'git');
            assert.equal(result.repoUrl, repoRoot);
            assert.equal(result.checkUpdateResult, 'UPDATE_AVAILABLE');
            assert.equal(result.updateAvailable, true);
            assert.equal(result.updateApplied, false);
            assert.equal(result.trustPolicy, 'overridden');
            assert.equal(result.trustOverrideUsed, true);
            assert.equal(result.trustOverrideSource, 'cli-flag');
            assert.equal(result.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('runs the post-sync update lifecycle callback when applying an update', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            let updateRunnerCalled = false;
            let updateRunnerSourceType = '';
            let updateRunnerSourceReference = '';
            const result = await runUpdateFromGit({
                targetRoot,
                bundleRoot,
                repoUrl: repoRoot,
                noPrompt: true,
                trustOverride: true,
                updateRunner: (options) => {
                    updateRunnerCalled = true;
                    updateRunnerSourceType = options.sourceType;
                    updateRunnerSourceReference = options.sourceReference;
                }
            });

            assert.equal(result.checkUpdateResult, 'UPDATED');
            assert.equal(result.updateApplied, true);
            assert.equal(updateRunnerCalled, true);
            assert.equal(updateRunnerSourceType, 'git');
            assert.equal(updateRunnerSourceReference, repoRoot);
            assert.equal(result.trustOverrideSource, 'cli-flag');
            assert.equal(result.releaseProvenanceStatus, 'TRUST_OVERRIDE_UNVERIFIED');
            assert.ok(fs.existsSync(path.join(bundleRoot, 'dist', 'src', 'index.js')));
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('fails apply when the raw git source cannot be built into a runnable bundle', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        fs.writeFileSync(path.join(repoRoot, 'scripts', 'build.js'), 'process.exit(2);\n', 'utf8');
        git(['add', '.'], repoRoot);
        git(['commit', '-m', 'break build'], repoRoot);

        try {
            await assert.rejects(
                runUpdateFromGit({
                    targetRoot,
                    bundleRoot,
                    repoUrl: repoRoot,
                    noPrompt: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /UPDATE_SOURCE_BUILD_FAILED/);
                    assert.match((error as Error).message, /runnable bundle/i);
                    return true;
                }
            );
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });

    it('surfaces classified diagnostics when the requested branch is missing', async () => {
        const repoRoot = createGitUpdateRepo('2.1.0');
        const { targetRoot, bundleRoot } = createDeployedWorkspace('2.0.0');
        try {
            await assert.rejects(
                runUpdateFromGit({
                    targetRoot,
                    bundleRoot,
                    repoUrl: repoRoot,
                    branch: 'missing-branch',
                    checkOnly: true,
                    noPrompt: true,
                    trustOverride: true
                }),
                (error) => {
                    assert.match((error as Error).message, /DiagnosticTool: git/);
                    assert.match((error as Error).message, /DiagnosticCode: GIT_REF_NOT_FOUND/);
                    assert.match((error as Error).message, /DiagnosticSource:/);
                    assert.match((error as Error).message, /missing-branch/);
                    assert.match((error as Error).message, /DiagnosticStderr:/);
                    return true;
                }
            );
        } finally {
            removePathRecursive(repoRoot);
            removePathRecursive(targetRoot);
        }
    });
});
