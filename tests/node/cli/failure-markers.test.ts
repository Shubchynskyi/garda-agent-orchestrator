import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';
import { createHash } from 'node:crypto';
import { computeProtectedSnapshotDigest } from '../../../src/gates/protected-control-plane/protected-control-plane';
import {
    EXIT_GENERAL_FAILURE,
    EXIT_VALIDATION_FAILURE,
    EXIT_USAGE_ERROR
} from '../../../src/cli/exit-codes';
import { runCliRuntimeMainWithHandling } from '../../../src/cli/runtime-main';

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
    fs.mkdirSync(path.join(bundleDir, 'live', 'config'), { recursive: true });
    fs.writeFileSync(path.join(bundleDir, 'MANIFEST.md'), '# MANIFEST\n', 'utf8');
    fs.writeFileSync(path.join(bundleDir, 'VERSION'), '1.0.0\n', 'utf8');
    const workflowConfig = {
        full_suite_validation: {
            enabled: false,
            command: '__FULL_SUITE_COMMAND_UNCONFIGURED__',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        task_reset: {
            enabled: true
        }
    };
    const workflowConfigText = JSON.stringify(workflowConfig, null, 2) + '\n';
    const workflowConfigPath = path.join(bundleDir, 'live', 'config', 'workflow-config.json');
    fs.writeFileSync(workflowConfigPath, workflowConfigText, 'utf8');
    const auditRecord = {
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: '2026-05-13T00:00:00.000Z',
        actor: 'operator_command',
        command: 'workflow set',
        config_path: workflowConfigPath.replace(/\\/g, '/'),
        changed_fields: ['task_reset.enabled'],
        before_sha256: createHash('sha256').update('before', 'utf8').digest('hex'),
        after_sha256: createHash('sha256').update(workflowConfigText, 'utf8').digest('hex')
    };
    const auditLine = JSON.stringify(auditRecord);
    fs.writeFileSync(path.join(bundleDir, 'runtime', 'workflow-config-audit.jsonl'), `${auditLine}\n`, 'utf8');
    const receiptPayload = {
        event_source: 'task-reset-enablement-receipt',
        command: 'workflow set',
        config_path: auditRecord.config_path,
        changed_fields: auditRecord.changed_fields,
        after_sha256: auditRecord.after_sha256,
        audit_record_sha256: createHash('sha256').update(auditLine, 'utf8').digest('hex')
    };
    const receiptText = `${JSON.stringify({
        schema_version: 1,
        ...receiptPayload,
        timestamp_utc: '2026-05-13T00:00:00.000Z',
        actor: 'operator_command',
        receipt_sha256: createHash('sha256').update(JSON.stringify(receiptPayload), 'utf8').digest('hex')
    }, null, 2)}\n`;
    fs.writeFileSync(path.join(bundleDir, 'live', 'config', 'task-reset-enablement-receipt.json'), receiptText, 'utf8');
    const protectedSnapshot = {
        'garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json': createHash('sha256').update(receiptText, 'utf8').digest('hex')
    };
    fs.writeFileSync(path.join(bundleDir, 'runtime', 'protected-control-plane-manifest.json'), `${JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: '2026-05-13T00:00:00.000Z',
        workspace_root: targetRoot.replace(/\\/g, '/'),
        orchestrator_root: bundleDir.replace(/\\/g, '/'),
        protected_roots: ['garda-agent-orchestrator/live/config/task-reset-enablement-receipt.json'],
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: false
    }, null, 2)}\n`, 'utf8');
}

