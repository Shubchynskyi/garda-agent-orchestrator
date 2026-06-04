import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    EXIT_GATE_FAILURE
} from '../../../../../../src/cli/exit-codes';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../../../../src/gate-runtime/task-events-locking';
import {
    runClassifyChangeCommand,
    runCommandTimeoutDiagnosticsCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../../../../../../src/cli/commands/gates';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
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

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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

function captureExpectedError(callback: () => void): Error {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
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

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO', profile = 'default'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | ${profile} | fixture |`
    ].join('\n'), 'utf8');
}

function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const routedTo = PROVIDER_ENTRYPOINT_BY_SOURCE[sourceOfTruth];
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
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
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
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    const providerEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const routedTo = providerBridgePath || providerEntrypoint || null;
    const executionProviderSource = providerBridgePath ? 'provider_bridge' : 'provider_entrypoint';
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
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
        execution_provider_source: executionProviderSource,
        runtime_identity_status: 'resolved',
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: routedTo,
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
    const artifactHash = createHash('sha256').update(artifactContent).digest('hex');
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
            execution_provider_source: artifact.execution_provider_source ?? 'provider_entrypoint',
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
    const artifactHash = createHash('sha256').update(artifactContent).digest('hex');
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

function initializeGitRepo(repoRoot: string): void {
    const runGit = (args: string[]) => {
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
    };
    runGit(['init']);
    runGit(['config', 'user.name', 'Garda Tests']);
    runGit(['config', 'user.email', 'garda-tests@example.com']);
    runGit(['add', '.']);
    runGit(['commit', '-m', 'test: baseline']);
}

