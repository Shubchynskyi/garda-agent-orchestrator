import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../../../src/cli/commands/gates';
import { runCliMainWithHandling } from '../../../../../../src/cli/main';
import { getWorkspaceSnapshot } from '../../../../../../src/gates/compile/compile-gate';
import {
    applyReviewerRoutingMetadata
} from '../../../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../../../src/gate-runtime/task-events';
import { buildDefaultWorkflowConfig } from '../../../../../../src/core/workflow-config';
import { writeProtectedControlPlaneManifest } from '../../../../../../src/gates/shared/helpers';
import * as childProcess from 'node:child_process';

function createTempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gates-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    fs.writeFileSync(
        path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'),
        JSON.stringify(workflowConfig, null, 2) + '\n',
        'utf8'
    );
    writeProtectedControlPlaneManifest(root);
    return root;
}

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






function resolveAttestedTaskModeRoute(provider: string): string | null {
    const normalizedProvider = String(provider || '').trim();
    if (!normalizedProvider) {
        return null;
    }
    return PROVIDER_BRIDGE_BY_SOURCE[normalizedProvider] || PROVIDER_ENTRYPOINT_BY_SOURCE[normalizedProvider] || null;
}

function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
    if (String(options.routedTo || '').trim()) {
        return options;
    }
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    const explicitProvider = String(options.provider || '').trim();
    if (explicitProvider) {
        const routedTo = resolveAttestedTaskModeRoute(explicitProvider);
        return routedTo
            ? {
                ...options,
                provider: explicitProvider,
                routedTo
            }
            : options;
    }
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return options;
    }

    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        const routedTo = resolveAttestedTaskModeRoute(sourceOfTruth);
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
    const resolvedOptions = withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    });
    const repoRoot = path.resolve(String(resolvedOptions.repoRoot || '.'));
    const routedTo = String(resolvedOptions.routedTo || '').trim().replace(/\\/g, '/').replace(/^\.\//, '');
    if (routedTo) {
        const routedFilePath = path.join(repoRoot, routedTo);
        fs.mkdirSync(path.dirname(routedFilePath), { recursive: true });
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
        writeProtectedControlPlaneManifest(repoRoot);
    }
    return runEnterTaskModeCommand(resolvedOptions);
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


function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: { changed_lines_total: 3 },
        required_reviews: {
            code: true,
            db: false,
            security: false,
            refactor: false,
            api: false,
            test: false,
            performance: false,
            infra: false,
            dependency: false
        },
        triggers: {},
        changed_files: ['src/app.ts'],
        ...overrides
    };
    fs.writeFileSync(preflightPath, JSON.stringify(payload, null, 2), 'utf8');
    return preflightPath;
}

function runGitBestEffort(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function ensureReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return;
    }
    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGitBestEffort(repoRoot, ['init']);
    }
    runGitBestEffort(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGitBestEffort(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    if (head.status !== 0) {
        runGitBestEffort(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
    }
    for (const changedFile of changedFiles) {
        if (
            changedFile.startsWith('/')
            || changedFile.startsWith('../')
            || changedFile.includes('/../')
            || changedFile.startsWith(':')
        ) {
            continue;
        }
        const absolutePath = path.join(repoRoot, ...changedFile.split('/'));
        fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
        if (!fs.existsSync(absolutePath)) {
            fs.writeFileSync(absolutePath, `// legacy review fixture for ${changedFile}\n`, 'utf8');
        }
    }
}

function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
    const normalizedPreflightPath = preflightPath.replace(/\\/g, '/');
    const existingEvents = readTaskTimelineEvents(repoRoot, taskId);
    const latestMatchingEvent = [...existingEvents].reverse().find((event) => (
        event.event_type === 'PREFLIGHT_CLASSIFIED'
        && String((event.details as Record<string, unknown> | undefined)?.output_path || '') === normalizedPreflightPath
    ));
    if (latestMatchingEvent) {
        return;
    }

    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : {};
    const mode = String(preflight.mode || 'FULL_PATH');
    const changedFilesCount = Array.isArray(preflight.changed_files) ? preflight.changed_files.length : 0;
    const changedLinesTotal = Number(metrics.changed_lines_total || 0);
    const zeroDiffGuard = preflight.zero_diff_guard && typeof preflight.zero_diff_guard === 'object' && !Array.isArray(preflight.zero_diff_guard)
        ? preflight.zero_diff_guard
        : (changedFilesCount === 0 && changedLinesTotal === 0
            ? { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            : null);
    appendTaskEvent(
        getOrchestratorRoot(repoRoot),
        taskId,
        'PREFLIGHT_CLASSIFIED',
        'INFO',
        zeroDiffGuard
            ? `Preflight completed with mode ${mode} (zero-diff baseline only).`
            : `Preflight completed with mode ${mode}.`,
        {
            mode,
            output_path: normalizedPreflightPath,
            changed_files_count: changedFilesCount,
            changed_lines_total: changedLinesTotal,
            required_reviews: preflight.required_reviews || {},
            zero_diff_guard: zeroDiffGuard
        }
    );
}

function writeCompilePassEvidence(repoRoot: string, taskId: string, preflightPath: string): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const crypto = require('node:crypto');
    ensureReviewDiffFixture(repoRoot, preflightPath);
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const detectionSource = String(preflight.detection_source || 'explicit_changed_files').trim() || 'explicit_changed_files';
    const includeUntracked = preflight.include_untracked !== false;
    const workspaceSnapshot = getWorkspaceSnapshot(repoRoot, detectionSource, includeUntracked, changedFiles);
    const preflightHashSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: preflightHashSha256,
        scope_detection_source: detectionSource,
        scope_include_untracked: includeUntracked,
        scope_changed_files: workspaceSnapshot.changed_files,
        scope_changed_files_count: workspaceSnapshot.changed_files_count,
        scope_changed_lines_total: workspaceSnapshot.changed_lines_total,
        scope_changed_files_sha256: workspaceSnapshot.changed_files_sha256,
        scope_content_sha256: workspaceSnapshot.scope_content_sha256,
        scope_sha256: workspaceSnapshot.scope_sha256
    }, null, 2), 'utf8');
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', {
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: preflightHashSha256
    });
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
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || 'AGENTS.md';
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

