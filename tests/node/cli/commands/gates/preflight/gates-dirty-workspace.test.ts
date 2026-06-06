import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../../../src/cli/main';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { computeProtectedSnapshotDigest } from '../../../../../../src/gates/shared/helpers';
import * as childProcess from 'node:child_process';
import {
    getReviewsRoot,
    getOrchestratorRoot,
    createTempRepo,
    runGit,
    initializeGitRepo,
    backdateFileMtime,
    seedTaskQueue,
    seedInitAnswers,
    runEnterTaskMode,
    loadTaskEntryRulePack,
    runHandshakeForTask,
    runShellSmokeForTask,
    readTaskTimelineEvents,
    PROVIDER_ENTRYPOINT_BY_SOURCE
} from '../../gate-test-helpers';

function writeDriftedProtectedManifest(
    repoRoot: string,
    changedFiles: string[] = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'],
    options: { isSourceCheckout?: boolean } = {}
): void {
    const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
    const rulesRoot = path.join(getOrchestratorRoot(repoRoot), 'live', 'docs', 'agent-rules');
    const crypto = require('node:crypto');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const protectedSnapshot: Record<string, string> = {};
    for (const ruleFile of fs.readdirSync(rulesRoot).filter((entry) => entry.endsWith('.md')).sort()) {
        const relativePath = `garda-agent-orchestrator/live/docs/agent-rules/${ruleFile}`;
        const contents = fs.readFileSync(path.join(rulesRoot, ruleFile), 'utf8');
        protectedSnapshot[relativePath] = crypto.createHash('sha256').update(contents).digest('hex');
    }
    if (fs.existsSync(path.join(repoRoot, 'AGENTS.md'))) {
        const contents = fs.readFileSync(path.join(repoRoot, 'AGENTS.md'), 'utf8');
        protectedSnapshot['AGENTS.md'] = crypto.createHash('sha256').update(contents).digest('hex');
    }
    const workflowConfigPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'workflow-config.json');
    if (fs.existsSync(workflowConfigPath)) {
        const contents = fs.readFileSync(workflowConfigPath, 'utf8');
        protectedSnapshot['garda-agent-orchestrator/live/config/workflow-config.json'] = crypto
            .createHash('sha256')
            .update(contents)
            .digest('hex');
    }
    for (const changedFile of changedFiles) {
        protectedSnapshot[changedFile] = '0'.repeat(64);
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: '2026-04-02T16:59:00.000Z',
        workspace_root: repoRoot.replace(/\\/g, '/'),
        orchestrator_root: getOrchestratorRoot(repoRoot).replace(/\\/g, '/'),
        protected_roots: ['garda-agent-orchestrator/live/docs/agent-rules/'],
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: options.isSourceCheckout === true
    }, null, 2), 'utf8');
}

function seedBaselineAgentsFile(repoRoot: string): void {
    fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# baseline\n', 'utf8');
}

