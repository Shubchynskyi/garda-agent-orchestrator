import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import * as childProcess from 'node:child_process';

const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

const PROVIDER_BRIDGE_BY_SOURCE: Record<string, string> = {
    GitHubCopilot: '.github/agents/orchestrator.md',
    Windsurf: '.windsurf/agents/orchestrator.md',
    Junie: '.junie/agents/orchestrator.md',
    Antigravity: '.antigravity/agents/orchestrator.md'
};

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.provider || '').trim() || String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
        if (!sourceOfTruth || !routedTo) {
            return options;
        }
        return {
            ...options,
            provider: sourceOfTruth,
            routedTo
        };
    } catch {
        return options;
    }
}

function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    return runEnterTaskModeCommand(withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    }));
}

function createTempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gates-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    return root;
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ];
    for (const ruleFile of ruleFiles) {
        fs.writeFileSync(path.join(rulesRoot, ruleFile), `# ${ruleFile}\n`, 'utf8');
    }
}

function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: 'AGENTS.md'
    }, null, 2), 'utf8');
}

function writeHandshakeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    let canonicalSourceOfTruth = provider;
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            const seededSourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
            if (seededSourceOfTruth) {
                canonicalSourceOfTruth = seededSourceOfTruth;
            }
        } catch {
            // Keep the lightweight test fixture tolerant of malformed init answers.
        }
    }
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || 'AGENTS.md';
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-handshake.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'handshake-diagnostics',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_provider: provider,
        canonical_source_of_truth: canonicalSourceOfTruth,
        canonical_entrypoint: canonicalEntrypoint,
        canonical_entrypoint_exists: true,
        provider_bridge: providerBridgePath,
        provider_bridge_exists: providerBridgePath !== null,
        routed_to: routedTo,
        execution_provider_source: 'explicit_provider',
        runtime_identity_status: 'resolved',
        start_task_router_path: '.agents/workflows/start-task.md',
        start_task_router_exists: true,
        execution_context: 'materialized-bundle',
        cli_path: 'node garda-agent-orchestrator/bin/garda.js',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        diagnostics: [],
        violations: []
    }, null, 2), 'utf8');
}

function runHandshakeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeHandshakeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-handshake.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const artifact = JSON.parse(artifactContent) as Record<string, unknown>;
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'PASS',
        `Handshake diagnostics passed: provider=${provider}, context=materialized-bundle.`,
        {
            provider,
            execution_provider: artifact.execution_provider ?? provider,
            canonical_source_of_truth: artifact.canonical_source_of_truth ?? provider,
            execution_provider_source: artifact.execution_provider_source ?? 'explicit_provider',
            execution_context: 'materialized-bundle',
            cli_path: 'node garda-agent-orchestrator/bin/garda.js',
            passed: true,
            artifact_hash: artifactHash
        },
        { actor: 'gate', passThru: true }
    );
}

function writeShellSmokeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-shell-smoke.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'shell-smoke-preflight',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        execution_context: 'materialized-bundle',
        effective_cwd: repoRoot.replace(/\\/g, '/'),
        workspace_root: repoRoot.replace(/\\/g, '/'),
        probes: [],
        violations: []
    }, null, 2), 'utf8');
}

function runShellSmokeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
    writeShellSmokeArtifact(repoRoot, taskId, provider);
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const artifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-shell-smoke.json`);
    const artifactContent = fs.readFileSync(artifactPath, 'utf8');
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'SHELL_SMOKE_PREFLIGHT_RECORDED',
        'PASS',
        `Shell smoke preflight passed: provider=${provider}, context=materialized-bundle.`,
        { provider, execution_context: 'materialized-bundle', passed: true, artifact_hash: artifactHash },
        { actor: 'gate', passThru: true }
    );
}

function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
    const result = childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        windowsHide: true,
        encoding: 'utf8'
    });
    if (result.error) {
        throw result.error;
    }
    assert.equal(
        result.status,
        0,
        `git ${args.join(' ')} failed: ${String(result.stderr || result.stdout || '').trim()}`
    );
    return result;
}

function initializeGitRepo(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'test: baseline']);
}

function backdateFileMtime(filePath: string, secondsAgo = 5): void {
    const older = new Date(Date.now() - (secondsAgo * 1000));
    fs.utimesSync(filePath, older, older);
}

function writeDriftedProtectedManifest(repoRoot: string, changedFiles: string[] = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']): void {
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
    for (const changedFile of changedFiles) {
        protectedSnapshot[changedFile] = 'stale-manifest-hash';
    }
    fs.writeFileSync(manifestPath, JSON.stringify({
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: '2026-04-02T16:59:00.000Z',
        workspace_root: repoRoot.replace(/\\/g, '/'),
        orchestrator_root: getOrchestratorRoot(repoRoot).replace(/\\/g, '/'),
        protected_roots: ['garda-agent-orchestrator/live/docs/agent-rules/'],
        protected_snapshot: protectedSnapshot,
        is_source_checkout: false
    }, null, 2), 'utf8');
}

describe('cli/commands/gates — dirty-workspace and isolation', () => {
    it('blocks classify-change when workspace was already dirty before task-mode entry without explicit isolation', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
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

    it('allows classify-change when trusted protected manifest drift is inherited from the dirty baseline only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900manifest-drift-baseline-only';
        const outputPath = path.join(repoRoot, 'preflight-manifest-drift-baseline-only.json');
        const protectedRulePath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
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
