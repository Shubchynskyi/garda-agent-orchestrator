import assert from 'node:assert/strict';
import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

const GIT_FIXTURE_CONFIG_ARGS = [
    '-c',
    'init.defaultBranch=main',
    '-c',
    'commit.gpgsign=false',
    '-c',
    'tag.gpgsign=false',
    '-c',
    'core.hooksPath='
];
const DEFAULT_GIT_SETUP_RETRY_DELAYS_MS = [0, 25, 100];
const RETRYABLE_GIT_SETUP_PATTERN = /\b(?:EACCES|EBUSY|ENOTEMPTY|EPERM|Permission denied)\b|\.git[\\/]+config|could not set ['"]?core\./iu;

export type InitGitRepoOptions = {
    allowEmptyCommit?: boolean;
    gitignoreContent?: string | null;
    initialCommitMessage?: string;
    stageAll?: boolean;
    userEmail?: string;
    userName?: string;
};

type RunGitFixtureOptions = {
    retryDelaysMs?: readonly number[];
    spawnSync?: (
        command: string,
        args: readonly string[],
        options: childProcess.SpawnSyncOptionsWithStringEncoding
    ) => childProcess.SpawnSyncReturns<string>;
};

function formatGitFixtureOutput(value: string | null | undefined): string {
    const output = String(value || '').trim();
    return output || '<empty>';
}

function sleepSync(delayMs: number): void {
    if (delayMs <= 0) {
        return;
    }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function isGitSetupCommand(args: readonly string[]): boolean {
    return args.some((arg) => arg === 'init');
}

function formatGitFixtureCombinedOutput(result: childProcess.SpawnSyncReturns<string>): string {
    return [
        result.error instanceof Error ? result.error.message : '',
        result.stderr || '',
        result.stdout || ''
    ].filter(Boolean).join('\n');
}

function isRetryableGitSetupFailure(args: readonly string[], result: childProcess.SpawnSyncReturns<string>): boolean {
    return isGitSetupCommand(args) && RETRYABLE_GIT_SETUP_PATTERN.test(formatGitFixtureCombinedOutput(result));
}

export function runGitFixtureCommand(
    repoRoot: string,
    args: string[],
    options: RunGitFixtureOptions = {}
): childProcess.SpawnSyncReturns<string> {
    const spawnSync = options.spawnSync || childProcess.spawnSync;
    const retryDelaysMs = isGitSetupCommand(args)
        ? (options.retryDelaysMs || DEFAULT_GIT_SETUP_RETRY_DELAYS_MS)
        : [0];
    let result: childProcess.SpawnSyncReturns<string> | null = null;
    for (let attempt = 0; attempt < retryDelaysMs.length; attempt += 1) {
        sleepSync(retryDelaysMs[attempt] || 0);
        result = spawnSync('git', [...GIT_FIXTURE_CONFIG_ARGS, ...args], {
            cwd: repoRoot,
            encoding: 'utf8',
            env: {
                ...process.env,
                GIT_EDITOR: 'true',
                GIT_TERMINAL_PROMPT: '0'
            },
            windowsHide: true
        });
        if (!result.error && result.status === 0) {
            return result;
        }
        if (!isRetryableGitSetupFailure(args, result)) {
            break;
        }
    }
    assert.ok(result, `Git fixture command did not run: git ${args.join(' ')}`);
    if (result.error && !isRetryableGitSetupFailure(args, result)) {
        throw result.error;
    }
    assert.equal(
        result.status,
        0,
        [
            `Git fixture command failed: git ${args.join(' ')}`,
            `cwd: ${repoRoot}`,
            `stdout: ${formatGitFixtureOutput(result.stdout)}`,
            `stderr: ${formatGitFixtureOutput(result.stderr)}`
        ].join('\n')
    );
    return result;
}

export function writeGitFixtureConfig(repoRoot: string, options: InitGitRepoOptions = {}): void {
    const configPath = path.join(repoRoot, '.git', 'config');
    if (!fs.existsSync(configPath)) {
        return;
    }
    const userName = options.userName || 'Garda Test';
    const userEmail = options.userEmail || 'garda-test@example.invalid';
    fs.appendFileSync(
        configPath,
        `\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = ${userName}\n\temail = ${userEmail}\n`,
        'utf8'
    );
}

export function initGitRepo(repoRoot: string, options: InitGitRepoOptions = {}): void {
    if (options.gitignoreContent !== null) {
        fs.writeFileSync(
            path.join(repoRoot, '.gitignore'),
            options.gitignoreContent || 'garda-agent-orchestrator/runtime/\n',
            'utf8'
        );
    }

    runGitFixtureCommand(repoRoot, ['init']);
    writeGitFixtureConfig(repoRoot, options);

    if (options.stageAll !== false) {
        runGitFixtureCommand(repoRoot, ['add', '.']);
    }

    const commitArgs = ['commit'];
    if (options.allowEmptyCommit) {
        commitArgs.push('--allow-empty');
    }
    commitArgs.push('-m', options.initialCommitMessage || 'baseline');
    runGitFixtureCommand(repoRoot, commitArgs);
}
