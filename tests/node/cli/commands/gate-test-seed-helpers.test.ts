import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type * as childProcess from 'node:child_process';

import {
    formatGitFixtureFailureMessage,
    initializeGitRepoWithMaterializedScope,
    isTransientGitFixtureSetupError,
    runEnterTaskMode,
    runGit,
    seedInitAnswers,
    seedTaskQueue,
    writeBudgetOutputFilters,
    writePreflight
} from './gate-test-seed-helpers';
import {
    createTempRepo,
    removeTempRepoWithRetry
} from './gate-test-repo-bootstrap';

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

    it('enters task mode from a real Git baseline with the declared scope materialized', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-fixture-materialized-scope';
        const declaredNewFile = 'src/declared-new.ts';
        try {
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
            writePreflight(repoRoot, taskId, {
                changed_files: ['src/app.ts', declaredNewFile]
            });

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Materialize declared fixture scope'
            });

            assert.equal(result.exitCode, 0);
            assert.equal(fs.existsSync(path.join(repoRoot, '.git')), true);
            assert.equal(
                outputFiltersPath,
                path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'test-config', 'output-filters.json')
            );
            assert.equal(
                runGit(repoRoot, ['status', '--porcelain', '--', 'src/app.ts']).stdout.trim(),
                'M src/app.ts'
            );
            assert.equal(fs.existsSync(path.join(repoRoot, declaredNewFile)), false);
            assert.equal(
                runGit(repoRoot, ['status', '--porcelain', '--', declaredNewFile]).stdout.trimEnd(),
                ` D ${declaredNewFile}`
            );
            assert.equal(
                runGit(repoRoot, [
                    'status',
                    '--porcelain',
                    '--',
                    path.relative(repoRoot, outputFiltersPath).replace(/\\/g, '/')
                ]).stdout.trim(),
                ''
            );
        } finally {
            removeTempRepoWithRetry(repoRoot);
        }
    });

    it('rejects a dangling changed-file symlink before materializing the Git baseline', (t) => {
        const repoRoot = createTempRepo();
        const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-dangling-scope-'));
        const outsideTarget = path.join(outsideRoot, 'missing-target.ts');
        const symlinkPath = path.join(repoRoot, 'src', 'dangling.ts');
        try {
            try {
                fs.symlinkSync(outsideTarget, symlinkPath, 'file');
            } catch (error: unknown) {
                const errorCode = (error as NodeJS.ErrnoException).code;
                if (process.platform === 'win32' && ['EACCES', 'EPERM', 'UNKNOWN'].includes(String(errorCode))) {
                    try {
                        fs.symlinkSync(outsideTarget, symlinkPath, 'junction');
                    } catch (junctionError: unknown) {
                        const junctionErrorCode = (junctionError as NodeJS.ErrnoException).code;
                        t.skip(
                            `Symlink and junction creation unavailable: file=${String(errorCode)}, `
                            + `junction=${String(junctionErrorCode)}`
                        );
                        return;
                    }
                } else {
                    throw error;
                }
            }

            assert.throws(
                () => initializeGitRepoWithMaterializedScope(repoRoot, ['src/dangling.ts']),
                /must not traverse a symlink/
            );
            assert.equal(fs.existsSync(outsideTarget), false);
            assert.equal(fs.existsSync(path.join(repoRoot, '.git')), false);
        } finally {
            removeTempRepoWithRetry(repoRoot);
            fs.rmSync(outsideRoot, {recursive: true, force: true});
        }
    });
});
