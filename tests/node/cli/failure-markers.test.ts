import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import {
    EXIT_GENERAL_FAILURE,
    EXIT_VALIDATION_FAILURE,
    EXIT_USAGE_ERROR
} from '../../../src/cli/exit-codes';

function isWorkspaceRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, 'package.json')) &&
        fs.existsSync(path.join(candidate, 'VERSION')) &&
        fs.existsSync(path.join(candidate, 'bin', 'garda.js')) &&
        fs.existsSync(path.join(candidate, 'src', 'index.ts'));
}

function findRepoRoot(startDir: string): string {
    const cwd = path.resolve(process.cwd());
    if (isWorkspaceRoot(cwd)) {
        return cwd;
    }

    let current = path.resolve(startDir);
    while (true) {
        if (isWorkspaceRoot(current)) {
            return current;
        }
        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

const REPO_ROOT = findRepoRoot(__dirname);
const CLI_PATH = path.join(REPO_ROOT, 'bin', 'garda.js');
const NEUTRAL_CWD = path.join(REPO_ROOT, 'tests');

function runCli(args: string[], cwd = NEUTRAL_CWD) {
    const result = childProcess.spawnSync(
        process.execPath,
        [CLI_PATH, ...args],
        { cwd, windowsHide: true, encoding: 'utf8', timeout: 30000 }
    );
    const combined = (result.stdout || '') + (result.stderr || '');
    return { exitCode: result.status, output: combined, stderr: result.stderr || '', stdout: result.stdout || '' };
}

function writeValidInitAnswersFixture(targetRoot: string): void {
    const runtimeDir = path.join(targetRoot, 'garda-agent-orchestrator', 'runtime');
    fs.mkdirSync(runtimeDir, { recursive: true });
    fs.writeFileSync(path.join(runtimeDir, 'init-answers.json'), JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: 'Claude',
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true'
    }), 'utf8');
}

function writeTaskResetFixture(targetRoot: string, taskStatus = 'IN_PROGRESS'): void {
    fs.writeFileSync(
        path.join(targetRoot, 'TASK.md'),
        [
            '| Task ID | Status | Description | Notes |',
            '|---------|--------|-------------|-------|',
            `| T-001 | ${taskStatus} | Test reset task | - |`
        ].join('\n') + '\n',
        'utf8'
    );
    const bundleDir = path.join(targetRoot, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleDir, 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(bundleDir, 'runtime', 'reviews'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.md'), '# MANIFEST\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'VERSION'), '1.0.0\n', 'utf8');
}

test('bootstrap with invalid flag produces GARDA_BOOTSTRAP_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['bootstrap', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Expected GARDA_BOOTSTRAP_FAILED in stderr');
});

