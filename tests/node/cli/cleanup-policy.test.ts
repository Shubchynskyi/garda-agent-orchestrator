import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    handleCleanupPolicyCommand,
    resolveCleanupPolicyConfigPath
} from '../../../src/cli/commands/cleanup-policy';

function isWorkspaceRoot(candidate: string): boolean {
    return fs.existsSync(path.join(candidate, 'package.json'))
        && fs.existsSync(path.join(candidate, 'VERSION'))
        && fs.existsSync(path.join(candidate, 'bin', 'garda.js'))
        && fs.existsSync(path.join(candidate, 'src', 'index.ts'));
}

function findRepoRoot(): string {
    const cwd = path.resolve(process.cwd());
    if (isWorkspaceRoot(cwd)) {
        return cwd;
    }

    let current = __dirname;
    while (current !== path.dirname(current)) {
        if (isWorkspaceRoot(current)) {
            return current;
        }
        current = path.dirname(current);
    }
    throw new Error(`Cannot resolve repo root from ${__dirname}`);
}

function writeFixture(filePath: string, content: string): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
}

async function captureConsoleAsync(fn: () => Promise<unknown>): Promise<{ lines: string[]; result: unknown }> {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...args: unknown[]) => { lines.push(args.join(' ')); };
    try {
        const result = await fn();
        return { lines, result };
    } finally {
        console.log = originalLog;
    }
}

const REPO_ROOT = findRepoRoot();
const CLI_ENTRY = path.join(REPO_ROOT, 'bin', 'garda.js');
const NEUTRAL_CWD = path.join(REPO_ROOT, 'tests');
const CLEANUP_POLICY_CLI_TIMEOUT_MS = 90_000;
const CLEANUP_POLICY_RUNTIME_LOCK_TIMEOUT_MS = 15_000;

type CleanupPolicyCliResult = ReturnType<typeof spawnSync>;

function textOutput(value: string | Buffer | null | undefined): string {
    if (typeof value === 'string') {
        return value;
    }
    return value ? value.toString('utf8') : '';
}

function combinedOutput(result: CleanupPolicyCliResult): string {
    return `${textOutput(result.stdout)}\n${textOutput(result.stderr)}`;
}

function spawnCleanupPolicyCli(args: string[]): CleanupPolicyCliResult {
    return spawnSync(process.execPath, [
        CLI_ENTRY,
        'cleanup',
        'policy',
        ...args
    ], {
        cwd: NEUTRAL_CWD,
        encoding: 'utf8',
        timeout: CLEANUP_POLICY_CLI_TIMEOUT_MS,
        windowsHide: true,
        env: {
            ...process.env,
            // Keep launcher lock waits below the outer test timeout so failures
            // report the lock root cause instead of surfacing as status=null.
            GARDA_LAUNCHER_RUNTIME_LOCK_TIMEOUT_MS: String(CLEANUP_POLICY_RUNTIME_LOCK_TIMEOUT_MS)
        }
    });
}

function buildCliFailureMessage(result: CleanupPolicyCliResult): string {
    const error = result.error instanceof Error ? result.error : null;
    const errorCode = error && 'code' in error ? String((error as NodeJS.ErrnoException).code || '') : '';
    return [
        combinedOutput(result),
        `status=${result.status === null ? 'null' : String(result.status)}`,
        `signal=${result.signal === null ? 'null' : result.signal}`,
        `error=${error ? error.message : 'none'}`,
        `error_code=${errorCode || 'none'}`,
        `timeout_ms=${CLEANUP_POLICY_CLI_TIMEOUT_MS}`,
        `runtime_lock_timeout_ms=${CLEANUP_POLICY_RUNTIME_LOCK_TIMEOUT_MS}`
    ].join('\n');
}

const TEMPLATE_POLICY = {
    version: 1,
    retention_mode: 'full',
    compress_after_days: 7,
    compression_format: 'gzip',
    preserve_gate_receipts: true,
    gate_receipt_suffixes: [
        '-task-mode.json',
        '-preflight.json'
    ],
    privacy_notice: 'Template defaults'
};

