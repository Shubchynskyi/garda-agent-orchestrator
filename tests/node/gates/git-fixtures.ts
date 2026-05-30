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

export type InitGitRepoOptions = {
    allowEmptyCommit?: boolean;
    gitignoreContent?: string | null;
    initialCommitMessage?: string;
    stageAll?: boolean;
    userEmail?: string;
    userName?: string;
};

function formatGitFixtureOutput(value: string | null | undefined): string {
    const output = String(value || '').trim();
    return output || '<empty>';
}

export function runGitFixtureCommand(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    const result = childProcess.spawnSync('git', [...GIT_FIXTURE_CONFIG_ARGS, ...args], {
        cwd: repoRoot,
        encoding: 'utf8',
        env: {
            ...process.env,
            GIT_EDITOR: 'true',
            GIT_TERMINAL_PROMPT: '0'
        },
        windowsHide: true
    });
    if (result.error) {
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
