import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildGateHelpText
} from '../../../../../../src/cli/commands/gate-command-help';
import {
    getNodeHumanCommitCommand
} from '../../../../../../src/materialization/command-constants';
import {
    buildCommitGuardManagedBlock
} from '../../../../../../src/materialization/content-builders';
import {
    runHumanCommitCommand} from '../../../../../../src/cli/commands/gates';
import * as childProcess from 'node:child_process';

import {
    createTempRepo,
    runGit} from '../../gate-test-helpers';


function stripAnsi(value: string): string {
    return value.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '');
}

function getLegacyBundleNameFixture(): string {
    return ['ai', 'agent', 'orchestrator'].join('-');
}

function writeCommitGuardHook(repoRoot: string): void {
    const hookPath = path.join(repoRoot, '.git', 'hooks', 'pre-commit');
    fs.mkdirSync(path.dirname(hookPath), { recursive: true });
    fs.writeFileSync(hookPath, `#!/usr/bin/env bash\n\n${buildCommitGuardManagedBlock()}\n`, 'utf8');
    fs.chmodSync(hookPath, 0o755);
}

function restoreProcessEnvValue(key: string, value: string | undefined): void {
    if (typeof value === 'undefined') {
        delete process.env[key];
        return;
    }
    process.env[key] = value;
}


// Manual review-context fixtures are used only by CLI routing/receipt tests that
// do not exercise production review-context construction.














