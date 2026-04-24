import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function createBundleRoot(
    fullSuiteOverrides: Partial<Record<string, unknown>> = {},
    workflowOverrides: Partial<Record<string, unknown>> = {}
): string {
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
                ...fullSuiteOverrides
            },
            review_execution_policy: {
                mode: 'code_first_optional'
            },
            ...workflowOverrides
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
        assert.ok(output.includes('Review execution policy: code_first_optional'));
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
        assert.equal(parsed.review_execution_policy.mode, 'code_first_optional');
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: code_first_optional');
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
            '--review-execution-policy', 'strict_sequential',
            '--json'
        ], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
        assert.ok(parsed.changed_fields.includes('full_suite_validation.enabled'));
        assert.ok(parsed.changed_fields.includes('review_execution_policy.mode'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.review_execution_policy.mode, 'strict_sequential');
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
            '--full-suite-out-of-scope-failure-policy', 'audit_and_warn',
            '--review-execution-policy', 'parallel_all'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Status: CHANGED'));
        assert.ok(output.includes('Mandatory full-suite: true'));
        assert.ok(output.includes('Review execution policy: parallel_all'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.full_suite_validation.command, 'npm run test:full');
        assert.equal(parsedConfig.full_suite_validation.timeout_ms, 123456);
        assert.equal(parsedConfig.full_suite_validation.out_of_scope_failure_policy, 'AUDIT_AND_WARN');
        assert.equal(parsedConfig.review_execution_policy.mode, 'parallel_all');
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

test('workflow show keeps legacy compatibility mode when review_execution_policy is omitted', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        const { result, output } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);
        assert.ok(output.includes('Review execution policy: legacy_test_downstream (implicit compatibility mode)'));
        assert.ok(output.includes('ReviewExecutionPolicyConfigured: false'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show uses code_first_optional as the implicit mode for a fresh bundle path without workflow-config', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-fresh-show-'));
    const bundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(bundleRoot, { recursive: true });

    try {
        const { result } = captureConsole(() => handleWorkflow(['show', '--bundle-root', bundleRoot, '--json'], PACKAGE_JSON));
        assert.ok(result && result.action === 'show');
        assert.equal(result.config_exists, false);
        assert.equal(result.review_execution_policy.mode, 'code_first_optional');
        assert.equal(result.review_execution_policy.configured, false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set preserves legacy compatibility omission when changing only full-suite fields', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
    fs.writeFileSync(
        configPath,
        JSON.stringify({
            full_suite_validation: {
                enabled: false,
                command: 'npm test',
                timeout_ms: 600000,
                green_summary_max_lines: 5,
                red_failure_chunk_lines: 50,
                out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
            }
        }, null, 2),
        'utf8'
    );

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite-enabled', 'true'
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(Object.prototype.hasOwnProperty.call(parsedConfig, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set preserves legacy compatibility omission when config is missing in an existing materialized bundle', () => {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'gao-workflow-target-'));
    const explicitBundleRoot = path.join(workspaceRoot, 'custom-bundle');
    fs.mkdirSync(path.join(explicitBundleRoot, 'live', 'config'), { recursive: true });
    fs.writeFileSync(
        path.join(explicitBundleRoot, 'live', 'version.json'),
        JSON.stringify({ version: '1.0.0' }, null, 2),
        'utf8'
    );

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', explicitBundleRoot,
            '--full-suite-enabled', 'true'
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'legacy_test_downstream');
        assert.equal(result.review_execution_policy.configured, false);
        const explicitConfigPath = path.join(explicitBundleRoot, 'live', 'config', 'workflow-config.json');
        const parsed = JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'));
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(Object.prototype.hasOwnProperty.call(parsed, 'review_execution_policy'), false);
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('workflow set with explicit --bundle-root materializes the current review_execution_policy default for a fresh bundle path', () => {
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
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', explicitBundleRoot,
            '--full-suite-enabled', 'true'
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.review_execution_policy.mode, 'code_first_optional');
        assert.equal(result.review_execution_policy.configured, true);
        const explicitConfigPath = path.join(explicitBundleRoot, 'live', 'config', 'workflow-config.json');
        assert.equal(fs.existsSync(explicitConfigPath), true);
        const parsed = JSON.parse(fs.readFileSync(explicitConfigPath, 'utf8'));
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.notEqual(parsed.full_suite_validation.command, 'npm run wrong-default');
        assert.deepEqual(parsed.review_execution_policy, {
            mode: 'code_first_optional'
        });
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

test('workflow set rejects invalid review execution policy modes', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--review-execution-policy', 'totally_serialized'
            ], PACKAGE_JSON),
            /--review-execution-policy must be one of/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show rejects case-drifted review_execution_policy keys', () => {
    const bundleRoot = createBundleRoot({}, {
        review_execution_policy: undefined,
        Review_Execution_Policy: {
            mode: 'parallel_all'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /must use the exact key 'review_execution_policy'/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow show rejects likely typo top-level workflow-config keys', () => {
    const bundleRoot = createBundleRoot({}, {
        review_execution_policy: undefined,
        review_execution_polciy: {
            mode: 'parallel_all'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow(['show', '--bundle-root', bundleRoot], PACKAGE_JSON),
            /did you mean 'review_execution_policy'/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});
