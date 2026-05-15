import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { buildGuardedCommandHelpText } from '../../../../src/cli/commands/cli-format-output';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };
function buildOperatorConfirmationArgs(): string[] {
    return ['--operator-confirmed', 'yes', '--operator-confirmed-at-utc', new Date().toISOString()];
}

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
            task_reset: {
                enabled: false
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
        assert.ok(output.includes('Scope budget guard: BLOCK_FOR_SPLIT'));
        assert.ok(output.includes('Review cycle guard: BLOCK_FOR_OPERATOR_DECISION'));
        assert.ok(output.includes('max_failed_non_test_reviews=15 max_total_non_test_reviews=30'));
        assert.ok(output.includes('Project memory maintenance: update read_strategy=index_first'));
        assert.ok(output.includes('Task reset: disabled'));
        assert.ok(output.includes('TaskResetEnabled: false'));
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates scope budget guard settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--scope-budget-enabled', 'true',
            '--scope-budget-action', 'warn_only',
            '--scope-budget-profiles', 'strict,balanced',
            '--scope-budget-max-files', '7',
            '--scope-budget-max-changed-lines', '300',
            '--scope-budget-max-required-reviews', '3',
            '--scope-budget-max-review-tokens', '5000',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Scope budget guard: WARN_ONLY profiles=strict,balanced'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.scope_budget_guard.enabled, true);
        assert.equal(parsedConfig.scope_budget_guard.action, 'WARN_ONLY');
        assert.deepEqual(parsedConfig.scope_budget_guard.profiles, ['strict', 'balanced']);
        assert.equal(parsedConfig.scope_budget_guard.max_files, 7);
        assert.equal(parsedConfig.scope_budget_guard.max_changed_lines, 300);
        assert.equal(parsedConfig.scope_budget_guard.max_required_reviews, 3);
        assert.equal(parsedConfig.scope_budget_guard.max_review_tokens, 5000);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates review cycle guard settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--review-cycle-enabled', 'true',
            '--review-cycle-action', 'warn_only',
            '--review-cycle-max-failed-non-test-reviews', '4',
            '--review-cycle-max-total-non-test-reviews', '8',
            '--review-cycle-excluded-review-types', 'test,docs',
            '--review-cycle-auto-split-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Review cycle guard: WARN_ONLY'));
        assert.ok(output.includes('auto_split_enabled=true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.review_cycle_guard.enabled, true);
        assert.equal(parsedConfig.review_cycle_guard.action, 'WARN_ONLY');
        assert.equal(parsedConfig.review_cycle_guard.max_failed_non_test_reviews, 4);
        assert.equal(parsedConfig.review_cycle_guard.max_total_non_test_reviews, 8);
        assert.deepEqual(parsedConfig.review_cycle_guard.excluded_review_types, ['test', 'docs']);
        assert.equal(parsedConfig.review_cycle_guard.auto_split_enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates project memory maintenance settings deterministically', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--project-memory-enabled', 'true',
            '--project-memory-mode', 'update',
            '--project-memory-run-before-final-closeout', 'false',
            '--project-memory-require-user-approval-for-writes', 'false',
            '--project-memory-max-compact-summary-chars', '9000',
            '--project-memory-read-strategy', 'index_first',
            '--project-memory-impact-artifact-retention-days', '45',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(output.includes('Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=9000'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.project_memory_maintenance.enabled, true);
        assert.equal(parsedConfig.project_memory_maintenance.mode, 'update');
        assert.equal(parsedConfig.project_memory_maintenance.run_before_final_closeout, false);
        assert.equal(parsedConfig.project_memory_maintenance.require_user_approval_for_writes, false);
        assert.equal(parsedConfig.project_memory_maintenance.max_compact_summary_chars, 9000);
        assert.equal(parsedConfig.project_memory_maintenance.read_strategy, 'index_first');
        assert.equal(parsedConfig.project_memory_maintenance.impact_artifact_retention_days, 45);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set updates task reset availability with audit record', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--task-reset-enabled', 'true',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.task_reset.enabled, true);
        assert.ok(result.changed_fields.includes('task_reset.enabled'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Task reset: enabled'));
        assert.ok(output.includes('TaskResetEnabled: true'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.task_reset.enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set maps short on off aliases to existing boolean settings', () => {
    const bundleRoot = createBundleRoot();
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--full-suite', 'on',
            '--scope-budget', 'off',
            '--review-cycle', 'off',
            '--review-cycle-auto-split', 'on',
            '--project-memory', 'off',
            '--task-reset', 'on',
            ...buildOperatorConfirmationArgs()
        ], PACKAGE_JSON));

        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.ok(result.changed_fields.includes('full_suite_validation.enabled'));
        assert.ok(result.changed_fields.includes('scope_budget_guard.enabled'));
        assert.ok(result.changed_fields.includes('review_cycle_guard.enabled'));
        assert.ok(result.changed_fields.includes('review_cycle_guard.auto_split_enabled'));
        assert.ok(result.changed_fields.includes('project_memory_maintenance.enabled'));
        assert.ok(result.changed_fields.includes('task_reset.enabled'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.scope_budget_guard.enabled, false);
        assert.equal(parsedConfig.review_cycle_guard.enabled, false);
        assert.equal(parsedConfig.review_cycle_guard.auto_split_enabled, true);
        assert.equal(parsedConfig.project_memory_maintenance.enabled, false);
        assert.equal(parsedConfig.task_reset.enabled, true);
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects conflicting short alias and long boolean flag values', () => {
    const pairs = [
        ['--full-suite', '--full-suite-enabled'],
        ['--scope-budget', '--scope-budget-enabled'],
        ['--review-cycle', '--review-cycle-enabled'],
        ['--review-cycle-auto-split', '--review-cycle-auto-split-enabled'],
        ['--project-memory', '--project-memory-enabled'],
        ['--task-reset', '--task-reset-enabled']
    ] as const;

    for (const [aliasFlag, canonicalFlag] of pairs) {
        const bundleRoot = createBundleRoot();
        try {
            assert.throws(
                () => handleWorkflow([
                    'set',
                    '--bundle-root', bundleRoot,
                    aliasFlag, 'on',
                    canonicalFlag, 'false',
                    ...buildOperatorConfirmationArgs()
                ], PACKAGE_JSON),
                new RegExp(`${aliasFlag} conflicts with ${canonicalFlag}`)
            );
        } finally {
            fs.rmSync(bundleRoot, { recursive: true, force: true });
        }
    }
});

test('workflow set rejects invalid boolean tokens for short aliases and canonical flags', () => {
    const pairs = [
        ['--full-suite', '--full-suite-enabled'],
        ['--scope-budget', '--scope-budget-enabled'],
        ['--review-cycle', '--review-cycle-enabled'],
        ['--review-cycle-auto-split', '--review-cycle-auto-split-enabled'],
        ['--project-memory', '--project-memory-enabled'],
        ['--task-reset', '--task-reset-enabled']
    ] as const;

    for (const flags of pairs) {
        for (const flag of flags) {
            const bundleRoot = createBundleRoot();
            try {
                assert.throws(
                    () => handleWorkflow([
                        'set',
                        '--bundle-root', bundleRoot,
                        flag, 'maybe',
                        ...buildOperatorConfirmationArgs()
                    ], PACKAGE_JSON),
                    new RegExp(`${flag} must be one of: true, false, yes, no, 1, 0, on, off`)
                );
            } finally {
                fs.rmSync(bundleRoot, { recursive: true, force: true });
            }
        }
    }
});

test('workflow set enables garda self-guard without operator confirmation', () => {
    const bundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'require_operator_confirmation'
        }
    });
    const configPath = path.join(bundleRoot, 'live', 'config', 'workflow-config.json');

    try {
        const { result, output } = captureConsole(() => handleWorkflow([
            'set',
            '--bundle-root', bundleRoot,
            '--garda-self-guard', 'on'
        ], PACKAGE_JSON));
        assert.ok(result && result.action === 'set');
        assert.equal(result.status, 'CHANGED');
        assert.equal(result.orchestrator_work_policy.mode, 'deny_agent_entry');
        assert.ok(result.changed_fields.includes('orchestrator_work_policy.mode'));
        assert.ok(result.audit_path);
        assert.ok(output.includes('Garda self-guard: on (deny_agent_entry)'));
        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.orchestrator_work_policy.mode, 'deny_agent_entry');
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set requires operator confirmation to disable garda self-guard', () => {
    const bundleRoot = createBundleRoot({}, {
        orchestrator_work_policy: {
            mode: 'deny_agent_entry'
        }
    });

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--garda-self-guard', 'off'
            ], PACKAGE_JSON),
            /workflow set requires explicit operator confirmation/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects changed config without operator confirmation', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true'
            ], PACKAGE_JSON),
            /workflow set requires explicit operator confirmation/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects changed config without fresh operator confirmation timestamp', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes'
            ], PACKAGE_JSON),
            /workflow set requires --operator-confirmed-at-utc/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow set rejects stale operator confirmation timestamps', () => {
    const bundleRoot = createBundleRoot();
    const staleConfirmation = new Date(Date.now() - 11 * 60 * 1000).toISOString();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--task-reset-enabled', 'true',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', staleConfirmation
            ], PACKAGE_JSON),
            /workflow set operator confirmation is stale/
        );
    } finally {
        fs.rmSync(bundleRoot, { recursive: true, force: true });
    }
});