describe('cli/commands/gates — dirty-workspace and isolation', () => {
    it('blocks classify-change when workspace was already dirty before task-mode entry without explicit isolation', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        backdateFileMtime(appPath);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Clarify dirty workspace preflight guard'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Clarify dirty workspace preflight guard',
                emitMetrics: false
            }),
            /Workspace already contained modified files before task-mode entry: src\/app\.ts\..*--use-staged/
        );

        const eventTypes = readTaskTimelineEvents(repoRoot, taskId).map((event) => event.event_type);
        assert.ok(eventTypes.includes('PREFLIGHT_STARTED'));
        assert.ok(eventTypes.includes('PREFLIGHT_FAILED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows classify-change when pre-existing dirty files are explicitly isolated with --use-staged', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 5;\nconst b = 8;\nconsole.log(a + b);\n', 'utf8');
        backdateFileMtime(appPath);
        runGit(repoRoot, ['add', 'src/app.ts']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow staged isolation for dirty workspace'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Allow staged isolation for dirty workspace',
            useStaged: true,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.equal(payload.detection_source, 'git_staged_only');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps staged deletion paths in classify-change --use-staged when the path is recreated untracked', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged-delete-recreate';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runGit(repoRoot, ['rm', 'src/app.ts']);
        fs.mkdirSync(path.dirname(appPath), { recursive: true });
        fs.writeFileSync(appPath, 'const replacement = 42;\nconsole.log(replacement);\n', 'utf8');
        backdateFileMtime(appPath);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep staged deletion in staged-only preflight scope'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const outputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Keep staged deletion in staged-only preflight scope',
            useStaged: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const preflight = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.deepEqual(preflight.changed_files, ['src/app.ts']);
        assert.equal(preflight.triggers.dirty_workspace_protected_files.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps pre-existing unrelated untracked files protected when isolate scope uses --use-staged', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-staged-untracked';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedUntrackedPath = path.join(repoRoot, 'src', 'scratch-note.ts');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedUntrackedPath, 'export const scratch = "local-only";\n', 'utf8');
        backdateFileMtime(appPath);
        backdateFileMtime(unrelatedUntrackedPath);
        runGit(repoRoot, ['add', 'src/app.ts']);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep unrelated untracked file protected during staged scope isolation'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const outputPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Keep unrelated untracked file protected during staged scope isolation',
            useStaged: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const preflight = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.task_id, taskId);
        assert.deepEqual(payload.changed_files, ['src/app.ts']);
        assert.equal(payload.detection_source, 'git_staged_only');
        assert.deepEqual(preflight.triggers.dirty_workspace_protected_files, ['src/scratch-note.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('blocks classify-change when the trusted protected manifest is already drifted before task start', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-drift';
        const outputPath = path.join(repoRoot, 'preflight-manifest-drift.json');
        seedBaselineAgentsFile(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject ordinary task start on trusted manifest drift'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Reject ordinary task start on trusted manifest drift',
                outputPath,
                emitMetrics: false
            }),
            /Trusted protected control-plane manifest drift detected before preflight classification/
        );
        assert.equal(fs.existsSync(outputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows clean source-checkout inherited protected manifest drift without forcing orchestrator-work', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-source-checkout-inherited';
        const outputPath = path.join(repoRoot, 'preflight-manifest-source-checkout-inherited.json');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            name: 'garda-agent-orchestrator',
            version: '0.0.0-test'
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        writeDriftedProtectedManifest(repoRoot, ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md'], {
            isSourceCheckout: true
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow inherited source-checkout manifest drift on clean task start'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId,
            taskIntent: 'Allow inherited source-checkout manifest drift on clean task start',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.scope_category, 'empty');
        assert.deepEqual(payload.changed_files, []);
        assert.equal(payload.triggers.protected_control_plane_manifest_status, 'DRIFT');
        assert.deepEqual(
            payload.triggers.protected_control_plane_manifest_changed_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_assessment,
            'INFO_SOURCE_CHECKOUT_INHERITED_DRIFT'
        );
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows classify-change when trusted protected manifest drift is inherited from the dirty baseline only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-drift-baseline-only';
        const outputPath = path.join(repoRoot, 'preflight-manifest-drift-baseline-only.json');
        const protectedRulePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
        seedBaselineAgentsFile(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(protectedRulePath, '# baseline protected drift\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow inherited protected manifest drift on an ordinary scoped task'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, taskId);
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Allow inherited protected manifest drift on an ordinary scoped task',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.triggers.protected_control_plane_manifest_status, 'DRIFT');
        assert.deepEqual(
            payload.triggers.dirty_workspace_protected_files,
            ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_baseline_allowance_status,
            'INHERITED_BASELINE_ONLY'
        );
        assert.equal(
            payload.triggers.protected_control_plane_manifest_assessment,
            'INFO_TASK_CONTEXT_ALLOWED_DRIFT'
        );
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('prepare-isolation prints same-user notice and records sandbox preparation telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-905i';
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const configPath = path.join(orchestratorRoot, 'live', 'config', 'isolation-mode.json');
        const notice = 'Custom same-user notice for prepare-isolation regression coverage.';
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        const previousCwd = process.cwd();
        const previousExitCode = process.exitCode;

        seedTaskQueue(repoRoot, taskId);
        fs.mkdirSync(path.dirname(configPath), { recursive: true });
        fs.writeFileSync(configPath, JSON.stringify({
            enabled: true,
            enforcement: 'LOG_ONLY',
            require_manifest_match_before_task: true,
            refuse_on_preflight_drift: true,
            use_sandbox: true,
            same_user_limitation_notice: notice
        }, null, 2) + '\n', 'utf8');

        process.exitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };

        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'prepare-isolation',
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const output = capturedLogs.join('\n');
        assert.ok(output.includes('ISOLATION_SANDBOX_PREPARED'));
        assert.ok(output.includes(`SameUserNotice: ${notice}`));

        const timelineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const preparationEvent = timelineEvents.find((event) => event.event_type === 'ISOLATION_SANDBOX_PREPARED');
        assert.ok(preparationEvent, 'sandbox preparation event must be appended to the task timeline');
        assert.equal(preparationEvent?.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