describe('gates command human commit', () => {

    it('runs human commit through git with commit guard override', async () => {
        const repoRoot = createTempRepo();

        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
        runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
        runGit(repoRoot, ['add', '.']);

        const exitCode = await runHumanCommitCommand(['--operator-confirmed', 'yes', '-m', 'test: initial commit'], { cwd: repoRoot });
        const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        assert.equal(exitCode, 0);
        assert.match(logResult.stdout, /test: initial commit/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects human-commit without explicit operator confirmation', async () => {
        await assert.rejects(
            () => runHumanCommitCommand(['-m', 'test: missing confirmation'], { cwd: process.cwd() }),
            /requires explicit operator confirmation/
        );
    });

    it('rejects stale human-commit operator confirmation timestamps', async () => {
        const staleConfirmation = new Date(Date.now() - 11 * 60 * 1000).toISOString();
        await assert.rejects(
            () => runHumanCommitCommand([
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', staleConfirmation,
                '-m', 'test: stale confirmation'
            ], { cwd: process.cwd() }),
            /operator confirmation is stale/
        );
    });

    it('rejects invalid human-commit operator confirmation timestamps', async () => {
        await assert.rejects(
            () => runHumanCommitCommand([
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', 'not-a-timestamp',
                '-m', 'test: invalid confirmation timestamp'
            ], { cwd: process.cwd() }),
            /must be a valid ISO-8601 timestamp/
        );
    });

    it('rejects future human-commit operator confirmation timestamps', async () => {
        const futureConfirmation = new Date(Date.now() + 2 * 60 * 1000).toISOString();
        await assert.rejects(
            () => runHumanCommitCommand([
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', futureConfirmation,
                '-m', 'test: future confirmation timestamp'
            ], { cwd: process.cwd() }),
            /timestamp is in the future/
        );
    });

    it('pins human-commit operator confirmation command surfaces', () => {
        const expectedCommand = 'human-commit --operator-confirmed yes --message';
        const legacyBundleName = getLegacyBundleNameFixture();
        const guardBlock = buildCommitGuardManagedBlock();
        const helpOutput = stripAnsi(buildGateHelpText('human-commit', path.resolve('.')));
        const cliReference = fs.readFileSync(path.resolve('docs/cli-reference.md'), 'utf8');
        const templateCommands = fs.readFileSync(path.resolve('template/docs/agent-rules/40-commands.md'), 'utf8');
        const liveCommandsPath = path.resolve('garda-agent-orchestrator/live/docs/agent-rules/40-commands.md');

        assert.ok(getNodeHumanCommitCommand().includes('human-commit --operator-confirmed yes --message "<message>"'));
        assert.ok(guardBlock.includes('node garda-agent-orchestrator/bin/garda.js gate human-commit --operator-confirmed yes'));
        assert.ok(!guardBlock.includes(legacyBundleName));
        assert.ok(helpOutput.includes('gate human-commit --operator-confirmed yes --message "<commit message>"'));
        assert.ok(cliReference.includes('garda gate human-commit --operator-confirmed yes --message "<message>"'));
        assert.ok(templateCommands.includes(`gate ${expectedCommand} "<message>"`));
        assert.ok(templateCommands.includes('operator answers `Do you want me to commit now? (yes/no)` with yes'));
        if (fs.existsSync(liveCommandsPath)) {
            const liveCommands = fs.readFileSync(liveCommandsPath, 'utf8');
            assert.ok(liveCommands.includes(`gate ${expectedCommand} "<message>"`));
            assert.ok(liveCommands.includes('operator answers `Do you want me to commit now? (yes/no)` with yes'));
        }
    });

    it('lets Codex human-commit bypass the installed commit guard while direct git commit stays blocked', async () => {
        const repoRoot = createTempRepo();
        const previousCodexHome = process.env.CODEX_HOME;
        try {
            runGit(repoRoot, ['init']);
            runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
            runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
            writeCommitGuardHook(repoRoot);
            runGit(repoRoot, ['add', '.']);

            const blockedCommit = childProcess.spawnSync('git', ['commit', '-m', 'test: blocked codex commit'], {
                cwd: repoRoot,
                windowsHide: true,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'pipe'],
                env: { ...process.env, CODEX_HOME: path.join(repoRoot, '.codex') }
            });
            const blockedOutput = `${blockedCommit.stdout || ''}\n${blockedCommit.stderr || ''}`;

            assert.notEqual(blockedCommit.status, 0);
            assert.match(blockedOutput, /Commit blocked: agent commit guard is enabled/);
            assert.match(blockedOutput, /node garda-agent-orchestrator\/bin\/garda\.js gate human-commit --operator-confirmed yes/);
            assert.ok(!blockedOutput.includes(getLegacyBundleNameFixture()));

            process.env.CODEX_HOME = path.join(repoRoot, '.codex');
            const exitCode = await runHumanCommitCommand([
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString(),
                '--message', 'test: codex human commit'
            ], { cwd: repoRoot });
            const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
                cwd: repoRoot,
                windowsHide: true,
                encoding: 'utf8',
                stdio: ['ignore', 'pipe', 'ignore']
            });

            assert.equal(exitCode, 0);
            assert.match(logResult.stdout, /test: codex human commit/);
        } finally {
            restoreProcessEnvValue('CODEX_HOME', previousCodexHome);
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('runs documented human-commit command with repo root gate option', async () => {
        const repoRoot = createTempRepo();
        const parentCwd = path.dirname(repoRoot);

        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
        runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
        runGit(repoRoot, ['add', '.']);

        const exitCode = await runHumanCommitCommand([
            '--operator-confirmed', 'yes',
            '--operator-confirmed-at-utc', new Date().toISOString(),
            '--message', 'test: documented human commit',
            '--repo-root', path.basename(repoRoot)
        ], { cwd: parentCwd });
        const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        assert.equal(exitCode, 0);
        assert.match(logResult.stdout, /test: documented human commit/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runs human-commit with inline repo root gate option', async () => {
        const repoRoot = createTempRepo();
        const parentCwd = path.dirname(repoRoot);

        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
        runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
        runGit(repoRoot, ['add', '.']);

        const exitCode = await runHumanCommitCommand([
            '--operator-confirmed=yes',
            '--repo-root=' + path.basename(repoRoot),
            '--message', 'test: inline repo root human commit'
        ], { cwd: parentCwd });
        const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        assert.equal(exitCode, 0);
        assert.match(logResult.stdout, /test: inline repo root human commit/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects human-commit repo root without a value', async () => {
        await assert.rejects(
            () => runHumanCommitCommand(['--repo-root'], { cwd: process.cwd() }),
            /--repo-root requires a value\./
        );
        await assert.rejects(
            () => runHumanCommitCommand(['--repo-root='], { cwd: process.cwd() }),
            /--repo-root requires a value\./
        );
    });
});