test('workflow help describes project-memory update as the default policy', () => {
    const helpText = buildGuardedCommandHelpText('workflow');

    assert.ok(helpText.includes('Project memory maintenance defaults to update mode'));
    assert.ok(helpText.includes('workflow set --review-cycle-enabled true --review-cycle-max-total-non-test-reviews 30'));
    assert.ok(helpText.includes('workflow set --full-suite on --operator-confirmed yes --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('--scope-budget on|off|--scope-budget-enabled true|false'));
    assert.ok(helpText.includes('--review-cycle on|off|--review-cycle-enabled true|false'));
    assert.ok(helpText.includes('--review-cycle-auto-split on|off|--review-cycle-auto-split-enabled true|false'));
    assert.ok(helpText.includes('--project-memory on|off|--project-memory-enabled true|false'));
    assert.ok(helpText.includes('workflow set --project-memory on --project-memory-mode update'));
    assert.ok(helpText.includes('workflow set --task-reset on --operator-confirmed yes --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('--task-reset on|off|--task-reset-enabled true|false'));
    assert.ok(helpText.includes('Short aliases map exactly to existing boolean settings'));
    assert.ok(helpText.includes('workflow set --garda-self-guard on'));
    assert.ok(helpText.includes('workflow set writes require --operator-confirmed yes and --operator-confirmed-at-utc'));
    assert.ok(helpText.includes('Task reset mutations are disabled by default'));
    assert.ok(!helpText.includes('Project memory maintenance is disabled by default'));
});

test('workflow validate and explain include workflow guard diagnostics', () => {
    const bundleRoot = createBundleRoot();

    try {
        const validateOutput = captureConsole(() => handleWorkflow([
            'validate',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)).output;
        assert.ok(validateOutput.includes('Action: validate'));
        assert.ok(validateOutput.includes('Status: PASS'));
        assert.ok(validateOutput.includes('Project memory maintenance: update'));
        assert.ok(validateOutput.includes('Task reset: disabled'));

        const explainOutput = captureConsole(() => handleWorkflow([
            'explain',
            '--bundle-root', bundleRoot
        ], PACKAGE_JSON)).output;
        assert.ok(explainOutput.includes('Topic: workflow-guards'));
        assert.ok(explainOutput.includes('before compile/review loops'));
        assert.ok(explainOutput.includes('Review cycle guard: stops runaway non-test review cycles'));
        assert.ok(explainOutput.includes('15 failed non-test reviews and 30 total non-test reviews'));
        assert.ok(explainOutput.includes('BLOCK_FOR_OPERATOR_DECISION'));
        assert.ok(explainOutput.includes('auto_split_enabled is true'));
        assert.ok(explainOutput.includes('WARN_ONLY'));
        assert.ok(explainOutput.includes('Task reset: confirmed reset mutations are disabled by default'));
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
        assert.equal(parsed.review_cycle_guard.max_failed_non_test_reviews, 15);
        assert.equal(parsed.review_cycle_guard.max_total_non_test_reviews, 30);
        assert.equal(parsed.project_memory_maintenance.enabled, true);
        assert.equal(parsed.project_memory_maintenance.mode, 'update');
        assert.equal(parsed.task_reset.enabled, false);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: code_first_optional');
        assert.equal(parsed.review_cycle_guard_summary_line, 'Review cycle guard: BLOCK_FOR_OPERATOR_DECISION max_failed_non_test_reviews=15 max_total_non_test_reviews=30 excluded=test auto_split_enabled=false');
        assert.equal(parsed.project_memory_maintenance_summary_line, 'Project memory maintenance: update read_strategy=index_first max_compact_summary_chars=12000 require_user_approval_for_writes=true');
        assert.equal(parsed.task_reset_summary_line, 'Task reset: disabled');
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
            ...buildOperatorConfirmationArgs(),
            '--json'
        ], PACKAGE_JSON));
        const parsed = JSON.parse(output);
        assert.equal(parsed.action, 'set');
        assert.equal(parsed.status, 'CHANGED');
        assert.equal(parsed.full_suite_validation.enabled, true);
        assert.equal(parsed.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsed.task_reset.enabled, false);
        assert.equal(parsed.visible_summary_line, 'Mandatory full-suite: true');
        assert.equal(parsed.review_execution_policy_summary_line, 'Review execution policy: strict_sequential');
        assert.ok(parsed.changed_fields.includes('full_suite_validation.enabled'));
        assert.ok(parsed.changed_fields.includes('review_execution_policy.mode'));

        const parsedConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        assert.equal(parsedConfig.full_suite_validation.enabled, true);
        assert.equal(parsedConfig.review_execution_policy.mode, 'strict_sequential');
        assert.equal(parsedConfig.task_reset.enabled, false);
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
            '--review-execution-policy', 'parallel_all',
            ...buildOperatorConfirmationArgs()
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
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
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
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
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
            '--full-suite-enabled', 'true',
            ...buildOperatorConfirmationArgs()
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

test('workflow set rejects invalid project memory maintenance modes', () => {
    const bundleRoot = createBundleRoot();

    try {
        assert.throws(
            () => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--project-memory-mode', 'audit'
            ], PACKAGE_JSON),
            /--project-memory-mode must be one of/
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
