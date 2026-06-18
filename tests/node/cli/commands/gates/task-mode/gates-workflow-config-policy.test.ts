import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../../../src/cli/commands/workflow-command';
import {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from '../../../../../../src/cli/commands/gates';
import { WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE } from '../../../../../../src/cli/commands/gate-flows/task-mode/task-mode-flow';
import { runCompileGateCommand } from '../../../../../../src/cli/commands/gate-flows/compile/compile-flow';
import { runFullSuiteValidationCommand } from '../../../../../../src/cli/commands/gate-flows/full-suite/full-suite-validation-flow';
import { UNCONFIGURED_COMPILE_GATE_COMMAND } from '../../../../../../src/core/constants';
import { runCompletionGate } from '../../../../../../src/gates/completion';
import { isWorkflowConfigControlPlanePath, writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import { getTaskModeEvidence } from '../../../../../../src/gates/task-mode';
import {
    getCurrentWorkflowConfigChanges,
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigPreTaskBaselineState,
    getWorkflowConfigWorkViolations
} from '../../../../../../src/gates/workflow-config/workflow-config-work';
import {
    createTempRepo,
    getReviewsRoot,
    initializeGitRepo,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runClassifyChangeCommand,
    runEnterTaskMode,
    runHandshakeForTask,
    runShellSmokeForTask,
    seedInitAnswers,
    seedTaskQueue,
    writeCleanReviewArtifact,
    writeCompilePassEvidence,
    writePreflight
} from '../../gate-test-helpers';

const PACKAGE_JSON = { name: 'garda-agent-orchestrator', version: '1.0.0' };

function captureConsole<T>(run: () => T): T {
    const originalConsoleLog = console.log;
    console.log = () => undefined;
    try {
        return run();
    } finally {
        console.log = originalConsoleLog;
    }
}

function writeIgnoredRuntimePolicy(repoRoot: string, options: { ignoreBundle?: boolean } = {}): void {
    fs.writeFileSync(path.join(repoRoot, '.gitignore'), [
        'TASK.md',
        'garda-agent-orchestrator/runtime/',
        ...(options.ignoreBundle ? ['garda-agent-orchestrator/'] : [])
    ].join('\n') + '\n', 'utf8');
}

function writeBaselineAgentEntrypoint(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
}

function markAsSourceCheckout(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2), 'utf8');
}

function seedWorkflowConfigTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | workflow | Update ${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE} | unassigned | 2026-03-28 | default | Explicitly owns ${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE}. |`
    ].join('\n'), 'utf8');
}

function seedIncidentalWorkflowConfigMentionTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | workflow | Inspect workflow-config.json docs | unassigned | 2026-03-28 | default | Mentions workflow-config.json but does not own the protected policy contract. |`
    ].join('\n'), 'utf8');
}

function prepareTaskRepo(
    taskId: string,
    options: {
        orchestratorWork?: boolean;
        workflowConfigWork?: boolean;
        ignoreBundle?: boolean;
    } = {}
): string {
    const repoRoot = createTempRepo();
    const taskSummary = 'Update app flow';
    writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: options.ignoreBundle === true });
    markAsSourceCheckout(repoRoot);
    writeBaselineAgentEntrypoint(repoRoot);
    if (options.workflowConfigWork === true) {
        seedWorkflowConfigTaskQueue(repoRoot, taskId);
    } else {
        seedTaskQueue(repoRoot, taskId);
    }
    seedInitAnswers(repoRoot);
    initializeGitRepo(repoRoot);
    if (options.ignoreBundle === true) {
        writeProtectedControlPlaneManifest(repoRoot);
    }

    runEnterTaskMode({
        repoRoot,
        taskId,
        orchestratorWork: options.orchestratorWork === true,
        workflowConfigWork: options.workflowConfigWork === true,
        operatorConfirmed: options.orchestratorWork === true || options.workflowConfigWork === true ? 'yes' : undefined,
        operatorConfirmedAtUtc: options.orchestratorWork === true || options.workflowConfigWork === true
            ? new Date().toISOString()
            : undefined,
        plannedChangedFiles: options.workflowConfigWork === true
            ? ['garda-agent-orchestrator/live/config/workflow-config.json']
            : [],
        taskSummary
    });
    const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
    assert.equal(rulePackResult.exitCode, 0);
    runHandshakeForTask(repoRoot, taskId);
    runShellSmokeForTask(repoRoot, taskId);
    return repoRoot;
}

function weakenOutOfScopePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { enabled?: boolean; out_of_scope_failure_policy: string };
    };
    config.full_suite_validation.out_of_scope_failure_policy = 'AUDIT_AND_WARN';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenFullSuiteCommand(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { enabled?: boolean; command?: string };
    };
    config.full_suite_validation.command = 'true';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function enableFullSuitePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { enabled?: boolean };
    };
    config.full_suite_validation.enabled = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function enableProjectMemoryMaintenancePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: {
            enabled?: boolean;
            mode?: string;
            run_before_final_closeout?: boolean;
            require_user_approval_for_writes?: boolean;
        };
    };
    config.project_memory_maintenance.enabled = true;
    config.project_memory_maintenance.mode = 'update';
    config.project_memory_maintenance.run_before_final_closeout = true;
    config.project_memory_maintenance.require_user_approval_for_writes = true;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function resetCompileGateCommandToUnconfigured(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        compile_gate?: { command?: string };
    };
    config.compile_gate = {
        ...(config.compile_gate || {}),
        command: UNCONFIGURED_COMPILE_GATE_COMMAND
    };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryMaintenance(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { enabled?: boolean };
    };
    config.project_memory_maintenance.enabled = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryApproval(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { require_user_approval_for_writes?: boolean };
    };
    config.project_memory_maintenance.require_user_approval_for_writes = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenProjectMemoryRetention(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        project_memory_maintenance: { impact_artifact_retention_days?: number };
    };
    config.project_memory_maintenance.impact_artifact_retention_days = 1;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenScopeBudgetGuard(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        scope_budget_guard: { max_changed_lines?: number };
    };
    config.scope_budget_guard.max_changed_lines = 999999;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenReviewCycleExcludedReviews(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        review_cycle_guard: { excluded_review_types?: string[] };
    };
    config.review_cycle_guard.excluded_review_types = ['test', 'code', 'security'];
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function weakenReviewExecutionPolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        review_execution_policy: { mode?: string };
    };
    config.review_execution_policy.mode = 'test_after_code';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function addUnknownTopLevelWorkflowConfigKey(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    config.future_policy_toggle = { enabled: false };
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function addUnknownWorkflowConfigSectionKey(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: Record<string, unknown>;
    };
    config.full_suite_validation.future_policy_toggle = false;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function removeReviewExecutionPolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
    delete config.review_execution_policy;
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function corruptProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, '{ invalid json\n', 'utf8');
}

function writeTamperedProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    const configPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'live',
        'config',
        'workflow-config.json'
    );
    const currentHash = crypto.createHash('sha256')
        .update(fs.readFileSync(configPath))
        .digest('hex');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        protected_snapshot: {
            'garda-agent-orchestrator/live/config/workflow-config.json': currentHash
        },
        protected_snapshot_sha256: '0'.repeat(64)
    }, null, 2) + '\n', 'utf8');
}

function writeLegacyDigestlessProtectedControlPlaneManifest(repoRoot: string): void {
    const manifestPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'runtime',
        'protected-control-plane-manifest.json'
    );
    const configPath = path.join(
        repoRoot,
        'garda-agent-orchestrator',
        'live',
        'config',
        'workflow-config.json'
    );
    const currentHash = crypto.createHash('sha256')
        .update(fs.readFileSync(configPath))
        .digest('hex');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        protected_snapshot: {
            'garda-agent-orchestrator/live/config/workflow-config.json': currentHash
        }
    }, null, 2) + '\n', 'utf8');
}

function weakenBundleRootOutOfScopePolicy(repoRoot: string): void {
    const configPath = path.join(repoRoot, 'live', 'config', 'workflow-config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf8')) as {
        full_suite_validation: { out_of_scope_failure_policy: string };
    };
    config.full_suite_validation.out_of_scope_failure_policy = 'AUDIT_AND_WARN';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
}

function makeBundleRootLike(repoRoot: string): void {
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify(PACKAGE_JSON, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'VERSION'), '1.0.0\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'MANIFEST.md'), '# test bundle\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
}

function editAppFile(repoRoot: string): string {
    const relativePath = 'src/app.ts';
    fs.appendFileSync(path.join(repoRoot, relativePath), '\nconsole.log("scoped app edit");\n', 'utf8');
    return relativePath;
}

