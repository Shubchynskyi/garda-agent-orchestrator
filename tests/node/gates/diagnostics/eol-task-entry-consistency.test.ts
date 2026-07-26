import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { buildShellSmokePreflight } from '../../../../src/gates/diagnostics/shell-smoke-preflight';
import { captureDirtyWorkspaceBaseline } from '../../../../src/gates/workspace/dirty-worktree-protection';

function runGit(repoRoot: string, args: string[]): void {
    execFileSync('git', ['-C', repoRoot, ...args], {
        encoding: 'utf8',
        stdio: 'pipe'
    });
}

function writeFile(repoRoot: string, relativePath: string, content: string): void {
    const absolutePath = path.join(repoRoot, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, 'utf8');
}

function createFixtureRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-eol-entry-consistency-'));
    writeFile(repoRoot, 'package.json', JSON.stringify({ name: 'garda-agent-orchestrator' }));
    writeFile(repoRoot, 'MANIFEST.md', '# Manifest\n');
    writeFile(repoRoot, 'VERSION', '1.0.0\n');
    writeFile(repoRoot, 'bin/garda.js', 'console.log("1.0.0");\n');
    writeFile(repoRoot, '.gitignore', 'garda-agent-orchestrator/runtime/\n');
    writeFile(repoRoot, 'alpha.txt', 'alpha\nbeta\n');
    writeFile(repoRoot, 'beta.txt', 'one\ntwo\n');
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.email', 'tests@example.invalid']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'core.autocrlf', 'false']);
    runGit(repoRoot, ['config', 'core.safecrlf', 'false']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'baseline']);
    return repoRoot;
}

interface FixtureExpectation {
    changedFiles: string[];
    stagedFiles?: string[];
    unstagedFiles?: string[];
    eolOnlyFiles?: string[];
}

function assertConsumersAgree(repoRoot: string, expected: FixtureExpectation): void {
    const shellSmoke = buildShellSmokePreflight({
        taskId: 'T-949-2-fixture',
        repoRoot
    });
    const taskModeBaseline = captureDirtyWorkspaceBaseline(repoRoot);
    const shellEvidence = shellSmoke.git_change_classification;
    const taskModeEvidence = taskModeBaseline.git_change_classification;

    assert.equal(shellSmoke.outcome, 'PASS');
    assert.ok(shellEvidence);
    assert.ok(taskModeEvidence);
    assert.deepEqual(taskModeEvidence, shellEvidence);
    assert.deepEqual(shellEvidence.effective_changed_files, expected.changedFiles);
    assert.deepEqual(taskModeBaseline.changed_files, expected.changedFiles);
    assert.deepEqual(shellEvidence.staged_files, expected.stagedFiles || []);
    assert.deepEqual(shellEvidence.unstaged_files, expected.unstagedFiles || []);
    assert.deepEqual(shellEvidence.eol_only_files, expected.eolOnlyFiles || []);
    assert.deepEqual(shellEvidence.ignored_eol_only_files, []);
    assert.match(shellEvidence.normalization_rationale, /Git porcelain reported/);
}

describe('shell-smoke and task-mode EOL classification consistency', () => {
    const fixtures: Array<{
        name: string;
        mutate: (repoRoot: string) => void;
        expected: FixtureExpectation;
    }> = [
        {
            name: 'clean',
            mutate: () => undefined,
            expected: { changedFiles: [] }
        },
        {
            name: 'EOL-only',
            mutate: (repoRoot) => writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n'),
            expected: {
                changedFiles: ['alpha.txt'],
                unstagedFiles: ['alpha.txt'],
                eolOnlyFiles: ['alpha.txt']
            }
        },
        {
            name: 'real-content',
            mutate: (repoRoot) => writeFile(repoRoot, 'alpha.txt', 'alpha\nchanged\n'),
            expected: {
                changedFiles: ['alpha.txt'],
                unstagedFiles: ['alpha.txt']
            }
        },
        {
            name: 'mixed EOL and real content',
            mutate: (repoRoot) => {
                writeFile(repoRoot, 'alpha.txt', 'alpha\r\nbeta\r\n');
                writeFile(repoRoot, 'beta.txt', 'one\nchanged\n');
            },
            expected: {
                changedFiles: ['alpha.txt', 'beta.txt'],
                unstagedFiles: ['alpha.txt', 'beta.txt'],
                eolOnlyFiles: ['alpha.txt']
            }
        },
        {
            name: 'staged',
            mutate: (repoRoot) => {
                writeFile(repoRoot, 'alpha.txt', 'staged\ncontent\n');
                runGit(repoRoot, ['add', 'alpha.txt']);
            },
            expected: {
                changedFiles: ['alpha.txt'],
                stagedFiles: ['alpha.txt']
            }
        },
        {
            name: 'unstaged',
            mutate: (repoRoot) => writeFile(repoRoot, 'beta.txt', 'unstaged\ncontent\n'),
            expected: {
                changedFiles: ['beta.txt'],
                unstagedFiles: ['beta.txt']
            }
        }
    ];

    for (const fixture of fixtures) {
        it(`agrees for the ${fixture.name} fixture`, () => {
            const repoRoot = createFixtureRepo();
            try {
                fixture.mutate(repoRoot);
                assertConsumersAgree(repoRoot, fixture.expected);
            } finally {
                fs.rmSync(repoRoot, { recursive: true, force: true });
            }
        });
    }

    it('fails closed when task-mode cannot classify Git state', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-eol-entry-invalid-'));
        try {
            assert.throws(
                () => captureDirtyWorkspaceBaseline(repoRoot),
                /git --no-pager status .* failed/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
