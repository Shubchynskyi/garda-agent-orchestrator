import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { runGit, runGitBinary, splitNulList } from '../../../src/core/git-helpers';

const tempRoots: string[] = [];

function makeRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-core-git-helpers-'));
    tempRoots.push(repoRoot);
    childProcess.execFileSync('git', ['init', repoRoot], { stdio: 'ignore' });
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'tracked\n', 'utf8');
    runGit(repoRoot, ['add', 'tracked.txt']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return repoRoot;
}

describe('git helpers', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('runs git text commands and preserves allowFailure fallback', () => {
        const repoRoot = makeRepo();

        assert.match(runGit(repoRoot, ['rev-parse', '--is-inside-work-tree']), /true/);
        assert.equal(runGit(repoRoot, ['not-a-real-command'], { allowFailure: true }), '');
        assert.throws(
            () => runGit(repoRoot, ['not-a-real-command']),
            /git not-a-real-command failed:/
        );
    });

    it('runs binary git commands and splits NUL-separated output like existing WIP helpers', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'untracked.txt'), 'new\n', 'utf8');

        const output = runGitBinary(repoRoot, ['ls-files', '--others', '--exclude-standard', '-z']);

        assert.deepEqual(splitNulList(output), ['untracked.txt']);
        assert.deepEqual(splitNulList(' a\0\0 b \0'), ['a', 'b']);
        assert.deepEqual(
            runGitBinary(repoRoot, ['not-a-real-command'], { allowFailure: true }),
            Buffer.alloc(0)
        );
        assert.throws(
            () => runGitBinary(repoRoot, ['not-a-real-command']),
            /git not-a-real-command failed:/
        );
    });
});
