import test from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    formatCleanWorktreePreflightResult,
    validateCleanWorktreePreflight
} from '../../../scripts/node-foundation/validate-release';

function runGit(repoRoot: string, args: string[]): void {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        windowsHide: true
    });
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`
    );
}

function writeTextFile(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

function createCommittedRepoFixture(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-clean-worktree-'));

    runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init']);
    runGit(repoRoot, ['config', 'user.email', 'test@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Test']);
    writeTextFile(path.join(repoRoot, 'tracked.txt'), 'initial\n');
    runGit(repoRoot, ['add', 'tracked.txt']);
    runGit(repoRoot, ['commit', '--no-gpg-sign', '-m', 'initial']);

    return repoRoot;
}

test('validateCleanWorktreePreflight passes for a clean git repository', () => {
    const repoRoot = createCommittedRepoFixture();

    try {
        const result = validateCleanWorktreePreflight(repoRoot);

        assert.equal(result.passed, true, formatCleanWorktreePreflightResult(result));
        assert.equal(result.dirtyPaths.length, 0);
        assert.equal(result.detachedHead, false);
        assert.equal(result.branchName, 'main');
        assert.match(result.headSha || '', /^[a-f0-9]{40}$/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateCleanWorktreePreflight blocks modified tracked files and prints their paths', () => {
    const repoRoot = createCommittedRepoFixture();

    try {
        writeTextFile(path.join(repoRoot, 'tracked.txt'), 'modified\n');

        const result = validateCleanWorktreePreflight(repoRoot);
        const output = formatCleanWorktreePreflightResult(result);

        assert.equal(result.passed, false);
        assert.deepEqual(result.dirtyPaths, ['tracked.txt']);
        assert.match(output, /RELEASE_CLEAN_WORKTREE_FAILED/);
        assert.match(output, /tracked\.txt/);
        assert.match(output, /Commit intentional changes/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateCleanWorktreePreflight blocks untracked files and prints their paths', () => {
    const repoRoot = createCommittedRepoFixture();

    try {
        writeTextFile(path.join(repoRoot, 'untracked.txt'), 'new\n');

        const result = validateCleanWorktreePreflight(repoRoot);

        assert.equal(result.passed, false);
        assert.deepEqual(result.dirtyPaths, ['untracked.txt']);
        assert.match(formatCleanWorktreePreflightResult(result), /untracked\.txt/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateCleanWorktreePreflight allows clean detached HEAD releases by commit SHA', () => {
    const repoRoot = createCommittedRepoFixture();

    try {
        runGit(repoRoot, ['checkout', '--detach', 'HEAD']);

        const result = validateCleanWorktreePreflight(repoRoot);

        assert.equal(result.passed, true, formatCleanWorktreePreflightResult(result));
        assert.equal(result.detachedHead, true);
        assert.equal(result.branchName, null);
        assert.match(formatCleanWorktreePreflightResult(result), /DetachedHead: yes \(allowed\)/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

test('validateCleanWorktreePreflight fails non-git directories with actionable output', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-release-non-git-'));

    try {
        const result = validateCleanWorktreePreflight(repoRoot);
        const output = formatCleanWorktreePreflightResult(result);

        assert.equal(result.passed, false);
        assert.equal(result.dirtyPaths.length, 0);
        assert.match(output, /RELEASE_CLEAN_WORKTREE_FAILED/);
        assert.match(output, /Cannot resolve git HEAD/);
        assert.match(output, /Remediation:/);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