const TEMPLATE_RUNTIME_RETENTION = {
    version: 1,
    active_tasks: {
        protect_runtime_grace_days: 7,
        protect_current_cycle_artifacts: true
    },
    healthy_done: {
        compact_after_days: 30,
        require_ledger: true,
        retain_task_events_until_ledger_verified: true
    },
    problem_tasks: {
        compress_after_days: 45,
        preserve_detailed_evidence: true
    },
    purge: {
        require_confirm: true
    },
    daily_maintenance: {
        enabled: false,
        max_tasks_per_run: 25,
        eligible_older_than_days: 30,
        keep_latest_tasks: 0,
        dry_run: false
    }
};

test('cleanup policy --json shows the current persisted review artifact policy', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-policy-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            JSON.stringify(TEMPLATE_POLICY, null, 2)
        );
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
            JSON.stringify(TEMPLATE_RUNTIME_RETENTION, null, 2)
        );

        const result = spawnCleanupPolicyCli([
            '--target-root', tmpDir,
            '--json'
        ]);

        const combined = buildCliFailureMessage(result);
        assert.equal(result.status, 0, combined);
        const parsed = JSON.parse(textOutput(result.stdout));
        assert.equal(parsed.action, 'show');
        assert.equal(parsed.policy.retention_mode, 'full');
        assert.equal(parsed.policy.compress_after_days, 7);
        assert.equal(parsed.runtime_retention_policy.healthy_done.compact_after_days, 30);
        assert.equal(parsed.runtime_retention_policy.problem_tasks.compress_after_days, 45);
        assert.ok(parsed.operator_notes.some((note: string) => note.includes('verified ledger evidence')));
        assert.ok(parsed.operator_notes.some((note: string) => note.includes('Clean-success compile/full-suite raw logs may be intentionally omitted')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup policy persists updates through CLI flags', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-policy-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            JSON.stringify(TEMPLATE_POLICY, null, 2)
        );
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
            JSON.stringify(TEMPLATE_RUNTIME_RETENTION, null, 2)
        );

        const result = spawnCleanupPolicyCli([
            '--target-root', tmpDir,
            '--retention-mode', 'summary',
            '--compress-after-days', '14',
            '--preserve-gate-receipts', 'no',
            '--gate-receipt-suffix', '-task-mode.json'
        ]);

        const combined = buildCliFailureMessage(result);
        assert.equal(result.status, 0, combined);
        assert.ok(combined.includes('GARDA_CLEANUP_POLICY'), combined);
        assert.ok(combined.includes('Action: update'), combined);
        assert.ok(combined.includes('RuntimeRetentionHealthyDoneCompactAfterDays: 30'), combined);
        assert.ok(combined.includes('RuntimeRetentionProblemCompressAfterDays: 45'), combined);
        assert.ok(combined.includes('RuntimeRetentionTiers: active_evidence=preserve'), combined);
        assert.ok(combined.includes('OperatorNote: Runtime retention tiers: active evidence is preserved'), combined);
        assert.ok(combined.includes('Clean-success compile/full-suite raw logs may be intentionally omitted'), combined);

        const persisted = JSON.parse(fs.readFileSync(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            'utf8'
        ));
        assert.equal(persisted.retention_mode, 'summary');
        assert.equal(persisted.compress_after_days, 14);
        assert.equal(persisted.preserve_gate_receipts, false);
        assert.deepEqual(persisted.gate_receipt_suffixes, ['-task-mode.json']);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup policy --json round-trips daily maintenance dry-run during updates', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-policy-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            JSON.stringify(TEMPLATE_POLICY, null, 2)
        );
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
            JSON.stringify({
                ...TEMPLATE_RUNTIME_RETENTION,
                daily_maintenance: {
                    ...TEMPLATE_RUNTIME_RETENTION.daily_maintenance,
                    enabled: true,
                    dry_run: true
                }
            }, null, 2)
        );

        const result = spawnCleanupPolicyCli([
            '--target-root', tmpDir,
            '--retention-mode', 'summary',
            '--json'
        ]);

        const combined = buildCliFailureMessage(result);
        assert.equal(result.status, 0, combined);
        const parsed = JSON.parse(textOutput(result.stdout));
        assert.equal(parsed.action, 'update');
        assert.equal(parsed.runtime_retention_policy.daily_maintenance.enabled, true);
        assert.equal(parsed.runtime_retention_policy.daily_maintenance.dry_run, true);

        const persistedRuntimeRetention = JSON.parse(fs.readFileSync(
            path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
            'utf8'
        ));
        assert.equal(persistedRuntimeRetention.daily_maintenance.dry_run, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup policy reset restores bundled template defaults', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-policy-'));
    try {
        const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
        writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
        writeFixture(
            path.join(bundleRoot, 'template', 'config', 'review-artifact-storage.json'),
            JSON.stringify(TEMPLATE_POLICY, null, 2)
        );
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
            JSON.stringify(TEMPLATE_RUNTIME_RETENTION, null, 2)
        );
        writeFixture(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            JSON.stringify({
                ...TEMPLATE_POLICY,
                retention_mode: 'summary',
                compress_after_days: 0,
                preserve_gate_receipts: false
            }, null, 2)
        );

        const result = spawnCleanupPolicyCli([
            'reset',
            '--target-root', tmpDir
        ]);

        const combined = buildCliFailureMessage(result);
        assert.equal(result.status, 0, combined);
        assert.ok(combined.includes('Action: reset'), combined);

        const persisted = JSON.parse(fs.readFileSync(
            path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
            'utf8'
        ));
        assert.equal(persisted.retention_mode, 'full');
        assert.equal(persisted.compress_after_days, 7);
        assert.equal(persisted.preserve_gate_receipts, true);
        assert.equal(persisted.privacy_notice, 'Template defaults');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('cleanup policy edit uses interactive prompts to update the policy', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-cleanup-policy-'));
    const bundleRoot = path.join(tmpDir, 'garda-agent-orchestrator');
    writeFixture(path.join(bundleRoot, 'VERSION'), '1.0.0\n');
    writeFixture(
        path.join(bundleRoot, 'template', 'config', 'review-artifact-storage.json'),
        JSON.stringify(TEMPLATE_POLICY, null, 2)
    );
    writeFixture(
        path.join(bundleRoot, 'live', 'config', 'runtime-retention.json'),
        JSON.stringify(TEMPLATE_RUNTIME_RETENTION, null, 2)
    );
    writeFixture(
        path.join(bundleRoot, 'live', 'config', 'review-artifact-storage.json'),
        JSON.stringify(TEMPLATE_POLICY, null, 2)
    );

    const cliHelpersPath = require.resolve('../../../src/cli/commands/cli-helpers');
    const cliHelpers = require(cliHelpersPath);
    const originals = {
        supportsInteractivePrompts: cliHelpers.supportsInteractivePrompts,
        promptTextInput: cliHelpers.promptTextInput,
        promptSingleSelect: cliHelpers.promptSingleSelect
    };

    cliHelpers.supportsInteractivePrompts = () => true;
    cliHelpers.promptTextInput = async (title: string) => {
        if (title === 'Compress artifacts after N days') return '30';
        throw new Error(`Unexpected promptTextInput title: ${title}`);
    };
    cliHelpers.promptSingleSelect = async (config: { title: string }) => {
        switch (config.title) {
            case 'Retention mode': return 'summary';
            case 'Preserve gate receipts': return 'true';
            case 'Use bundled default receipt suffixes': return 'true';
            default:
                throw new Error(`Unexpected promptSingleSelect title: ${config.title}`);
        }
    };

    try {
        const { lines } = await captureConsoleAsync(() => Promise.resolve(handleCleanupPolicyCommand(bundleRoot, { edit: true })));
        assert.ok(lines.join('\n').includes('GARDA_CLEANUP_POLICY'));
        const persisted = JSON.parse(fs.readFileSync(resolveCleanupPolicyConfigPath(bundleRoot), 'utf8'));
        assert.equal(persisted.retention_mode, 'summary');
        assert.equal(persisted.preserve_gate_receipts, true);
        assert.deepEqual(persisted.gate_receipt_suffixes, TEMPLATE_POLICY.gate_receipt_suffixes);
    } finally {
        cliHelpers.supportsInteractivePrompts = originals.supportsInteractivePrompts;
        cliHelpers.promptTextInput = originals.promptTextInput;
        cliHelpers.promptSingleSelect = originals.promptSingleSelect;
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