test('implicit bootstrap (unrecognised first arg) produces GARDA_BOOTSTRAP_FAILED', () => {
    const { exitCode, stderr } = runCli(['--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Expected GARDA_BOOTSTRAP_FAILED in stderr');
});

test('task-reset alias without task id fails as CLI usage and does not bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-alias-'));
    try {
        const { exitCode, stderr } = runCli(['task-reset'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
        assert.ok(stderr.includes('garda gate task-reset --task-id "<task-id>" --reopen --dry-run --repo-root "."'));
        assert.ok(!fs.existsSync(path.join(tmpDir, 'task-reset')), 'task-reset alias must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('task reset alias without task id fails as CLI usage and does not bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-alias-'));
    try {
        const { exitCode, stderr } = runCli(['task', 'reset'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
        assert.ok(stderr.includes('garda gate task-reset --task-id "<task-id>" --reopen --confirm --repo-root "."'));
        assert.ok(!fs.existsSync(path.join(tmpDir, 'task')), 'task reset alias must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('taskreset near-miss fails before implicit bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-near-miss-'));
    try {
        const { exitCode, stderr } = runCli(['taskreset', '--task-id', 'T-001'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
        assert.ok(stderr.includes('Unsupported command: taskreset'));
        assert.ok(stderr.includes('garda gate task-reset --task-id "T-001" --reopen --dry-run --repo-root "."'));
        assert.ok(!fs.existsSync(path.join(tmpDir, 'taskreset')), 'near-miss must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('task-reset alias dry-run routes through guarded task-reset gate', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-dry-run-'));
    try {
        writeTaskResetFixture(tmpDir);
        const { exitCode, output } = runCli(['task-reset', '--task-id', 'T-001', '--reopen', '--dry-run', '--repo-root', tmpDir], tmpDir);
        assert.equal(exitCode, 0);
        assert.ok(output.includes('DRY_RUN'));
        assert.ok(!output.includes('GARDA_CLI_FAILED'));
        const taskMd = fs.readFileSync(path.join(tmpDir, 'TASK.md'), 'utf8');
        assert.ok(taskMd.includes('| T-001 | IN_PROGRESS |'), 'dry-run must not update task status');
        assert.ok(!fs.existsSync(path.join(tmpDir, 'task-reset')), 'dry-run alias must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('task reset alias confirm without target status is rejected', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-confirm-'));
    try {
        writeTaskResetFixture(tmpDir);
        const { exitCode, output } = runCli(['task', 'reset', 'T-001', '--confirm', '--repo-root', tmpDir], tmpDir);
        assert.equal(exitCode, 1);
        assert.ok(output.includes('TARGET_STATUS_REQUIRED'));
        const taskMd = fs.readFileSync(path.join(tmpDir, 'TASK.md'), 'utf8');
        assert.ok(taskMd.includes('| T-001 | IN_PROGRESS |'), 'ambiguous confirm must not update task status');
        assert.ok(!fs.existsSync(path.join(tmpDir, 'task')), 'confirm alias must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('task reset alias reopen confirm routes through guarded task-reset gate', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-confirm-'));
    try {
        writeTaskResetFixture(tmpDir, 'IN_REVIEW');
        const { exitCode, output } = runCli(['task', 'reset', 'T-001', '--reopen', '--confirm', '--repo-root', tmpDir], tmpDir);
        assert.equal(exitCode, 0);
        assert.ok(output.includes('RESET_COMPLETE'));
        assert.ok(output.includes('TargetStatus: TODO'));
        assert.ok(!output.includes('GARDA_CLI_FAILED'));
        const taskMd = fs.readFileSync(path.join(tmpDir, 'TASK.md'), 'utf8');
        assert.ok(taskMd.includes('| T-001 | TODO |'), 'reopen alias should use the canonical guarded reset flow');
        assert.ok(!fs.existsSync(path.join(tmpDir, 'task')), 'confirm alias must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('verify with invalid flag produces GARDA_CLI_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['verify', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
    assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
});

test('verify with validation failures returns EXIT_VALIDATION_FAILURE', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-verify-validation-'));
    try {
        fs.mkdirSync(path.join(tmpDir, 'garda-agent-orchestrator'), { recursive: true });
        writeValidInitAnswersFixture(tmpDir);

        const { exitCode, stderr } = runCli(['verify', '--target-root', tmpDir]);
        assert.equal(exitCode, EXIT_VALIDATION_FAILURE);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(stderr.includes('Workspace verification failed'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gate with invalid gate name produces GARDA_CLI_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['gate', 'nonexistent-gate']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
    assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
});

test('gate validate-manifest returns EXIT_VALIDATION_FAILURE when manifest is invalid', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-manifest-validation-'));
    try {
        const manifestPath = path.join(tmpDir, 'MANIFEST.md');
        fs.writeFileSync(manifestPath, '- ../escape.txt\n', 'utf8');

        const { exitCode, stderr } = runCli(['gate', 'validate-manifest', '--manifest-path', manifestPath]);
        assert.equal(exitCode, EXIT_VALIDATION_FAILURE);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(stderr.includes('Manifest validation failed.'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('uninstall with invalid flag produces GARDA_CLI_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['uninstall', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
    assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
});

test('update with invalid flag produces GARDA_CLI_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['update', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
    assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
});

test('skills with invalid flag produces GARDA_CLI_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['skills', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
    assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
});

test('failure marker is followed by human-readable error message', () => {
    const { stderr } = runCli(['gate', 'nonexistent-gate']);
    const lines = stderr.split(/\r?\n/).filter(Boolean);
    assert.ok(lines.length >= 2, 'Expected at least two non-empty stderr lines (marker + message)');
    assert.equal(lines[0], 'GARDA_CLI_FAILED');
    assert.ok(lines[1].length > 0, 'Expected a human-readable error message after the marker');
});

test('all failure exit codes are non-zero', () => {
    assert.ok(EXIT_GENERAL_FAILURE > 0);
    assert.ok(EXIT_USAGE_ERROR > 0);
});

test('usage error exit code is distinct from general failure', () => {
    assert.notEqual(EXIT_USAGE_ERROR, EXIT_GENERAL_FAILURE);
});
