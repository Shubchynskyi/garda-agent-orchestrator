import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type * as childProcess from 'node:child_process';

import {
    formatGitFixtureFailureMessage,
    isTransientGitFixtureSetupError
} from './gate-test-seed-helpers';

function failedGitResult(stderr: string): childProcess.SpawnSyncReturns<string> {
    return {
        pid: 0,
        output: ['', '', stderr],
        stdout: '',
        stderr,
        status: 1,
        signal: null
    };
}

describe('gate test git fixture helpers', () => {
    it('detects transient Windows temp git config setup failures', () => {
        assert.equal(
            isTransientGitFixtureSetupError(
                "error: opening .git/config: Permission denied\nfatal: could not set 'core.ignorecase' to 'true'"
            ),
            true
        );
        assert.equal(
            isTransientGitFixtureSetupError('fatal: not a git repository'),
            false
        );
    });

    it('formats fixture git failures with owning repo, command, and attempts', () => {
        const message = formatGitFixtureFailureMessage(
            'D:/tmp/garda-gates-example',
            ['init'],
            failedGitResult("fatal: could not set 'core.ignorecase' to 'true'"),
            3
        );

        assert.match(message, /D:\/tmp\/garda-gates-example/);
        assert.match(message, /Command: git init/);
        assert.match(message, /Attempts: 3/);
        assert.match(message, /core\.ignorecase/);
    });
});