describe('cli/commands/gates — preflight diagnostics', () => {
    it('fails shell-smoke-preflight when the latest handshake was superseded by a newer task-mode cycle', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-stale-handshake';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale handshake evidence before shell smoke preflight'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Start a newer task cycle before shell smoke preflight'
        });

        const shellSmokeResult = runShellSmokePreflightCommand({
            repoRoot,
            taskId
        });
        assert.equal(shellSmokeResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(shellSmokeResult.outputLines[0], 'SHELL_SMOKE_PREFLIGHT_FAILED');
        assert.ok(shellSmokeResult.outputLines.some((line) => line.includes('predates the latest TASK_MODE_ENTERED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows shell-smoke-preflight when runtime identity is resolved from a custom task-mode path and the handshake is legacy-compatible', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-custom-task-mode-legacy-handshake';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow shell-smoke-preflight from a custom task-mode path without repeating provider flags',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        writeHandshakeArtifact(repoRoot, taskId, 'Codex');
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const handshakePath = path.join(getReviewsRoot(repoRoot), `${taskId}-handshake.json`);
        const handshakeArtifact = JSON.parse(fs.readFileSync(handshakePath, 'utf8')) as Record<string, unknown>;
        delete handshakeArtifact.reviewer_subagent_launch_status;
        delete handshakeArtifact.reviewer_subagent_launch_route;
        const handshakeContent = JSON.stringify(handshakeArtifact, null, 2);
        fs.writeFileSync(handshakePath, handshakeContent, 'utf8');
        const handshakeHash = createHash('sha256').update(handshakeContent).digest('hex');
        appendTaskEvent(
            orchestratorRoot,
            taskId,
            'HANDSHAKE_DIAGNOSTICS_RECORDED',
            'PASS',
            'Legacy handshake diagnostics recorded for custom task-mode shell-smoke coverage.',
            {
                provider: 'Codex',
                execution_provider: 'Codex',
                canonical_source_of_truth: 'Codex',
                execution_provider_source: 'provider_entrypoint',
                execution_context: 'materialized-bundle',
                cli_path: 'node garda-agent-orchestrator/bin/garda.js',
                passed: true,
                artifact_hash: handshakeHash
            },
            { actor: 'gate', passThru: true }
        );

        const result = runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        });

        assert.equal(result.exitCode, 0, result.outputLines.join('\n'));
        assert.match(result.outputLines.join('\n'), /SHELL_SMOKE_PREFLIGHT_PASSED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects shell-smoke-preflight when runtime identity is missing instead of inferring SourceOfTruth', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-legacy-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runShellSmokePreflightCommand({
            repoRoot,
            taskId
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' before shell-smoke-preflight/i);
        assert.match(error.message, /Re-enter task mode with explicit runtime identity via `--provider "<provider>"`/i);
        assert.match(error.message, /enter-task-mode/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode artifacts in shell-smoke identity-failure remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-legacy-fallback-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' before shell-smoke-preflight/i);
        assert.match(error.message, /--artifact-path/i);
        assert.match(error.message, new RegExp(escapeRegExp(customTaskModePath)));
        assert.match(error.message, /--task-mode-path/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows shell-smoke-preflight when runtime identity is pinned with an explicit provider session', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-direct-provider';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow shell-smoke-preflight after explicit provider task-mode entry',
            provider: 'Codex'
        });
        runHandshakeForTask(repoRoot, taskId, 'Codex');

        const result = runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            provider: 'Codex'
        });

        assert.equal(result.exitCode, 0);
        assert.match(result.outputLines.join('\n'), /SHELL_SMOKE_PREFLIGHT_PASSED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects shell-smoke-preflight when persisted task-mode launchability is blocked', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-launchability-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block shell-smoke-preflight when persisted reviewer launchability is unavailable',
            provider: 'Codex'
        });
        runHandshakeForTask(repoRoot, taskId, 'Codex');

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const taskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskModeArtifact.reviewer_subagent_launch_status = 'blocked';
        taskModeArtifact.reviewer_subagent_launch_reason = 'Reviewer subagent launch is blocked for the persisted task-mode runtime.';
        taskModeArtifact.reviewer_subagent_launch_remediation = 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.';
        fs.writeFileSync(taskModePath, JSON.stringify(taskModeArtifact, null, 2), 'utf8');

        const error = captureExpectedError(() => runShellSmokePreflightCommand({
            repoRoot,
            taskId
        }));

        assert.match(error.message, /Reviewer subagent launchability is 'blocked' before shell-smoke-preflight/i);
        assert.match(error.message, /Re-enter task mode with a runtime session that can launch delegated reviewer subagents/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode artifacts in blocked-launchability remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-launchability-blocked-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block shell-smoke-preflight with custom task-mode artifact when delegated reviewer launchability is unavailable',
            provider: 'Codex',
            artifactPath: customTaskModePath
        });
        runHandshakeForTask(repoRoot, taskId, 'Codex');

        const taskModeArtifact = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        taskModeArtifact.reviewer_subagent_launch_status = 'blocked';
        taskModeArtifact.reviewer_subagent_launch_reason = 'Reviewer subagent launch is blocked for the persisted task-mode runtime.';
        taskModeArtifact.reviewer_subagent_launch_remediation = 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.';
        fs.writeFileSync(customTaskModePath, JSON.stringify(taskModeArtifact, null, 2), 'utf8');

        const error = captureExpectedError(() => runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        }));

        assert.match(error.message, /Reviewer subagent launchability is 'blocked' before shell-smoke-preflight/i);
        assert.match(error.message, /--artifact-path/i);
        assert.match(error.message, new RegExp(escapeRegExp(customTaskModePath)));
        assert.match(error.message, /--task-mode-path/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails handshake-diagnostics when persisted task-mode launchability is blocked', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-launchability-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# routed workflow fixture\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail handshake-diagnostics when persisted reviewer launchability is unavailable',
            provider: 'Codex'
        });

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const taskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskModeArtifact.reviewer_subagent_launch_status = 'blocked';
        taskModeArtifact.reviewer_subagent_launch_reason = 'Reviewer subagent launch is blocked for the persisted task-mode runtime.';
        taskModeArtifact.reviewer_subagent_launch_remediation = 'Re-enter task mode with a runtime session that can launch delegated reviewer subagents.';
        fs.writeFileSync(taskModePath, JSON.stringify(taskModeArtifact, null, 2), 'utf8');

        const result = runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.match(result.outputLines.join('\n'), /ReviewerSubagentLaunchStatus: blocked/);
        assert.match(result.outputLines.join('\n'), /Reviewer subagent launch is blocked for the persisted task-mode runtime/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects command-timeout-diagnostics when runtime identity is missing instead of inferring SourceOfTruth', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-command-timeout-legacy-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runCommandTimeoutDiagnosticsCommand({
            repoRoot,
            taskId
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' before command-timeout-diagnostics/i);
        assert.match(error.message, /Re-enter task mode with explicit runtime identity via `--provider "<provider>"`/i);
        assert.match(error.message, /command-timeout-diagnostics/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode artifacts in command-timeout identity-failure remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-command-timeout-legacy-fallback-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runCommandTimeoutDiagnosticsCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        }));

        assert.match(error.message, /Runtime execution identity is 'missing' before command-timeout-diagnostics/i);
        assert.match(error.message, /--artifact-path/i);
        assert.match(error.message, new RegExp(escapeRegExp(customTaskModePath)));
        assert.match(error.message, /--task-mode-path/i);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows command-timeout-diagnostics when runtime identity is pinned with an explicit provider session', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-command-timeout-direct-provider';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const result = runCommandTimeoutDiagnosticsCommand({
            repoRoot,
            taskId,
            provider: 'Codex'
        });

        assert.equal(result.exitCode, 0);
        assert.match(result.outputLines.join('\n'), /COMMAND_TIMEOUT_DIAGNOSTICS_PASSED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('serializes pre-preflight gates behind a shared task lock', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-pre-preflight-sequence-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const lockPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const { handle } = acquireFilesystemLock(lockPath, {
            timeoutMs: 1000,
            retryMs: 25,
            staleMs: 30_000
        });

        try {
            assert.throws(
                () => runShellSmokePreflightCommand({
                    repoRoot,
                    taskId,
                    provider: 'Codex',
                    routedTo: 'AGENTS.md'
                }),
                /Timed out acquiring file lock/
            );
        } finally {
            releaseFilesystemLock(handle);
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('serializes handshake-diagnostics behind the shared pre-preflight task lock', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-pre-preflight-handshake-sequence-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const lockPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const { handle } = acquireFilesystemLock(lockPath, {
            timeoutMs: 1000,
            retryMs: 25,
            staleMs: 30_000
        });

        try {
            assert.throws(
                () => runHandshakeDiagnosticsCommand({
                    repoRoot,
                    taskId
                }),
                /Timed out acquiring file lock/
            );
        } finally {
            releaseFilesystemLock(handle);
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('serializes classify-change behind the shared pre-preflight task lock', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-pre-preflight-classify-sequence-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject classify-change overlap while the shared pre-preflight lock is held'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const lockPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}-pre-preflight-sequence.lock`);
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        const { handle } = acquireFilesystemLock(lockPath, {
            timeoutMs: 1000,
            retryMs: 25,
            staleMs: 30_000
        });

        try {
            assert.throws(
                () => runClassifyChangeCommand({
                    repoRoot,
                    taskId,
                    taskIntent: 'Reject classify-change overlap while the shared pre-preflight lock is held',
                    changedFiles: ['src/app.ts'],
                    emitMetrics: false
                }),
                /Timed out acquiring file lock/
            );
        } finally {
            releaseFilesystemLock(handle);
        }

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails handshake-diagnostics when the current task cycle already has valid shell-smoke evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-after-shell-smoke';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject handshake rerun after shell smoke already passed'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const handshakeResult = runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId
        });
        assert.equal(handshakeResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(handshakeResult.outputLines[0], 'HANDSHAKE_DIAGNOSTICS_FAILED');
        assert.ok(handshakeResult.outputLines.some((line) => line.includes('already has valid SHELL_SMOKE_PREFLIGHT_RECORDED evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows handshake and shell-smoke recovery after a later TASK_ENTRY rule-pack supersedes the old startup cycle', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-after-late-task-entry';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow startup-cycle recovery after a late TASK_ENTRY rule-pack'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'RULE_PACK_LOADED',
            'PASS',
            'TASK_ENTRY rules re-recorded after shell-smoke for startup-cycle recovery.',
            {
                stage: 'TASK_ENTRY'
            },
            { actor: 'gate', passThru: true }
        );

        const handshakeResult = runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId
        });
        assert.equal(handshakeResult.exitCode, 0);
        assert.equal(handshakeResult.outputLines[0], 'HANDSHAKE_DIAGNOSTICS_PASSED');
        assert.ok(!handshakeResult.outputLines.some((line) => line.includes('already has valid SHELL_SMOKE_PREFLIGHT_RECORDED evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode paths in handshake rerun remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-remediation-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode path in handshake rerun remediation',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const handshakeResult = runHandshakeDiagnosticsCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(handshakeResult.exitCode, EXIT_GATE_FAILURE);
        const outputText = handshakeResult.outputLines.join('\n');
        assert.ok(outputText.includes('--task-mode-path'), outputText);
        assert.ok(outputText.includes(customTaskModePath), outputText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode paths in shell-smoke rerun remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-remediation-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode path in shell-smoke rerun remediation',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        const shellSmokeResult = runShellSmokePreflightCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(shellSmokeResult.exitCode, EXIT_GATE_FAILURE);
        const outputText = shellSmokeResult.outputLines.join('\n');
        assert.ok(outputText.includes('--task-mode-path'), outputText);
        assert.ok(outputText.includes(customTaskModePath), outputText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails classify-change when the latest handshake supersedes shell smoke evidence for the current task cycle', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-classify-handshake-shell-smoke-overlap';
        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale shell smoke evidence before preflight classification'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Reject stale shell smoke evidence before preflight classification',
                changedFiles: ['src/app.ts'],
                outputPath: preflightPath,
                emitMetrics: false
            }),
            /Unsafe same-task overlap detected/
        );
        assert.equal(fs.existsSync(preflightPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not leave the default canonical preflight artifact when classify-change fails before write', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-default-preflight-failure-cleanup';
        const canonicalPreflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale shell smoke without partial default preflight artifact'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Reject stale shell smoke without partial default preflight artifact',
                changedFiles: ['src/app.ts'],
                emitMetrics: false
            }),
            /Unsafe same-task overlap detected/
        );
        assert.equal(fs.existsSync(canonicalPreflightPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