function loadPostPreflightRulePack(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    ensurePreflightClassified = true,
    artifactPath = '',
    taskModePath = ''
) {
    if (ensurePreflightClassified) {
        appendPreflightClassifiedEvent(repoRoot, taskId, preflightPath);
    }
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
        artifactPath,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
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

describe('cli/commands/gates', () => {
    it('record-review-result rejects a foreign review-context path whose review_type does not match the requested review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-record-review-result-foreign-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 10 },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject foreign review-context materialization for delegated review evidence',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const codeArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const codeReceiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        let buildCodeExitCode = 0;
        let recordExitCode = 0;
        try {
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((arg) => String(arg)).join(' '));
            };
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', codeReviewContextPath
            ]);
            buildCodeExitCode = Number(process.exitCode ?? 0);

            const foreignReviewContext = JSON.parse(fs.readFileSync(codeReviewContextPath, 'utf8')) as Record<string, unknown>;
            foreignReviewContext.review_type = 'test';
            foreignReviewContext.output_path = testReviewContextPath.replace(/\\/g, '/');
            fs.writeFileSync(testReviewContextPath, JSON.stringify(foreignReviewContext, null, 2) + '\n', 'utf8');

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated the current implementation and found no blocking code-level defects in the scoped change, with concrete references to `src/cli/commands/gate-review-handlers.ts` and the foreign review-context path override used by this fixture. The review text also spells out the expected review-context binding so this fixture stays non-trivial before the foreign-context contract failure is evaluated.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildCodeExitCode, 0);
        assert.notEqual(recordExitCode, 0);
        assert.ok(capturedErrors.some((line) => line.includes("review_type 'test'")));
        assert.equal(fs.existsSync(codeArtifactPath), false);
        assert.equal(fs.existsSync(codeReceiptPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => (
            event.event_type === 'REVIEWER_DELEGATION_ROUTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        )), false);
        assert.equal(events.some((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        )), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects a custom legacy review-context path that omits task and preflight binding metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-record-review-result-legacy-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject legacy custom review-context artifacts without fresh-cycle binding metadata',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyContextPath = path.join(reviewsRoot, 'legacy-code-context.json');
        const reviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        let buildExitCode = 0;
        let recordExitCode = 0;
        try {
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((arg) => String(arg)).join(' '));
            };
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            const canonicalContext = JSON.parse(fs.readFileSync(canonicalContextPath, 'utf8')) as Record<string, unknown>;
            const legacyContext = {
                review_type: canonicalContext.review_type,
                task_scope: canonicalContext.task_scope,
                scoped_diff: canonicalContext.scoped_diff,
                reviewer_routing: canonicalContext.reviewer_routing
            };
            fs.writeFileSync(legacyContextPath, JSON.stringify(legacyContext, null, 2) + '\n', 'utf8');

            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                'Validated the scoped implementation and found no blocking issues, with concrete references to `src/cli/commands/gate-review-handlers.ts` and the legacy custom review-context override exercised by this fixture. The review text also covers the expected task and preflight binding metadata so the fixture remains substantive before the strict legacy-context validation fails.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-context-path', legacyContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.notEqual(recordExitCode, 0);
        assert.ok(capturedErrors.some((line) => (
            line.includes('missing task_id')
            || line.includes('missing preflight_path')
            || line.includes('missing preflight_sha256')
        )));
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects stripped current-style review-context identity metadata before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-105-record-review-result-stripped-runtime-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stripped current-style review-context identity metadata before review materialization',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const reviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        let buildExitCode = 0;
        let recordExitCode = 0;
        try {
            console.error = (...args: unknown[]) => {
                capturedErrors.push(args.map((arg) => String(arg)).join(' '));
            };
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            const strippedContext = JSON.parse(fs.readFileSync(canonicalContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = strippedContext.reviewer_routing as Record<string, unknown>;
            delete reviewerRouting.canonical_source_of_truth;
            delete reviewerRouting.execution_provider;
            delete reviewerRouting.execution_provider_source;
            delete reviewerRouting.identity_status;
            strippedContext.reviewer_routing = reviewerRouting;
            fs.writeFileSync(canonicalContextPath, JSON.stringify(strippedContext, null, 2) + '\n', 'utf8');
            applyReviewerRoutingMetadata(canonicalContextPath, {
                actualExecutionMode: 'delegated_subagent',
                reviewerSessionId: 'agent:code-reviewer',
                fallbackReason: null
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Delegated code review routed for stripped runtime-identity fixture.', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            }, { passThru: true });

            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                'Validated the scoped implementation and found no blocking issues, with concrete references to `src/cli/commands/gate-review-handlers.ts` and the stripped runtime-identity review-context fixture.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n'), 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.notEqual(recordExitCode, 0);
        assert.ok(capturedErrors.some((line) => (
            line.includes('missing canonical_source_of_truth')
            || line.includes('missing execution_provider')
            || line.includes('missing identity_status')
        )));
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
