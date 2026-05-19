import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    EXIT_GATE_FAILURE
} from '../../../../src/cli/exit-codes';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../../src/gate-runtime/task-events-locking';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runCommandTimeoutDiagnosticsCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runLoadRulePackCommand,
    runShellSmokePreflightCommand
} from '../../../../src/cli/commands/gates';
import {
    assertGateChainDecision,
    runCliWithCapturedOutput
} from './gate-test-helpers';
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

function computeTaskTextSha256(taskText: string): string {
    return createHash('sha256').update(taskText.trim(), 'utf8').digest('hex');
}

function seedNodeBackendOptionalSkillFixture(
    repoRoot: string,
    policyMode: 'advisory' | 'required' | 'strict' | 'off' = 'advisory'
): string {
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const configDir = path.join(orchestratorRoot, 'live', 'config');
    const skillRoot = path.join(orchestratorRoot, 'live', 'skills', 'node-backend');
    fs.mkdirSync(configDir, { recursive: true });
    fs.mkdirSync(skillRoot, { recursive: true });
    fs.writeFileSync(
        path.join(configDir, 'garda.config.json'),
        JSON.stringify({
            version: 1,
            configs: {
                'optional-skill-selection-policy': 'optional-skill-selection-policy.json',
                'skill-packs': 'skill-packs.json'
            }
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'skill-packs.json'),
        JSON.stringify({ version: 1, installed_packs: ['node-backend'] }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(configDir, 'optional-skill-selection-policy.json'),
        JSON.stringify({ version: 1, mode: policyMode }, null, 2),
        'utf8'
    );
    fs.writeFileSync(
        path.join(skillRoot, 'skill.json'),
        JSON.stringify({
            id: 'node-backend',
            pack: 'node-backend',
            name: 'Node Backend',
            summary: 'Node backend specialist for request validation and API work.',
            tags: ['node', 'backend', 'api'],
            aliases: ['node-backend', 'node'],
            task_signals: ['request validation', 'api endpoint', 'node-backend'],
            changed_path_signals: ['src/api/', 'orders.ts'],
            references: [],
            cost_hint: 'low',
            priority: 50,
            autoload: 'suggest'
        }, null, 2),
        'utf8'
    );
    fs.writeFileSync(path.join(skillRoot, 'SKILL.md'), '# Node Backend\n\nUse for Node backend API work.\n', 'utf8');
    return path.join(skillRoot, 'SKILL.md');
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

function writeWorkflowConfig(repoRoot: string, payload: string): string {
    const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, payload, 'utf8');
    return configPath;
}

function seedStrictProfileConfig(repoRoot: string): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'review-capabilities.json'), JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    }, null, 2), 'utf8');
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced',
                depth: 2,
                review_policy: { code: true, db: 'auto', security: 'auto', refactor: 'auto' },
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true }
            },
            strict: {
                description: 'Strict',
                depth: 3,
                review_policy: { code: true, db: true, security: true, refactor: true },
                token_economy: {
                    enabled: true,
                    strip_examples: false,
                    strip_code_blocks: false,
                    scoped_diffs: true,
                    compact_reviewer_output: false
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
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

function runExplicitPreflight(
    repoRoot: string,
    taskId: string,
    taskIntent: string,
    changedFiles: string[],
    outputFileName = `${taskId}-preflight.json`,
    taskModePath = ''
): string {
    const preflightPath = path.join(getReviewsRoot(repoRoot), outputFileName);
    const result = runClassifyChangeCommand({
        repoRoot,
        taskId,
        taskIntent,
        changedFiles,
        taskModePath,
        outputPath: preflightPath,
        emitMetrics: false
    });
    const payload = JSON.parse(result.outputText);
    assert.equal(payload.task_id, taskId);
    return preflightPath;
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

describe('cli/commands/gates — preflight', () => {
    it('classify-change uses legacy compatibility mode when workflow-config is missing', () => {
        const repoRoot = createTempRepo();
        try {
            const result = runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            });
            const parsed = JSON.parse(result.outputText) as Record<string, unknown>;
            assert.deepEqual(parsed.review_execution_policy, {
                mode: 'legacy_test_downstream',
                visible_summary_line: 'Review execution policy: legacy_test_downstream (implicit compatibility mode)'
            });
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when workflow-config is malformed', () => {
        const repoRoot = createTempRepo();
        try {
            writeWorkflowConfig(repoRoot, '{"full_suite_validation":');
            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            }));
            assert.match(error.message, /workflow-config\.json/i);
            assert.match(error.message, /JSON/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classify-change fails closed when workflow-config uses a case-drifted review_execution_policy key', () => {
        const repoRoot = createTempRepo();
        try {
            writeWorkflowConfig(repoRoot, JSON.stringify({
                full_suite_validation: {
                    enabled: false,
                    command: 'npm test',
                    timeout_ms: 600000,
                    green_summary_max_lines: 5,
                    red_failure_chunk_lines: 50,
                    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
                },
                Review_Execution_Policy: {
                    mode: 'parallel_all'
                }
            }, null, 2));
            const error = captureExpectedError(() => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskIntent: 'Adjust workflow review ordering'
            }));
            assert.match(error.message, /exact key 'review_execution_policy'/i);
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('classifies security file and emits risk_aware_depth with promoted effective depth', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const securityFilePath = path.join(repoRoot, 'src', 'auth', 'jwt-guard.ts');
        fs.mkdirSync(path.dirname(securityFilePath), { recursive: true });
        fs.writeFileSync(securityFilePath, 'export function verify() { return true; }\n', 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-sec.json');
        seedTaskQueue(repoRoot, 'T-930');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Add JWT guard feature'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-930');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930');
        runShellSmokeForTask(repoRoot, 'T-930');
        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/auth/jwt-guard.ts'],
            taskId: 'T-930',
            taskIntent: 'Add JWT guard feature',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.security, true);
        assert.ok(payload.risk_aware_depth, 'risk_aware_depth should be present');
        assert.equal(payload.risk_aware_depth.effective_depth, 3, 'security trigger should promote to depth 3');
        assert.equal(payload.risk_aware_depth.escalated, true);
        assert.equal(payload.risk_aware_depth.compression.risk_level, 'high');
        assert.equal(payload.risk_aware_depth.compression.strip_examples, false);
        assert.equal(payload.risk_aware_depth.compression.strip_code_blocks, false);
        // Budget forecast should use the promoted depth
        assert.equal(payload.budget_forecast.effective_depth, 3);
        assert.equal(payload.budget_forecast.depth_escalated, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change emits task profile selection and keeps full-path safety floors for fast tasks', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const testFilePath = path.join(repoRoot, 'tests', 'app.test.ts');
        fs.mkdirSync(path.dirname(testFilePath), { recursive: true });
        fs.writeFileSync(testFilePath, 'export const suite = true;\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'review-capabilities.json'), JSON.stringify({
            code: true,
            db: true,
            security: true,
            refactor: true,
            api: true,
            test: true,
            performance: true,
            infra: false,
            dependency: true
        }, null, 2));
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'profiles.json'), JSON.stringify({
            version: 1,
            active_profile: 'balanced',
            built_in_profiles: {
                balanced: {
                    description: 'Balanced',
                    depth: 2,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                },
                fast: {
                    description: 'Fast',
                    depth: 1,
                    review_policy: { code: true, test: 'auto' },
                    token_economy: {
                        enabled: true,
                        strip_examples: true,
                        strip_code_blocks: true,
                        scoped_diffs: true,
                        compact_reviewer_output: true
                    },
                    skills: { auto_suggest: true }
                }
            },
            user_profiles: {}
        }, null, 2));
        const outputPath = path.join(repoRoot, 'preflight-fast-profile.json');
        seedTaskQueue(repoRoot, 'T-930-fast-profile', 'TODO', 'fast');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-profile',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Honor fast task profile without bypassing full-path floors'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-profile').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-profile');
        runShellSmokeForTask(repoRoot, 'T-930-fast-profile');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts', 'tests/app.test.ts'],
            taskId: 'T-930-fast-profile',
            taskIntent: 'Honor fast task profile without bypassing full-path floors',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.profile_selection.task_profile, 'fast');
        assert.equal(payload.profile_selection.profile_selection_source, 'task_queue');
        assert.equal(payload.profile_selection.effective_profile, 'fast');
        assert.equal(payload.profile_selection.runtime_active_profile, 'balanced');
        assert.ok(payload.profile_guardrails, 'profile_guardrails should be present');
        assert.equal(payload.budget_forecast.requested_depth, 1);
        assert.equal(payload.budget_forecast.effective_depth, 2);
        assert.equal(payload.depth_escalation.escalated, true);
        assert.match(String(payload.depth_escalation.escalation_reason || ''), /full_path_minimum_depth_2/);
        assert.equal(payload.required_reviews.test, true);
        assert.equal(payload.required_reviews.api, false);
        assert.equal(payload.required_reviews.dependency, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.budget_forecast.token_economy_active_for_depth, true);

        seedTaskQueue(repoRoot, 'T-930-fast-docs-only', 'TODO', 'fast');
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-docs-only',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Avoid reviewer launch for fast docs-only edits'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-docs-only').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-docs-only');
        runShellSmokeForTask(repoRoot, 'T-930-fast-docs-only');

        const docsOnlyResult = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md'],
            taskId: 'T-930-fast-docs-only',
            taskIntent: 'Avoid reviewer launch for fast docs-only edits',
            outputPath: path.join(repoRoot, 'preflight-fast-docs-only.json'),
            emitMetrics: false
        });

        const docsOnlyPayload = JSON.parse(docsOnlyResult.outputText);
        assert.equal(docsOnlyPayload.scope_category, 'docs-only');
        assert.equal(docsOnlyPayload.profile_selection.effective_profile, 'fast');
        assert.equal(docsOnlyPayload.required_reviews.code, false);
        assert.equal(
            docsOnlyPayload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'lightened_by_profile'
        );
        assert.equal(docsOnlyPayload.budget_forecast.required_reviews.includes('code'), false);

        seedTaskQueue(repoRoot, 'T-930-fast-docs-force-code', 'TODO', 'fast');
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-930-fast-docs-force-code',
            requestedDepth: 1,
            effectiveDepth: 1,
            taskSummary: 'Force code review for a fast docs-only edit'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, 'T-930-fast-docs-force-code').exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-930-fast-docs-force-code');
        runShellSmokeForTask(repoRoot, 'T-930-fast-docs-force-code');

        const forcedCodeResult = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['docs/usage.md'],
            taskId: 'T-930-fast-docs-force-code',
            taskIntent: 'Force code review for a fast docs-only edit',
            forceCodeReview: true,
            outputPath: path.join(repoRoot, 'preflight-fast-docs-force-code.json'),
            emitMetrics: false
        });

        const forcedCodePayload = JSON.parse(forcedCodeResult.outputText);
        assert.equal(forcedCodePayload.scope_category, 'docs-only');
        assert.equal(forcedCodePayload.required_reviews.code, true);
        assert.equal(
            forcedCodePayload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'profile_forced'
        );
        assert.equal(forcedCodePayload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile does not force DB review without DB surface evidence', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-no-db-surface.json');
        const taskId = 'T-930-strict-no-db-surface';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict reviews domain-aware without forcing DB in a no-database project'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Keep strict reviews domain-aware without forcing DB in a no-database project',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.triggers.db, false);
        assert.deepEqual(payload.triggers.db_project_evidence, []);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.required_reviews.security, true);
        assert.equal(payload.required_reviews.refactor, true);
        assert.equal(payload.required_reviews.db, false);
        assert.equal(payload.required_reviews.api, false);
        assert.equal(payload.required_reviews.performance, false);
        assert.equal(payload.required_reviews.dependency, false);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'api')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'dependency')?.decision,
            'not_applicable_no_domain_surface'
        );
        assert.deepEqual(payload.budget_forecast.required_reviews.includes('db'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile treats pure test-scope diffs as test-review-only', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-test-only.json');
        const taskId = 'T-930-strict-test-only';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict profile test fixture changes on test review only'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['tests/node/cli/commands/gates-review-reuse.test.ts'],
            taskId,
            taskIntent: 'Keep strict profile test fixture changes on test review only',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'test-only');
        assert.equal(payload.profile_selection.effective_profile, 'strict');
        assert.equal(payload.triggers.test, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        for (const reviewType of ['code', 'security', 'refactor']) {
            const decision = payload.profile_guardrails.decisions.find(
                (entry: Record<string, unknown>) => entry.review_type === reviewType
            );
            assert.equal(decision?.decision, 'lightened_by_profile');
            assert.match(String(decision?.reason || ''), /test-only/);
        }
        assert.deepEqual(payload.budget_forecast.required_reviews, ['test']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change ignores generated runtime artifacts for test-only review routing', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-generated-runtime-artifacts.json');
        const taskId = 'T-930-generated-runtime-artifacts';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Ignore generated runtime artifacts during preflight scope classification'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [
                'tests/node/cli/commands/gates-preflight.test.ts',
                'garda-agent-orchestrator/runtime/reports/garda-report.html',
                'garda-agent-orchestrator/runtime/task-events/T-930-generated-runtime-artifacts.jsonl',
                'Z:/missing/root/runtime/task-events/all-tasks.jsonl',
                'mnt/wsl/projects/missing/runtime/task-events/T-930-generated-runtime-artifacts.jsonl'
            ],
            taskId,
            taskIntent: 'Ignore generated runtime artifacts during preflight scope classification',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.deepEqual(payload.changed_files, ['tests/node/cli/commands/gates-preflight.test.ts']);
        assert.equal(payload.scope_category, 'test-only');
        assert.equal(payload.metrics.changed_files_count, 1);
        assert.equal(payload.metrics.ignored_generated_runtime_files_count, 4);
        assert.deepEqual(payload.triggers.ignored_generated_runtime_files, [
            'Z:/missing/root/runtime/task-events/all-tasks.jsonl',
            'garda-agent-orchestrator/runtime/reports/garda-report.html',
            'garda-agent-orchestrator/runtime/task-events/T-930-generated-runtime-artifacts.jsonl',
            'mnt/wsl/projects/missing/runtime/task-events/T-930-generated-runtime-artifacts.jsonl'
        ]);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.test, true);
        assert.deepEqual(payload.budget_forecast.required_reviews, ['test']);
        assert.match(payload.workspace_hygiene_warnings[0], /Ignored 4 generated runtime\/control-plane artifact/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change keeps code-like protected control-plane files in implementation domain fingerprints', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-domain-scope-protected-code.json');
        const taskId = 'T-930-domain-scope-protected-code';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep protected control-plane TypeScript in implementation domain fingerprints'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [
                'src/gates/review-tree-state.ts',
                'garda-agent-orchestrator/live/config/workflow-config.json'
            ],
            taskId,
            taskIntent: 'Keep protected control-plane TypeScript in implementation domain fingerprints',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        const domainFingerprints = payload.metrics.domain_scope_fingerprints;
        assert.deepEqual(domainFingerprints.domains.implementation.changed_files, ['src/gates/review-tree-state.ts']);
        assert.deepEqual(
            domainFingerprints.domains.config.changed_files,
            ['garda-agent-orchestrator/live/config/workflow-config.json']
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile suppresses reviews for audited zero-diff baseline-only closeout', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-zero-diff.json');
        const taskId = 'T-930-strict-zero-diff';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Close out reviewer trust validation with no additional file changes'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Close out reviewer trust validation with no additional file changes',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.metrics.changed_files_count, 0);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.zero_diff_guard.completion_requires_audited_no_op, true);
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.security, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.required_reviews.db, false);
        assert.equal(payload.budget_forecast.required_reviews.length, 0);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'code')?.decision,
            'zero_diff_no_reviewable_scope'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change suppresses intent-only refactor reviews for git-auto zero-diff baseline-only closeout', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-zero-diff-refactor-intent.json');
        const taskId = 'T-930-zero-diff-refactor-intent';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        const taskSummary = 'Finish protected-manifest and completion regression fixture cleanup from checkpoint';
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: taskSummary,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.detection_source, 'git_auto');
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.metrics.changed_files_count, 0);
        assert.equal(payload.triggers.refactor_intent, true);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, true);
        assert.equal(payload.required_reviews.code, false);
        assert.equal(payload.required_reviews.refactor, false);
        assert.equal(payload.budget_forecast.required_reviews.length, 0);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'refactor')?.decision,
            'zero_diff_no_reviewable_scope'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps reviews for zero-diff with planned task scope', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-zero-diff-planned.json');
        const taskId = 'T-930-strict-zero-diff-planned';
        seedStrictProfileConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Plan a source change before implementation',
            plannedChangedFiles: ['src/app.ts']
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Plan a source change before implementation',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, false);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps reviews for explicit empty scoped preflight', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-explicit-empty.json');
        const taskId = 'T-930-strict-explicit-empty';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Attempt an explicit empty scoped preflight'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId,
            taskIntent: 'Attempt an explicit empty scoped preflight',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.detection_source, 'explicit_changed_files');
        assert.equal(payload.scope_category, 'empty');
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.profile_guardrails.zero_diff_no_reviewable_scope, false);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(payload.budget_forecast.required_reviews.includes('code'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps DB review when DB surface evidence is present', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const migrationPath = path.join(repoRoot, 'src', 'db', 'migrations', '001_init.sql');
        fs.mkdirSync(path.dirname(migrationPath), { recursive: true });
        fs.writeFileSync(migrationPath, 'create table users (id text primary key);\n', 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-strict-db-surface.json');
        const taskId = 'T-930-strict-db-surface';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict DB review when database migration scope exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/db/migrations/001_init.sql'],
            taskId,
            taskIntent: 'Keep strict DB review when database migration scope exists',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, true);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'domain_triggered'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile keeps DB review when project DB evidence exists', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({
            dependencies: {
                pg: '^8.0.0'
            }
        }, null, 2), 'utf8');
        const outputPath = path.join(repoRoot, 'preflight-strict-db-project-evidence.json');
        const taskId = 'T-930-strict-db-project-evidence';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Keep strict DB review when project database capability exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Keep strict DB review when project database capability exists',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, false);
        assert.ok(payload.triggers.db_project_evidence.includes('package:pg'));
        assert.equal(payload.required_reviews.db, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'domain_triggered'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change strict profile supports explicit all-domain review override', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-force-domain.json');
        const taskId = 'T-930-strict-force-domain';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Force all strict domain reviews for an audited override'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Force all strict domain reviews for an audited override',
            forceAllDomainReviews: true,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.triggers.db, false);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(payload.required_reviews.api, true);
        assert.equal(payload.required_reviews.performance, true);
        assert.equal(payload.required_reviews.dependency, true);
        assert.equal(payload.required_reviews.infra, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'profile_forced'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'api')?.decision,
            'profile_forced'
        );
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'dependency')?.decision,
            'profile_forced'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('api'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('dependency'), true);
        assert.equal(payload.budget_forecast.required_reviews.includes('infra'), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change public CLI parses explicit all-domain review override', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-strict-force-domain-cli.json');
        const taskId = 'T-930-strict-force-domain-cli';
        seedStrictProfileConfig(repoRoot);
        seedTaskQueue(repoRoot, taskId, 'TODO', 'strict');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Force all strict domain reviews through the public CLI flag'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = await runCliWithCapturedOutput([
            'gate',
            'classify-change',
            '--task-id', taskId,
            '--task-intent', 'Force all strict domain reviews through the public CLI flag',
            '--changed-file', 'src/app.ts',
            '--force-all-domain-reviews',
            '--output-path', outputPath,
            '--repo-root', repoRoot
        ], { cwd: repoRoot });

        assert.equal(result.exitCode, 0);
        assert.deepEqual(result.errors, []);
        assert.equal(fs.existsSync(outputPath), true);
        const payload = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
        assert.equal(payload.triggers.db, false);
        assert.equal(payload.required_reviews.db, true);
        assert.equal(payload.required_reviews.api, true);
        assert.equal(payload.required_reviews.performance, true);
        assert.equal(payload.required_reviews.dependency, true);
        assert.equal(payload.required_reviews.infra, true);
        assert.equal(
            payload.profile_guardrails.decisions.find((decision: Record<string, unknown>) => decision.review_type === 'db')?.decision,
            'profile_forced'
        );
        assert.equal(payload.budget_forecast.required_reviews.includes('db'), true);
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change with task-id auto-materializes the canonical preflight path', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-930-default-preflight-path';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Auto materialize default preflight artifact path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            changedFiles: ['src/app.ts'],
            taskIntent: 'Auto materialize default preflight artifact path',
            emitMetrics: false
        });

        const canonicalPreflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(fs.existsSync(canonicalPreflightPath), true);
        assert.deepEqual(JSON.parse(fs.readFileSync(canonicalPreflightPath, 'utf8')), payload);

        const preflightEvent = [...readTaskTimelineEvents(repoRoot, taskId)]
            .reverse()
            .find((event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        assert.ok(preflightEvent, 'expected PREFLIGHT_CLASSIFIED event');
        assert.equal(
            String((preflightEvent.details as Record<string, unknown>).output_path || ''),
            canonicalPreflightPath.replace(/\\/g, '/')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change uses the explicit custom task-mode artifact path for requested depth and budget forecasting', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-custom-task-mode-depth.json');
        const taskId = 'T-930-custom-task-mode-depth';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 3,
            effectiveDepth: 3,
            taskSummary: 'Preserve requested depth from a custom task-mode artifact path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Preserve requested depth from a custom task-mode artifact path',
            taskModePath: customTaskModePath,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.risk_aware_depth.requested_depth, 3);
        assert.equal(payload.risk_aware_depth.effective_depth, 3);
        assert.equal(payload.risk_aware_depth.escalated, false);
        assert.equal(payload.budget_forecast.requested_depth, 3);
        assert.equal(payload.budget_forecast.effective_depth, 3);
        assert.equal(payload.budget_forecast.depth_escalated, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classify-change accepts a legacy handshake artifact when the corroborating task-mode evidence is on a custom path', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-custom-task-mode-legacy-handshake.json');
        const taskId = 'T-930-custom-task-mode-legacy-handshake';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Honor a custom task-mode path when legacy handshake launchability must be corroborated.',
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
            'Legacy handshake diagnostics recorded for custom task-mode path compatibility coverage.',
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
        runShellSmokeForTask(repoRoot, taskId);

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId,
            taskIntent: 'Honor a custom task-mode path when legacy handshake launchability must be corroborated.',
            taskModePath: customTaskModePath,
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, taskId);
        assert.equal(payload.required_reviews.code, true);
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('classifies explicit changed files and writes preflight artifact', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight.json');
        seedTaskQueue(repoRoot, 'T-900');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900',
            taskSummary: 'Update app flow'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900');
        runShellSmokeForTask(repoRoot, 'T-900');
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
            'utf8'
        );
        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/app.ts'],
            taskId: 'T-900',
            taskIntent: 'Update app flow',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.task_id, 'T-900');
        assert.equal(payload.changed_files[0], 'src/app.ts');
        assert.equal(payload.required_reviews.code, true);
        assert.equal(fs.existsSync(outputPath), true);
        const persistedPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        assert.ok(persistedPayload.optional_skill_selection);
        assert.equal(
            (persistedPayload.optional_skill_selection as Record<string, unknown>).artifact_path,
            path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', 'T-900-optional-skill-selection.json').replace(/\\/g, '/')
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not materialize an optional-skill artifact when policy mode is off', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-off.json');
        seedTaskQueue(repoRoot, 'T-900-off');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900-off',
            taskSummary: 'Update app flow'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900-off');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900-off');
        runShellSmokeForTask(repoRoot, 'T-900-off');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'off');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: ['src/api/orders.ts'],
            taskId: 'T-900-off',
            taskIntent: 'Implement request validation for a Node.js API endpoint.',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText) as Record<string, unknown>;
        const persistedPayload = JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = persistedPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal((payload.optional_skill_selection as Record<string, unknown>).policy_mode, 'off');
        assert.equal(optionalSkillSelection.policy_mode, 'off');
        assert.equal(optionalSkillSelection.artifact_path, null);
        assert.equal(optionalSkillSelection.decision, null);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), 'T-900-off-optional-skill-selection.json')),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('marks zero-diff preflight as baseline-only instead of complete work', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight-zero.json');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, 'T-900z');
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId: 'T-900z',
            taskSummary: 'Implement lifecycle hardening'
        });
        const rulePackResult = loadTaskEntryRulePack(repoRoot, 'T-900z');
        assert.equal(rulePackResult.exitCode, 0);
        runHandshakeForTask(repoRoot, 'T-900z');
        runShellSmokeForTask(repoRoot, 'T-900z');

        const result = runClassifyChangeCommand({
            repoRoot,
            changedFiles: [],
            taskId: 'T-900z',
            taskIntent: 'Implement lifecycle hardening',
            outputPath,
            emitMetrics: false
        });

        const payload = JSON.parse(result.outputText);
        assert.equal(payload.changed_files.length, 0);
        assert.equal(payload.zero_diff_guard.zero_diff_detected, true);
        assert.equal(payload.zero_diff_guard.status, 'BASELINE_ONLY');
        assert.equal(payload.zero_diff_guard.completion_requires_audited_no_op, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rule-pack when the current preflight has not completed classify-change sequencing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-order';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject POST_PREFLIGHT load-rule-pack before classify-change completes'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const result = loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'preflight-to-post-preflight-rules',
            status: 'block',
            reason: 'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT',
            remediation: 'node bin/garda.js gate classify-change --task-id'
        });
        assert.equal(artifact.stages.post_preflight.status, 'FAILED');
        assert.equal(artifact.stages.post_preflight.preflight_event_sequence, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

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

    it('rejects shell-smoke-preflight when runtime identity would fall back to canonical SourceOfTruth', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-shell-smoke-legacy-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runShellSmokePreflightCommand({
            repoRoot,
            taskId
        }));

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' before shell-smoke-preflight/i);
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

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' before shell-smoke-preflight/i);
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

    it('rejects command-timeout-diagnostics when runtime identity would fall back to canonical SourceOfTruth', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-command-timeout-legacy-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        const error = captureExpectedError(() => runCommandTimeoutDiagnosticsCommand({
            repoRoot,
            taskId
        }));

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' before command-timeout-diagnostics/i);
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

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' before command-timeout-diagnostics/i);
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

    it('fails compile gate with gate-chain remediation when POST_PREFLIGHT rule-pack evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-missing-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-missing.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface compile remediation when POST_PREFLIGHT rule-pack is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Surface compile remediation when POST_PREFLIGHT rule-pack is missing',
            ['src/app.ts']
        );

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'post-preflight-rules-to-compile',
            status: 'block',
            reason: 'missing POST_PREFLIGHT RULE_PACK_LOADED evidence',
            remediation: 'node bin/garda.js gate load-rule-pack --task-id'
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit sequencing remediation when POST_PREFLIGHT rule-pack already failed for the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-failed-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-failed.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Surface compile remediation after failed POST_PREFLIGHT sequencing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, false).exitCode, EXIT_GATE_FAILURE);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assertGateChainDecision(result.outputLines, {
            edgeId: 'preflight-to-post-preflight-rules',
            status: 'block',
            reason: 'Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT',
            remediation: 'node bin/garda.js gate classify-change --task-id'
        });

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects POST_PREFLIGHT rule-pack when a newer preflight already superseded the requested preflight artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-stale-preflight';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const stalePreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load',
            ['src/app.ts'],
            `${taskId}-stale-preflight.json`
        );
        const latestPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale preflight artifacts during POST_PREFLIGHT rule-pack load',
            ['src/app.ts']
        );

        const result = loadPostPreflightRulePack(repoRoot, taskId, stalePreflightPath);

        assert.equal(latestPreflightPath.endsWith(`${taskId}-preflight.json`), true);
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('not the latest PREFLIGHT_CLASSIFIED evidence')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps custom task-mode paths in POST_PREFLIGHT remediation commands', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-remediation-custom-task-mode';
        const customTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
        const preflightPath = writePreflight(repoRoot, taskId);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve custom task-mode path in POST_PREFLIGHT remediation',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);

        const result = runLoadRulePackCommand({
            repoRoot,
            taskId,
            stage: 'POST_PREFLIGHT',
            preflightPath,
            taskModePath: customTaskModePath,
            loadedRuleFiles: ['00-core.md'],
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOAD_FAILED');
        const outputText = result.outputLines.join('\n');
        assert.ok(outputText.includes('Remediation:'), outputText);
        assert.ok(outputText.includes('--task-mode-path'), outputText);
        assert.ok(outputText.includes(customTaskModePath), outputText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('skips selection of skills with missing SKILL.md during classify-change in required mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-cleanup';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail classify-change when optional skill selection points at a missing skill file'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'required' }, null, 2),
            'utf8'
        );

        const brokenSkillRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'broken-skill');
        fs.mkdirSync(brokenSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(brokenSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'broken-skill',
                pack: 'broken-pack',
                name: 'Broken Skill',
                summary: 'Broken skill fixture.',
                tags: ['broken', 'api'],
                aliases: ['broken'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement broken-skill API validation.',
            changedFiles: ['src/app.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        // Skill without SKILL.md is silently excluded; preflight succeeds with as_is.
        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        assert.equal(fs.existsSync(preflightPath), true);
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.policy_mode, 'required');
        assert.equal(optionalSkillSelection.decision, 'as_is');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('keeps classify-change non-blocking in advisory mode when skill has no SKILL.md', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-advisory';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Keep advisory optional skill selection non-blocking during classify-change'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        fs.mkdirSync(path.join(getOrchestratorRoot(repoRoot), 'live', 'config'), { recursive: true });
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'garda.config.json'),
            JSON.stringify({ version: 1, configs: { 'optional-skill-selection-policy': 'optional-skill-selection-policy.json' } }, null, 2),
            'utf8'
        );
        fs.writeFileSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            JSON.stringify({ version: 1, mode: 'advisory' }, null, 2),
            'utf8'
        );

        const brokenSkillRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'skills', 'broken-skill');
        fs.mkdirSync(brokenSkillRoot, { recursive: true });
        fs.writeFileSync(
            path.join(brokenSkillRoot, 'skill.json'),
            JSON.stringify({
                id: 'broken-skill',
                pack: 'broken-pack',
                name: 'Broken Skill',
                summary: 'Broken skill fixture.',
                tags: ['broken', 'api'],
                aliases: ['broken'],
                task_signals: ['broken-skill'],
                changed_path_signals: ['src/app.ts'],
                references: [],
                cost_hint: 'low',
                priority: 50,
                autoload: 'suggest'
            }, null, 2),
            'utf8'
        );

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            taskIntent: 'Implement broken-skill API validation.',
            changedFiles: ['src/app.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        // Skill without SKILL.md is silently excluded; classify-change succeeds with as_is.
        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        assert.equal(fs.existsSync(preflightPath), true);
        const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const optionalSkillSelection = preflightPayload.optional_skill_selection as Record<string, unknown>;
        assert.equal(optionalSkillSelection.policy_mode, 'advisory');
        assert.equal(optionalSkillSelection.decision, 'as_is');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('binds optional-skill artifacts to the canonical TASK.md title when classify-change runs without task-intent', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-158-preflight-task-title-fallback';
        const taskTitle = 'Implement request validation for a Node.js API endpoint';
        const staleTaskModeSummary = 'Stale task-mode summary that should not override TASK.md';
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        fs.writeFileSync(
            path.join(repoRoot, 'TASK.md'),
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                `| ${taskId} | TODO | P1 | api | ${taskTitle} | unassigned | 2026-04-20 | default | fixture |`
            ].join('\n'),
            'utf8'
        );
        seedInitAnswers(repoRoot);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'advisory');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: staleTaskModeSummary
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
        const result = runClassifyChangeCommand({
            repoRoot,
            taskId,
            changedFiles: ['src/api/orders.ts'],
            outputPath: preflightPath,
            emitMetrics: false
        });

        assert.match(result.outputText, /"mode": "FULL_PATH"/);
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        const optionalSkillArtifact = JSON.parse(fs.readFileSync(optionalSkillArtifactPath, 'utf8')) as Record<string, unknown>;
        assert.equal(optionalSkillArtifact.task_text_present, true);
        assert.equal(optionalSkillArtifact.task_text_sha256, computeTaskTextSha256(taskTitle));
        assert.equal(optionalSkillArtifact.visible_summary_line, 'Optional skills: node-backend (reason: task_text+paths)');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails classify-change when garda.config.json maps a missing optional-skill-selection policy file', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-preflight-missing-policy';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail classify-change when mapped optional skill policy config is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        seedNodeBackendOptionalSkillFixture(repoRoot, 'required');
        fs.rmSync(
            path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'optional-skill-selection-policy.json'),
            { force: true }
        );

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                taskId,
                taskIntent: 'Fail classify-change when mapped optional skill policy config is missing.',
                changedFiles: ['src/api/orders.ts'],
                outputPath: path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`),
                emitMetrics: false
            }),
            /Managed optional skill selection policy config is missing/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('blocks compile-gate before implementation starts when required optional-skill evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-compile-required-optional-skill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'required');

        const commandsPath = path.join(repoRoot, 'commands-optional-skill-required.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block implementation start when required optional-skill evidence is missing'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Block implementation start when required optional-skill evidence is missing',
            ['src/api/orders.ts']
        );
        const optionalSkillArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-optional-skill-selection.json`);
        assert.equal(fs.existsSync(optionalSkillArtifactPath), true);
        fs.rmSync(optionalSkillArtifactPath, { force: true });
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Optional skill selection artifact is missing for current task cycle')));
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'IMPLEMENTATION_STARTED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
