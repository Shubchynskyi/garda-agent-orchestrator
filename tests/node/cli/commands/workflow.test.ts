import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function createBundleRoot(configOverrides: Partial<Record<string, unknown>> = {}): string {
    const bundleRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-'));
    const configDir = path.join(bundleRoot, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
                ...configOverrides
            }
        }, null, 2),
        'utf8'
    );
    return bundleRoot;
}

function captureConsole<T>(run: () => T): { result: T; output: string } {
    const originalConsoleLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => {
        lines.push(items.join(' '));
    };
    try {
        return {
            result: run(),
            output: lines.join('\n')
        };
    } finally {
        console.log = originalConsoleLog;
    }
}

test('workflow show prints repo-local full-suite settings', () => {
    const bundleRoot = createBundleRoot();

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.ok(output.includes('GARDA_WORKFLOW'));
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Scope: repo-local'));
        assert.ok(output.includes('Mandatory full-suite: false'));
        assert.ok(output.includes('FullSuiteCommand: npm test'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow defaults to show when the subcommand is omitted', () => {
    const bundleRoot = createBundleRoot({ enabled: true });

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.ok(output.includes('Action: show'));
        assert.ok(output.includes('Mandatory full-suite: true'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show --json returns valid JSON with compact full-suite line', () => {
    const bundleRoot = createBundleRoot({ enabled: true });

    try {
        const { output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'show');
        assert.equal(parsed.scope, 'repo-local');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set --json returns valid JSON for machine-readable automation', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true',
            '--json'
        ], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
        assert.ok(parsed.changed_fields.includes('full_suite_validation.enabled'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates repo-local full-suite config deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true',
            '--full-suite-command', 'npm run test:full',
            '--full-suite-timeout-ms', '123456',
            '--full-suite-out-of-scope-failure-policy', 'audit_and_warn'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Status: CHANGED'));
        assert.ok(output.includes('Mandatory full-suite: true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.full_suite_validation.command, 'npm run test:full');
        assert.equal(parsedConfig.full_suite_validation.timeout_ms, 123456);
        assert.equal(parsedConfig.full_suite_validation.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set reports NO_CHANGE when the requested value already matches', () => {
    const bundleRoot = createBundleRoot();

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'false'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'NO_CHANGE');
        assert.ok(output.includes('Status: NO_CHANGE'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set with explicit --bundle-root does not inherit defaults from a different bundle when config is missing', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-target-'));
    const defaultBundleRoot = path.join(workspaceRoot, 'garda-agent-orchestrator');
    const explicitBundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(path.join(defaultBundleRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(explicitBundleRoot, { recursive: true });
    fs.writeFileSync(
        path.join(defaultBundleRoot, 'live', 'config', 'workflow-config.json'),
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm run wrong-default',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', explicitBundleRoot,
            '--full-suite-enabled', 'true'
        ], PACKAGE_JSON));

        const explicitConfigPath = path.join(explicitBundleRoot, 'live', 'config', 'workflow-config.json');
        assert.equal(fs.existsSync(explicitConfigPath), true);
        const parsed = JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'));
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.notEqual(parsed.full_suite_validation.command, 'npm run wrong-default');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects missing mutation flags', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow(['set', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /Workflow setting flags are required/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
