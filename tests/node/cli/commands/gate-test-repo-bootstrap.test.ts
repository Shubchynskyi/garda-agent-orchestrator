import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    createTempRepo,
    removeTempRepoWithRetry
} from './gate-test-repo-bootstrap';

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
});
