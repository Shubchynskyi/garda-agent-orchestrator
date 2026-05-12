import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { handleWorkflow } from '../../../../src/cli/commands/workflow-command';
import { runCompileGateCommand } from '../../../../src/cli/commands/gate-flows/compile-flow';
import { runFullSuiteValidationCommand } from '../../../../src/cli/commands/gate-flows/full-suite-validation-flow';
import { runCompletionGate } from '../../../../src/gates/completion';
import { isWorkflowConfigControlPlanePath, writeProtectedControlPlaneManifest } from '../../../../src/gates/helpers';
import {
    getCurrentWorkflowConfigChanges,
    getCurrentWorkflowConfigFileHashes,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigWorkViolations
} from '../../../../src/gates/workflow-config-work';
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
    writePreflight
} from './gate-test-helpers';

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
    writeBaselineAgentEntrypoint(repoRoot);
    seedTaskQueue(repoRoot, taskId);
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
        full_suite_validation: { out_of_scope_failure_policy: string };
    };
    config.full_suite_validation.out_of_scope_failure_policy = 'AUDIT_AND_WARN';
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8');
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
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
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
            writeBaselineAgentEntrypoint(repoRoot);
            seedTaskQueue(repoRoot, taskId);
            seedInitAnswers(repoRoot);
            initializeGitRepo(repoRoot);

            const result = runEnterTaskMode({
                repoRoot,
                taskId,
                orchestratorWork: true,
                workflowConfigWork: true,
                taskSummary: 'Update app flow'
            });
            assert.equal(result.exitCode, 0);
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
            initializeGitRepo(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
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
            initializeGitRepo(repoRoot);
            writeProtectedControlPlaneManifest(repoRoot);
            weakenOutOfScopePolicy(repoRoot);

            assert.throws(
                () => runEnterTaskMode({
                    repoRoot,
                    taskId,
                    orchestratorWork: true,
                    workflowConfigWork: true,
                    taskSummary: 'Update orchestrator workflow config'
                }),
                /already contains workflow config changes before task-mode entry/
            );
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

    it('blocks ordinary task preflight even when workflow-config policy change was made through workflow set', { concurrency: false }, () => {
        const taskId = 'T-900workflow-config-workflow-set-not-bypass';
        const repoRoot = prepareTaskRepo(taskId);
        const bundleRoot = path.join(repoRoot, 'garda-agent-orchestrator');

        try {
            const workflowResult = captureConsole(() => handleWorkflow([
                'set',
                '--bundle-root', bundleRoot,
                '--full-suite-out-of-scope-failure-policy', 'audit_and_warn'
            ], PACKAGE_JSON));
            assert.ok(workflowResult && workflowResult.action === 'set');
            assert.equal(workflowResult.status, 'CHANGED');
            assert.equal(typeof workflowResult.audit_path, 'string');
            assert.ok(fs.existsSync(String(workflowResult.audit_path)));
            const auditText = fs.readFileSync(String(workflowResult.audit_path), 'utf8');
            assert.match(auditText, /"event_source":"workflow-config-set"/);

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
});