test('bootstrap with invalid flag produces GARDA_BOOTSTRAP_FAILED with EXIT_USAGE_ERROR', () => {
    const { exitCode, stderr } = runCli(['bootstrap', '--no-such-flag']);
    assert.equal(exitCode, EXIT_USAGE_ERROR);
    assert.ok(stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Expected GARDA_BOOTSTRAP_FAILED in stderr');
});

test('unknown top-level command fails as CLI usage and does not bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-unknown-command-'));
    try {
        const { exitCode, stderr } = runCli(['nosuch'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
        assert.ok(stderr.includes('Unsupported command: nosuch'));
        assert.ok(!fs.existsSync(path.join(tmpDir, 'nosuch')), 'unknown command must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('unknown top-level flag fails as CLI usage and does not bootstrap', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-unknown-flag-command-'));
    try {
        const { exitCode, stderr } = runCli(['--no-such-flag'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(!stderr.includes('GARDA_BOOTSTRAP_FAILED'), 'Should not contain GARDA_BOOTSTRAP_FAILED');
        assert.ok(stderr.includes('Unsupported command: --no-such-flag'));
        assert.ok(!fs.existsSync(path.join(tmpDir, '--no-such-flag')), 'unknown flag must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('global help and version remain side-effect free top-level flags', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-global-flags-'));
    try {
        const helpResult = runCli(['--help'], tmpDir);
        assert.equal(helpResult.exitCode, 0);
        assert.ok(helpResult.stdout.includes('Usage:'));
        assert.ok(!helpResult.stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(!fs.existsSync(path.join(tmpDir, '--help')), 'global help must not create a bootstrap destination');

        const versionResult = runCli(['--version'], tmpDir);
        assert.equal(versionResult.exitCode, 0);
        assert.match(versionResult.stdout.trim(), /^\d+\.\d+\.\d+/);
        assert.ok(!versionResult.stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(!fs.existsSync(path.join(tmpDir, '--version')), 'global version must not create a bootstrap destination');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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

test('task-reset alias does not treat option flags as positional task ids', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-alias-flags-'));
    try {
        const { exitCode, stderr } = runCli(['task-reset', '--reopen', '--dry-run'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(stderr.includes('TaskId must not be empty.'));
        assert.ok(stderr.includes('garda gate task-reset --task-id "<task-id>" --reopen --dry-run --repo-root "."'));
        assert.ok(!stderr.includes("Task '--reopen' not found"), 'flag must not be consumed as task id');
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

test('task reset alias does not treat confirm flag as positional task id', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-task-reset-alias-flags-'));
    try {
        const { exitCode, stderr } = runCli(['task', 'reset', '--confirm'], tmpDir);
        assert.equal(exitCode, EXIT_USAGE_ERROR);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'), 'Expected GARDA_CLI_FAILED in stderr');
        assert.ok(stderr.includes('TaskId must not be empty.'));
        assert.ok(stderr.includes('garda gate task-reset --task-id "<task-id>" --reopen --dry-run --repo-root "."'));
        assert.ok(!stderr.includes("Task '--confirm' not found"), 'flag must not be consumed as task id');
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
        assert.equal(exitCode, EXIT_VALIDATION_FAILURE, stderr);
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

test('preflight containment failures preserve gate-specific markers and candidate diagnostics', async () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-preflight-workspace-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-preflight-containment-'));
    try {
        const outsidePreflightPath = path.join(outsideRoot, 'T-path-containment-preflight.json');
        fs.writeFileSync(outsidePreflightPath, '{}\n', 'utf8');

        for (const [gateName, expectedMarker] of [
            ['required-reviews-check', 'REVIEW_GATE_FAILED'],
            ['full-suite-validation', 'FULL_SUITE_VALIDATION_FAILED'],
            ['compile-gate', 'COMPILE_GATE_FAILED']
        ] as const) {
            const errors: string[] = [];
            const originalConsoleError = console.error;
            const originalExitCode = process.exitCode;
            let exitCode: number | string | undefined;
            try {
                console.error = (...values: unknown[]) => {
                    errors.push(values.map((value) => String(value)).join(' '));
                };
                process.exitCode = undefined;
                await runCliRuntimeMainWithHandling([
                    'gate',
                    gateName,
                    '--task-id', 'T-path-containment',
                    '--preflight-path', outsidePreflightPath,
                    '--repo-root', repoRoot
                ], REPO_ROOT);
                exitCode = process.exitCode;
            } finally {
                console.error = originalConsoleError;
                process.exitCode = originalExitCode;
            }
            const lines = errors.flatMap((line) => line.split(/\r?\n/u)).filter(Boolean);
            const markerIndex = lines.indexOf(expectedMarker);
            const expectedDiagnostic = `PreflightPath must resolve inside repo root without symlink or junction escape: ${
                path.resolve(outsidePreflightPath)
            }`;
            const stderr = lines.join('\n');

            assert.equal(typeof exitCode, 'number');
            assert.notEqual(exitCode, 0);
            assert.notEqual(markerIndex, -1, stderr);
            assert.equal(lines[markerIndex + 1], expectedDiagnostic);
        }
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    }
});

test('gate validate-manifest returns EXIT_VALIDATION_FAILURE when manifest is invalid', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-manifest-validation-'));
    try {
        const manifestPath = path.join(tmpDir, 'MANIFEST.md');
        fs.writeFileSync(manifestPath, '- ../escape.txt\n', 'utf8');

        const { exitCode, stderr } = runCli([
            'gate',
            'validate-manifest',
            '--manifest-path',
            'MANIFEST.md',
            '--repo-root',
            tmpDir
        ]);
        assert.equal(exitCode, EXIT_VALIDATION_FAILURE, stderr);
        assert.ok(stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(stderr.includes('Manifest validation failed.'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gate validate-manifest resolves relative and absolute manifest paths from explicit repo root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-manifest-root-'));
    try {
        const nestedDir = path.join(tmpDir, 'nested');
        const manifestPath = path.join(nestedDir, 'MANIFEST.md');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(manifestPath, '- src/app.ts\n', 'utf8');

        const relativeResult = runCli([
            'gate',
            'validate-manifest',
            '--manifest-path',
            path.join('nested', 'MANIFEST.md'),
            '--repo-root',
            tmpDir
        ]);
        assert.equal(relativeResult.exitCode, 0, relativeResult.stderr);
        assert.ok(relativeResult.stdout.includes('MANIFEST_VALIDATION_PASSED'));

        const absoluteResult = runCli([
            'gate',
            'validate-manifest',
            '--manifest-path',
            manifestPath,
            '--repo-root',
            tmpDir
        ]);
        assert.equal(absoluteResult.exitCode, 0, absoluteResult.stderr);
        assert.ok(absoluteResult.stdout.includes('MANIFEST_VALIDATION_PASSED'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('gate validate-manifest rejects a manifest path outside explicit repo root', () => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-manifest-contained-root-'));
    const outsideRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-manifest-outside-root-'));
    try {
        const outsideManifestPath = path.join(outsideRoot, 'MANIFEST.md');
        fs.writeFileSync(outsideManifestPath, '- src/app.ts\n', 'utf8');
        const result = runCli([
            'gate',
            'validate-manifest',
            '--manifest-path',
            path.relative(repoRoot, outsideManifestPath),
            '--repo-root',
            repoRoot
        ]);
        assert.equal(result.exitCode, EXIT_GENERAL_FAILURE, result.stderr);
        assert.ok(result.stderr.includes('GARDA_CLI_FAILED'));
        assert.ok(result.stderr.includes('--manifest-path must resolve inside workspace root'));
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
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