describe('cli/commands/gates — workflow-config protected control-plane', () => {
    it('does not classify arbitrary app workflow-config lookalike paths as Garda workflow config', () => {
        assert.equal(isWorkflowConfigControlPlanePath('packages/foo/live/config/workflow-config.json'), false);
        assert.equal(isWorkflowConfigControlPlanePath('garda-agent-orchestrator/live/config/workflow-config.json'), true);
        assert.equal(isWorkflowConfigControlPlanePath('live/config/workflow-config.json'), true);
        assert.equal(isWorkflowConfigControlPlanePath('template/config/workflow-config.json'), true);
    });

    it('detects workflow-config edits when repoRoot is the bundle root', { concurrency: false }, () => {
        const outerRoot = createTempRepo();
        const repoRoot = path.join(outerRoot, 'garda-agent-orchestrator');

        try {
            makeBundleRootLike(repoRoot);
            const baseline = getCurrentWorkflowConfigFileHashes(repoRoot);
            assert.ok(getWorkflowConfigControlPlanePaths(repoRoot).includes('live/config/workflow-config.json'));
            assert.equal(typeof baseline['live/config/workflow-config.json'], 'string');

            weakenBundleRootOutOfScopePolicy(repoRoot);
            const changes = getCurrentWorkflowConfigChanges(repoRoot, baseline);

            assert.deepEqual(changes.changed_files, ['live/config/workflow-config.json']);
        } finally {
            fs.rmSync(outerRoot, { recursive: true, force: true });
        }
    });

    it('detects workflow-config edits under a custom configured bundle name', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const previousBundleName = process.env.GARDA_BUNDLE_NAME;
        process.env.GARDA_BUNDLE_NAME = 'custom-garda';
        const configPath = path.join(repoRoot, 'custom-garda', 'live', 'config', 'workflow-config.json');

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'FAIL' }
            }, null, 2) + '\n', 'utf8');
            const baseline = getCurrentWorkflowConfigFileHashes(repoRoot);
            assert.ok(getWorkflowConfigControlPlanePaths(repoRoot).includes(
                'custom-garda/live/config/workflow-config.json'
            ));

            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'AUDIT_AND_WARN' }
            }, null, 2) + '\n', 'utf8');
            const changes = getCurrentWorkflowConfigChanges(repoRoot, baseline);

            assert.deepEqual(changes.changed_files, ['custom-garda/live/config/workflow-config.json']);
            assert.match(getWorkflowConfigWorkViolations({
                changedFiles: changes.changed_files,
                taskModeEvidence: { orchestrator_work: true },
                phaseLabel: 'preflight',
                baselineFileHashes: baseline,
                currentFileHashes: changes.current_file_hashes
            }).join('\n'), /--workflow-config-work/);
        } finally {
            if (previousBundleName === undefined) {
                delete process.env.GARDA_BUNDLE_NAME;
            } else {
                process.env.GARDA_BUNDLE_NAME = previousBundleName;
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps the default bundle workflow config protected when GARDA_BUNDLE_NAME is wrong', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const previousBundleName = process.env.GARDA_BUNDLE_NAME;
        process.env.GARDA_BUNDLE_NAME = 'wrong-garda';
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');

        try {
            fs.mkdirSync(path.dirname(configPath), { recursive: true });
            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'FAIL' }
            }, null, 2) + '\n', 'utf8');
            const baseline = getCurrentWorkflowConfigFileHashes(repoRoot);
            assert.ok(getWorkflowConfigControlPlanePaths(repoRoot).includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            fs.writeFileSync(configPath, JSON.stringify({
                full_suite_validation: { out_of_scope_failure_policy: 'AUDIT_AND_WARN' }
            }, null, 2) + '\n', 'utf8');
            const changes = getCurrentWorkflowConfigChanges(repoRoot, baseline);

            assert.deepEqual(changes.changed_files, ['garda-agent-orchestrator/live/config/workflow-config.json']);
        } finally {
            if (previousBundleName === undefined) {
                delete process.env.GARDA_BUNDLE_NAME;
            } else {
                process.env.GARDA_BUNDLE_NAME = previousBundleName;
            }
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks inconsistent workflow-config task-mode evidence without broad orchestrator work', () => {
        const violations = getWorkflowConfigWorkViolations({
            changedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
            taskModeEvidence: {
                workflow_config_work: true,
                orchestrator_work: false
            },
            phaseLabel: 'preflight'
        });

        assert.match(violations.join('\n'), /--workflow-config-work requires --orchestrator-work/);
    });

    it('rejects workflow-config task mode without broad orchestrator work', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-flag-pair';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    workflowConfigWork: true,
                    taskSummary: 'Update orchestrator workflow config'
                }),
                /--workflow-config-work requires --orchestrator-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows workflow-config task mode for ordinary tasks when both workflow flags are explicit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-ordinary-task-flags';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedWorkflowConfigTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                orchestratorWork: true,
                workflowConfigWork: true,
                operatorConfirmed: 'yes',
                operatorConfirmedAtUtc: new Date().toISOString(),
                plannedChangedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                taskSummary: 'Update app flow'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects incidental workflow-config mentions without the exact ownership phrase', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-incidental-mention';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            markAsSourceCheckout(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedIncidentalWorkflowConfigMentionTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    plannedChangedFiles: ['garda-agent-orchestrator/live/config/workflow-config.json'],
                    taskSummary: 'Update app flow'
                }),
                (error: unknown) => {
                    const message = error instanceof Error ? error.message : String(error);
                    assert.match(message, /requires trusted TASK\.md metadata/);
                    assert.match(message, new RegExp(WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE));
                    assert.doesNotMatch(message, /mention workflow-config\.json/);
                    return true;
                }
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects task-mode entry when workflow-config is already dirty', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-dirty-before-task-mode';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot);
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    taskSummary: 'Update orchestrator workflow config'
                }),
                /already contains workflow config changes before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('rejects task-mode entry when ignored workflow-config drifted from the trusted manifest', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-ignored-dirty-before-task-mode';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    operatorConfirmed: 'yes',
                    operatorConfirmedAtUtc: new Date().toISOString(),
                    taskSummary: 'Update orchestrator workflow config'
                }),
                /already contains workflow config changes before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing materialized workflow-config when no trusted baseline exists yet', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after workflow-config baseline upgrade'
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.includes('WorkflowConfigCompatibilityBaselineCount: 1'));

            const evidence = getTaskModeEvidence(repoRoot, taskId);
            assert.deepEqual(evidence.workflow_config_compatibility_baseline_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing legacy generated workflow-config when no trusted baseline exists yet', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-generated-legacy-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after legacy generated workflow-config baseline upgrade'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ignored pre-existing legacy materialized workflow-config without review execution policy', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-legacy-review-policy';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            resetCompileGateCommandToUnconfigured(repoRoot);
            initializeGitRepo(repoRoot);
            removeReviewExecutionPolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.changed_files, []);
            assert.ok(baselineState.compatibility_baseline_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when protected manifest is invalid', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-invalid-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            corruptProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after invalid protected manifest'
                }),
                /already contains workflow config changes before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks deleted materialized workflow-config when protected manifest is invalid', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-deleted-invalid-manifest';
        const repoRoot = createTempRepo();
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            fs.rmSync(configPath);
            corruptProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after deleted workflow-config with invalid manifest'
                }),
                /already contains workflow config changes before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when protected manifest digest is tampered', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-tampered-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);
            writeTamperedProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('keeps protected-manifest fallback baseline frozen after manifest refresh', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            initializeGitRepo(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);

            const initialChanges = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.equal(initialChanges.baseline_source, 'protected_manifest');
            assert.ok(initialChanges.baseline_file_hashes);
            assert.deepEqual(initialChanges.changed_files, []);

            weakenOutOfScopePolicy(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);

            const unfrozenChanges = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.deepEqual(unfrozenChanges.changed_files, []);

            const frozenChanges = getCurrentWorkflowConfigChanges(repoRoot, initialChanges.baseline_file_hashes);
            assert.deepEqual(frozenChanges.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows legacy protected manifest without digest when workflow-config hash matches', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-legacy-digestless-manifest';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);
            writeLegacyDigestlessProtectedControlPlaneManifest(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, []);

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start after legacy digestless manifest'
            });
            assert.equal(result.exitCode, 0);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('fails closed when no git status baseline is available for materialized workflow-config', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.ok(baselineState.changed_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks legacy identity-backfilled checks when workflow-config baseline hashes are missing', { concurrency: false }, () => {
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);

            const changes = getCurrentWorkflowConfigChanges(repoRoot, null);
            assert.equal(changes.baseline_source, null);
            assert.deepEqual(changes.baseline_file_hashes, null);

            const violations = getWorkflowConfigWorkViolations({
                changedFiles: changes.changed_files,
                taskModeEvidence: {
                    identity_backfilled_from_legacy: true,
                    workflow_config_work: false,
                    orchestrator_work: false,
                    workflow_config_file_hashes: null
                },
                phaseLabel: 'compile gate',
                baselineFileHashes: changes.baseline_file_hashes,
                currentFileHashes: changes.current_file_hashes
            });

            assert.match(
                violations.join('\n'),
                /Workflow config baseline hashes are missing before compile gate/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when compatibility baseline is unsafe', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unsafe-baseline';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenScopeBudgetGuard(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    taskSummary: 'Start after unsafe workflow-config baseline upgrade'
                }),
                /already contains workflow config changes before task-mode entry/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when full-suite command is weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-command-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenFullSuiteCommand(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory maintenance is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-disabled';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            weakenProjectMemoryMaintenance(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory approval is disabled', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-approval';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            weakenProjectMemoryApproval(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when project memory retention is reduced', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-project-memory-retention';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            weakenProjectMemoryRetention(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when review-cycle exclusions are weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-review-cycle-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenReviewCycleExcludedReviews(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config when review execution policy is weakened', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-review-policy-unsafe';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);
            weakenReviewExecutionPolicy(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config with an unknown top-level policy key', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unknown-top-level';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            addUnknownTopLevelWorkflowConfigKey(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ignored pre-existing materialized workflow-config with an unknown section policy key', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-upgrade-ignored-unknown-section';
        const repoRoot = createTempRepo();

        try {
            writeIgnoredRuntimePolicy(repoRoot, { ignoreBundle: true });
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            enableProjectMemoryMaintenancePolicy(repoRoot);
            initializeGitRepo(repoRoot);
            addUnknownWorkflowConfigSectionKey(repoRoot);

            const baselineState = getWorkflowConfigPreTaskBaselineState(repoRoot);
            assert.deepEqual(baselineState.compatibility_baseline_files, []);
            assert.deepEqual(baselineState.changed_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks ordinary task preflight when workflow-config policy is weakened by direct JSON edit', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-unauthorized';
        const repoRoot = prepareTaskRepo(taskId);

        try {
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update app flow',
                    emitMetrics: false
                }),
                /without task-mode --orchestrator-work --workflow-config-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks workflow-config edits when task mode has only broad orchestrator work', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-orchestrator-only';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });

        try {
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update orchestrator workflow config',
                    emitMetrics: false
                }),
                /without task-mode --workflow-config-work/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows workflow-config edits only when task mode uses both explicit workflow flags', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-authorized-task';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            workflowConfigWork: true
        });

        try {
            weakenOutOfScopePolicy(repoRoot);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update orchestrator workflow config',
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.equal(payload.triggers.protected_control_plane_changed, true);
            assert.deepEqual(payload.triggers.changed_workflow_config_files, [
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ]);
            assert.ok(payload.triggers.changed_protected_files.includes(
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks workflow-config policy edits hidden outside an explicit changed-file scope', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-hidden-explicit-scope';
        const repoRoot = prepareTaskRepo(taskId);

        try {
            weakenOutOfScopePolicy(repoRoot);
            const appPath = editAppFile(repoRoot);

            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Update app flow',
                    changedFiles: [appPath],
                    emitMetrics: false
                }),
                /garda-agent-orchestrator\/live\/config\/workflow-config\.json/
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('honors protected-manifest fallback baseline during preflight classification', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-preflight-manifest-baseline';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            ignoreBundle: true
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);

        try {
            const taskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
            delete taskModeArtifact.workflow_config_file_hashes;
            fs.writeFileSync(taskModePath, JSON.stringify(taskModeArtifact, null, 2) + '\n', 'utf8');
            const appPath = editAppFile(repoRoot);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow with legacy task-mode evidence',
                changedFiles: [appPath, 'garda-agent-orchestrator/live/config/workflow-config.json'],
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.deepEqual(payload.triggers.changed_workflow_config_files, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before full-suite when workflow-config flag is missing', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-full-suite';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            fs.mkdirSync(reviewsRoot, { recursive: true });
            fs.writeFileSync(preflightPath, JSON.stringify({
                task_id: taskId,
                changed_files: ['src/app.ts']
            }, null, 2), 'utf8');
            weakenOutOfScopePolicy(repoRoot);

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.notEqual(result.exitCode, 0);
            assert.match(result.outputText, /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before compile when workflow-config flag is missing', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-compile';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
        const commandsPath = path.join(repoRoot, 'commands-workflow-config-late-compile.md');

        try {
            fs.writeFileSync(commandsPath, [
                '### Compile Gate (Mandatory)',
                '```bash',
                'node -e "console.log(\'build ok\')"',
                '```'
            ].join('\n'), 'utf8');
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            weakenOutOfScopePolicy(repoRoot);

            const result = await runCompileGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                commandsPath,
                emitMetrics: false
            });

            assert.notEqual(result.exitCode, 0);
            assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
            assert.match(result.outputLines.join('\n'), /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks completion when stale artifacts omit workflow-config hash baselines', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-completion-stale-baseline';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });

        try {
            const preflightPath = writePreflight(repoRoot, taskId, {
                triggers: {},
                changed_files: ['src/app.ts']
            });
            weakenOutOfScopePolicy(repoRoot);

            const result = runCompletionGate({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some((violation: string) => (
                /without task-mode --workflow-config-work/.test(violation)
            )), JSON.stringify(result.violations, null, 2));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late workflow-config edits before completion when workflow-config flag is missing', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-late-completion';
        const repoRoot = prepareTaskRepo(taskId, { orchestratorWork: true });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
            writeCompilePassEvidence(repoRoot, taskId, preflightPath);
            writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
            assert.equal(runRequiredReviewsCheckCommand({
                repoRoot,
                taskId,
                preflightPath,
                emitMetrics: false
            }).exitCode, 0);
            assert.equal(runDocImpactGateCommand({
                repoRoot,
                taskId,
                preflightPath,
                rationale: 'No documentation updates are required for this workflow-config regression fixture.',
                emitMetrics: false
            }).exitCode, 0);
            weakenOutOfScopePolicy(repoRoot);

            const result = runCompletionGate({
                repoRoot,
                taskId,
                preflightPath
            });
            const violations = result.violations.join('\n');

            assert.equal(result.outcome, 'FAIL');
            assert.match(violations, /without task-mode --workflow-config-work/);
            assert.doesNotMatch(violations, /missing COMPILE_GATE_PASSED/);
            assert.doesNotMatch(violations, /missing REVIEW_GATE_PASSED/);
            assert.doesNotMatch(violations, /Compile gate evidence .*missing/i);
            assert.doesNotMatch(violations, /Review gate evidence .*missing/i);
            assert.doesNotMatch(violations, /Doc impact evidence .*missing/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('blocks late ignored bundle workflow-config edits before full-suite', { concurrency: false }, async () => {
        const taskId = 'T-900workflow-config-late-ignored-bundle';
        const repoRoot = prepareTaskRepo(taskId, {
            orchestratorWork: true,
            ignoreBundle: true
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);

        try {
            const appPath = editAppFile(repoRoot);
            runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                changedFiles: [appPath],
                outputPath: preflightPath,
                emitMetrics: false
            });
            weakenOutOfScopePolicy(repoRoot);

            const result = await runFullSuiteValidationCommand({
                repoRoot,
                taskId,
                preflightPath
            });

            assert.notEqual(result.exitCode, 0);
            assert.match(result.outputText, /garda-agent-orchestrator\/live\/config\/workflow-config\.json/);
            assert.match(result.outputText, /without task-mode --workflow-config-work/);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('allows ordinary task preflight after audited workflow set refreshes protected manifest', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-workflow-set-refreshes-manifest';
        const repoRoot = prepareTaskRepo(taskId);
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');

        try {
            const workflowResult = captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-out-of-scope-failure-policy', 'audit_and_warn',
                '--operator-confirmed', 'yes',
                '--operator-confirmed-at-utc', new Date().toISOString()
            ], PACKAGE_JSON));
            assert.ok(workflowResult && workflowResult.action === 'set');
            assert.equal(workflowResult.status, 'CHANGED');
            assert.equal(typeof workflowResult.audit_path, 'string');
            assert.ok(fs.existsSync(String(workflowResult.audit_path)));
            assert.equal(typeof workflowResult.protected_manifest_path, 'string');
            assert.ok(fs.existsSync(String(workflowResult.protected_manifest_path)));
            const auditText = fs.readFileSync(String(workflowResult.audit_path), 'utf8');
            assert.match(auditText, /"event_source":"workflow-config-set"/);

            const taskModeResult = runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Start ordinary task after audited workflow set'
            });
            assert.equal(taskModeResult.exitCode, 0);
            assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
            runHandshakeForTask(repoRoot, taskId);
            runShellSmokeForTask(repoRoot, taskId);

            const result = runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Update app flow',
                emitMetrics: false
            });
            const payload = JSON.parse(result.outputText);
            assert.equal(payload.triggers.protected_control_plane_manifest_status, 'MATCH');
            assert.deepEqual(payload.triggers.changed_workflow_config_files, []);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
