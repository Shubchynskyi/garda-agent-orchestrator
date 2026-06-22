import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { initGitRepo, runGitFixtureCommand } from '../git-fixtures';

const tempRoots: string[] = [];

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-fixture-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    return repoRoot;
}

function gitResult(status: number, stderr = ''): childProcess.SpawnSyncReturns<string> {
    return {
        pid: 1,
        output: ['', '', stderr],
        stdout: '',
        stderr,
        status,
        signal: null
    };
}

describe('gates/git-fixtures', () => {
    afterEach(() => {
        for (const root of tempRoots.splice(0)) {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('creates a clean baseline commit from seeded fixture files', () => {
        const repoRoot = makeTempRepo();

        initGitRepo(repoRoot);

        const status = runGitFixtureCommand(repoRoot, ['status', '--porcelain']).stdout.trim();
        assert.equal(status, '');
        assert.equal(fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8'), 'garda-agent-orchestrator/runtime/\n');

        const config = fs.readFileSync(path.join(repoRoot, '.git', 'config'), 'utf8');
        assert.match(config, /gpgsign = false/u);
        assert.match(config, /name = Garda Test/u);
        assert.match(config, /email = garda-test@example.invalid/u);
    });

    it('preserves dirty status semantics after baseline commit', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');

        const status = runGitFixtureCommand(repoRoot, ['status', '--porcelain']).stdout;
        assert.match(status, /^ M src\/app\.ts/u);
    });

    it('retries transient Windows git init config failures', () => {
        const repoRoot = makeTempRepo();
        let calls = 0;

        const result = runGitFixtureCommand(repoRoot, ['init'], {
            retryDelaysMs: [0, 0],
            spawnSync() {
                calls += 1;
                if (calls === 1) {
                    return gitResult(
                        128,
                        "error: opening C:/Temp/example/.git/config: Permission denied\nfatal: could not set 'core.logallrefupdates' to 'true'"
                    );
                }
                return gitResult(0);
            }
        });

        assert.equal(result.status, 0);
        assert.equal(calls, 2);
    });
});
