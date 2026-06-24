import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    EXIT_GENERAL_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    executeCommand,
    executeCommandAsync
} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { formatCompileOutputEntry } from '../../../../../../src/cli/commands/gates/gates-formatter';

import {
    createTempRepo,
    createWindowsBatchNodeFixture,
    createDependentValidationFixture,
    seedTaskQueue,
    seedInitAnswers,
    writeNodeFoundationManifest,
    runEnterTaskMode,
    loadTaskEntryRulePack,
    initializeGitRepo,
    captureExpectedAsyncError,
    ageFixturePath
} from '../../gate-test-helpers';




// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.














describe('gates command timeout and execution wrappers', () => {
    it('runs a simple command successfully with default timeout', () => {
        const result = executeCommand(`node -e "console.log('hello')"`, {
            cwd: process.cwd()
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(line => line.includes('hello')));
        assert.equal(result.timedOut, false);
    });

    it('redacts secrets from synchronous command output', () => {
        const result = executeCommand(`node -e "console.log('Authorization: Bearer ghp_abcdefghijklmnopqrstuvwxyz123456')"`, {
            cwd: process.cwd()
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(line => line.includes('Authorization: Bearer <redacted>')));
        assert.ok(result.outputLines.every(line => !line.includes('abcdefghijklmnopqrstuvwxyz123456')));
    });

    it('redacts secrets from asynchronous command output', async () => {
        const result = await executeCommandAsync(`node -e "console.error('NPM_TOKEN=npm_abcdefghijklmnopqrstuvwxyz123456')"`, {
            cwd: process.cwd(),
            timeoutMs: 10_000
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(line => line.includes('NPM_TOKEN=<redacted>')));
        assert.ok(result.outputLines.every(line => !line.includes('abcdefghijklmnopqrstuvwxyz123456')));
    });

    it('redacts secrets from compile output command headers', () => {
        const text = formatCompileOutputEntry(
            1,
            1,
            'npm test -- TOKEN=compile-command-secret',
            ['ok']
        );

        assert.ok(!text.includes('compile-command-secret'));
        assert.ok(text.includes('COMMAND: npm test -- TOKEN=<redacted>'));
    });

    it('reports timedOut when command exceeds specified timeout', () => {
        const result = executeCommand(
            `node -e "const s=Date.now();while(Date.now()-s<10000){}"`,
            { cwd: process.cwd(), timeoutMs: 500 }
        );
        assert.equal(result.timedOut, true);
        assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
        assert.ok(result.outputLines.some(line => /timed out/i.test(line)));
    });

    it('throws ENOENT for missing executable', () => {
        assert.throws(
            () => executeCommand('__nonexistent_executable_12345__', { cwd: process.cwd() }),
            /not found in PATH/
        );
    });

    it('blocks direct .node-build sync consumers when the node-foundation producer output is stale', () => {
        const fixture = createDependentValidationFixture();
        try {
            writeNodeFoundationManifest(fixture.manifestPath);
            ageFixturePath(fixture.manifestPath, 10_000);
            fs.writeFileSync(fixture.sourcePath, 'export const feature = false;\n', 'utf8');

            assert.throws(
                () => executeCommand(`node --test "${fixture.consumerPath}"`, { cwd: fixture.repoRoot }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*npm run build:node-foundation.*Do not run the producer and consumer in parallel/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build async consumers while the node-foundation producer lock is active', async () => {
        const fixture = createDependentValidationFixture();
        try {
            ageFixturePath(fixture.sourcePath, 10_000);
            writeNodeFoundationManifest(fixture.manifestPath);
            fs.mkdirSync(fixture.lockPath, { recursive: true });
            fs.writeFileSync(path.join(fixture.lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                startedAtUtc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            const error = await captureExpectedAsyncError(() => executeCommandAsync(
                `node --test "${fixture.consumerPath}"`,
                { cwd: fixture.repoRoot, timeoutMs: 10_000 }
            ).then(() => undefined));
            assert.match(
                error.message,
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*producer lock.*npm test/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build consumers from nested cwd values that point back to the repo artifact root', () => {
        const fixture = createDependentValidationFixture();
        try {
            const nestedConsumerPath = path.relative(fixture.nestedCwd, fixture.consumerPath);
            assert.throws(
                () => executeCommand(`node --test "${nestedConsumerPath}"`, { cwd: fixture.nestedCwd }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for sync execution on Windows', () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_SYNC\r\n', 'utf8');
            const result = executeCommand('npm --version', { cwd: repoRoot });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_SYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for async execution on Windows', async () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_ASYNC\r\n', 'utf8');
            const result = await executeCommandAsync('npm --version', { cwd: repoRoot, timeoutMs: 10_000 });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_ASYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('forwards quoted batch arguments through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = executeCommand(`"${fixture.batchPath}" "safe literal"`, { cwd: process.cwd() });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('forwards quoted batch arguments through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}" "safe literal"`, {
                cwd: process.cwd(),
                timeoutMs: 10_000
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = executeCommand(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });

    it('CLI dependent-preflight handlers accept --task-mode-path and honor a custom task-mode artifact location', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-cli-dependent-preflight-custom-task-mode';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor custom task-mode path through CLI dependent-preflight handlers',
            provider: 'Codex'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let handshakeExitCode = 0;
        let shellSmokeExitCode = 0;
        let commandTimeoutExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'handshake-diagnostics',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-mode-path', customTaskModePath
            ]);
            handshakeExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'shell-smoke-preflight',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-mode-path', customTaskModePath
            ]);
            shellSmokeExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'command-timeout-diagnostics',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-mode-path', customTaskModePath
            ]);
            commandTimeoutExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(handshakeExitCode, 0);
        assert.equal(shellSmokeExitCode, 0);
        assert.equal(commandTimeoutExitCode, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('redacts multiline quoted secrets from synchronous command output', () => {
        const result = executeCommand(`node -e "process.stdout.write(Buffer.from('QVBJX1RPS0VOPSJsaW5lIG9uZQpsaW5lIHR3byIK', 'base64').toString())"`, {
            cwd: process.cwd()
        });
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.outputLines, ['API_TOKEN="<redacted>"']);
        assert.ok(result.outputLines.every(line => !line.includes('line one') && !line.includes('line two')));
    });

    it('redacts multiline quoted secrets from asynchronous command output', async () => {
        const result = await executeCommandAsync(`node -e "process.stderr.write(Buffer.from('QVBJX1RPS0VOPSJsaW5lIG9uZQpsaW5lIHR3byIK', 'base64').toString())"`, {
            cwd: process.cwd(),
            timeoutMs: 10_000
        });
        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.outputLines, ['API_TOKEN="<redacted>"']);
        assert.ok(result.outputLines.every(line => !line.includes('line one') && !line.includes('line two')));
    });
});
