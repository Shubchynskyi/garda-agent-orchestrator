import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    createTempRepo,
    removeTempRepoWithRetry,
    runGit
} from './gate-test-repo-bootstrap';

function gitResult(status: number, stderr = ''): childProcess.SpawnSyncReturns<string> {
    return {
        pid: 0,
        output: ['', '', stderr],
        stdout: '',
        stderr,
        status,
        signal: null,
        error: undefined
    };
}

describe('gate-test-repo-bootstrap cleanup', () => {
    it('retries transient Windows cleanup errors before removing the temp repo', () => {
        const repoRoot = createTempRepo();
        let calls = 0;

        removeTempRepoWithRetry(repoRoot, {
            retryDelaysMs: [0],
            rmSync(root, options) {
                calls += 1;
                if (calls === 1) {
                    const error = new Error('simulated transient cleanup lock') as NodeJS.ErrnoException;
                    error.code = 'EPERM';
                    throw error;
                }
                fs.rmSync(root, options);
            }
        });

        assert.equal(calls, 2);
        assert.equal(fs.existsSync(repoRoot), false);
    });

    it('does not retry non-transient cleanup errors', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-cleanup-fail-fast-'));
        let calls = 0;

        try {
            assert.throws(
                () => removeTempRepoWithRetry(repoRoot, {
                    retryDelaysMs: [0, 0],
                    rmSync() {
                        calls += 1;
                        const error = new Error('simulated non-transient cleanup failure') as NodeJS.ErrnoException;
                        error.code = 'EINVAL';
                        throw error;
                    }
                }),
                /simulated non-transient cleanup failure/
            );
            assert.equal(calls, 1);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('retries transient Windows git init config failures', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-init-retry-'));
        let calls = 0;

        try {
            const result = runGit(repoRoot, ['-c', 'init.defaultBranch=main', 'init'], {
                retryDelaysMs: [0, 0],
                spawnSync() {
                    calls += 1;
                    if (calls === 1) {
                        return gitResult(
                            128,
                            "error: opening C:/Temp/example/.git/config: Permission denied\nfatal: could not set 'core.filemode' to 'false'"
                        );
                    }
                    return gitResult(0);
                }
            });

            assert.equal(result.status, 0);
            assert.equal(calls, 2);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('does not retry non-setup git commands', () => {
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-git-no-retry-'));
        let calls = 0;

        try {
            assert.throws(
                () => runGit(repoRoot, ['add', '.'], {
                    retryDelaysMs: [0, 0],
                    spawnSync() {
                        calls += 1;
                        return gitResult(128, "error: opening .git/config: Permission denied");
                    }
                }),
                /git add \. failed/u
            );
            assert.equal(calls, 1);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
