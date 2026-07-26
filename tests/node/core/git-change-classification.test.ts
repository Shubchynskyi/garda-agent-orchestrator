import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    GIT_EOL_CHANGE_POLICY,
    classifyGitChanges
} from '../../../src/core/git-change-classification';
import { runGit } from '../../../src/core/git-helpers';

const tempRoots: string[] = [];

function makeRepo(autocrlf: 'false' | 'input' | 'true' = 'false'): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-change-classification-'));
    tempRoots.push(repoRoot);
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'tests@example.com']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', autocrlf]);
    runGit(repoRoot, ['config', 'core.safecrlf', 'false']);
    fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\nbeta\n', 'utf8');
    runGit(repoRoot, ['add', 'tracked.txt']);
    runGit(repoRoot, ['commit', '-m', 'seed']);
    return repoRoot;
}

function findChange(
    repoRoot: string,
    layer: 'staged' | 'unstaged' | 'untracked',
    filePath: string = 'tracked.txt'
) {
    return classifyGitChanges(repoRoot).changes.find(
        (change) => change.layer === layer && change.path === filePath
    );
}

describe('Git change classification', () => {
    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('keeps unstaged LF-to-CRLF-only changes in effective dirty scope', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'unstaged');

        assert.equal(result.policy, GIT_EOL_CHANGE_POLICY);
        assert.equal(change?.contentClassification, 'eol_only');
        assert.equal(change?.includedInEffectiveScope, true);
        assert.deepEqual(result.effectiveChangedFiles, ['tracked.txt']);
        assert.deepEqual(result.eolOnlyFiles, ['tracked.txt']);
        assert.match(change?.reason || '', /keeps the change in effective dirty scope/);
    });

    it('preserves independent staged and unstaged classifications for one path', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');
        runGit(repoRoot, ['add', 'tracked.txt']);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta changed\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const staged = result.changes.find((change) => change.layer === 'staged');
        const unstaged = result.changes.find((change) => change.layer === 'unstaged');

        assert.equal(staged?.contentClassification, 'eol_only');
        assert.equal(unstaged?.contentClassification, 'content');
        assert.deepEqual(result.stagedFiles, ['tracked.txt']);
        assert.deepEqual(result.unstagedFiles, ['tracked.txt']);
    });

    it('classifies mixed EOL and text edits as content changes', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nchanged\r\n', 'utf8');

        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'content');
        assert.match(change?.reason || '', /still differs after line-ending normalization/);
    });

    it('treats adding a UTF-8 BOM as content instead of an EOL-only change', () => {
        const repoRoot = makeRepo();
        const withBom = Buffer.concat([
            Buffer.from([0xef, 0xbb, 0xbf]),
            Buffer.from('alpha\nbeta\n', 'utf8')
        ]);
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), withBom);

        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'content');
        assert.match(change?.reason || '', /still differs after line-ending normalization/);
    });

    it('never applies text EOL normalization to binary changes', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'binary.dat'), Buffer.from([0, 1, 2, 10]));
        runGit(repoRoot, ['add', 'binary.dat']);
        runGit(repoRoot, ['commit', '-m', 'add binary']);
        fs.writeFileSync(path.join(repoRoot, 'binary.dat'), Buffer.from([0, 1, 3, 13, 10]));

        const change = findChange(repoRoot, 'unstaged', 'binary.dat');

        assert.equal(change?.contentClassification, 'binary');
        assert.match(change?.reason || '', /binary or invalid UTF-8/);
    });

    it('reports untracked files separately without losing dirty scope', () => {
        const repoRoot = makeRepo();
        fs.writeFileSync(path.join(repoRoot, 'new.txt'), 'new\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'untracked', 'new.txt');

        assert.equal(change?.changeKind, 'untracked');
        assert.equal(change?.contentClassification, 'content');
        assert.deepEqual(result.untrackedFiles, ['new.txt']);
        assert.deepEqual(result.effectiveChangedFiles, ['new.txt']);
    });

    it('respects core.autocrlf=true normalization that Git itself considers clean', () => {
        const repoRoot = makeRepo('true');
        const trackedPath = path.join(repoRoot, 'tracked.txt');
        fs.rmSync(trackedPath);
        runGit(repoRoot, ['checkout', '--', 'tracked.txt']);

        const checkoutBytes = fs.readFileSync(trackedPath);
        const configBefore = runGit(repoRoot, ['config', '--local', '--list', '--null']);
        const result = classifyGitChanges(repoRoot);
        const configAfter = runGit(repoRoot, ['config', '--local', '--list', '--null']);

        assert.ok(checkoutBytes.includes(Buffer.from('\r\n')), 'autocrlf=true checkout should contain CRLF');
        assert.deepEqual(result.changes, []);
        assert.equal(result.gitConfig.autocrlf, 'true');
        assert.equal(result.audit.effectiveDirty, false);
        assert.match(result.audit.reason, /Git porcelain reported no effective changes/);
        assert.equal(configAfter, configBefore, 'classification must not mutate repository config');
    });

    it('keeps a porcelain-visible EOL-only change dirty under core.autocrlf=input', () => {
        const repoRoot = makeRepo('input');
        fs.writeFileSync(path.join(repoRoot, 'tracked.txt'), 'alpha\r\nbeta\r\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = findChange(repoRoot, 'unstaged');

        assert.equal(change?.contentClassification, 'eol_only');
        assert.equal(result.audit.effectiveDirty, true);
        assert.deepEqual(result.effectiveChangedFiles, ['tracked.txt']);
        assert.equal(result.gitConfig.autocrlf, 'input');
    });

    it('classifies a pure rename with identical bytes as metadata', () => {
        const repoRoot = makeRepo();
        runGit(repoRoot, ['mv', 'tracked.txt', 'renamed.txt']);

        const change = findChange(repoRoot, 'staged', 'renamed.txt');

        assert.equal(change?.changeKind, 'renamed');
        assert.equal(change?.previousPath, 'tracked.txt');
        assert.equal(change?.contentClassification, 'metadata');
        assert.match(change?.reason || '', /bytes are identical/);
    });

    it('preserves a literal backslash in a POSIX Git pathname', {
        skip: process.platform === 'win32'
    }, () => {
        const repoRoot = makeRepo();
        const fileName = 'literal\\name.txt';
        fs.writeFileSync(path.join(repoRoot, fileName), 'before\n', 'utf8');
        runGit(repoRoot, ['add', '--', fileName]);
        runGit(repoRoot, ['commit', '-m', 'add literal backslash path']);
        fs.writeFileSync(path.join(repoRoot, fileName), 'after\n', 'utf8');

        const result = classifyGitChanges(repoRoot);
        const change = result.changes.find((entry) => entry.path === fileName);

        assert.equal(change?.layer, 'unstaged');
        assert.equal(change?.contentClassification, 'content');
        assert.deepEqual(result.effectiveChangedFiles, [fileName]);
    });
});
