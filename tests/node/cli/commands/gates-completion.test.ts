import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { syncTaskQueueStatus } from '../../../../src/cli/commands/gate-flows/task-queue-sync';
import { handleCompletionGate } from '../../../../src/cli/commands/gate-task-handlers';
import {
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import {
    runCliMain,
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { runCompletionGate } from '../../../../src/gates/completion';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../src/gates/review-reuse';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt
} from '../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import * as childProcess from 'node:child_process';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createReviewerRoutingFixture(
    sourceOfTruth: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const conditionalFallbackProvider = normalizedSourceOfTruth === 'Antigravity';
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: 'provider_entrypoint',
        identity_status: 'resolved',
        capability_level: conditionalFallbackProvider ? 'delegation_conditional' : 'delegation_capable',
        expected_execution_mode: conditionalFallbackProvider ? 'delegated_subagent' : 'delegated_subagent',
        fallback_allowed: conditionalFallbackProvider,
        fallback_reason_required: conditionalFallbackProvider,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
}

async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
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
    return runEnterTaskModeCommand(withDefaultTaskModeRouting(options));
}

function seedRuleFiles(repoRoot: string): void {
    const rulesRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules');
    fs.mkdirSync(rulesRoot, { recursive: true });
    const ruleFiles = [
        '00-core.md',
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
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const changedLinesTotal = Number.parseInt(String((preflight.metrics as Record<string, unknown> | undefined)?.changed_lines_total || 0), 10) || 0;
    const detectionSource = String(preflight.detection_source || 'explicit_changed_files').trim() || 'explicit_changed_files';
    const includeUntracked = preflight.include_untracked !== false;
    const changedFilesSha256 = crypto.createHash('sha256').update(changedFiles.join('\n')).digest('hex');
    const scopeSha256 = crypto.createHash('sha256')
        .update(`${detectionSource}|false|${includeUntracked}|${changedFiles.length}|${changedLinesTotal}|${changedFilesSha256}`)
        .digest('hex');
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
        scope_changed_files: changedFiles,
        scope_changed_files_count: changedFiles.length,
        scope_changed_lines_total: changedLinesTotal,
        scope_changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256
    }, null, 2), 'utf8');
    appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPILE_GATE_PASSED', 'PASS', 'Compile gate passed.', {
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: preflightHashSha256
    });
}

function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[]
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const content = (contentLines || [
        '# Review',
        '',
        `Verified changes in \`src/app.ts\`. This review artifact content has been extended with more words to ensure it strictly passes the newly introduced triviality check, which demands at least thirty words if there are no meaningful findings or risks.`,
        '',
        verdict,
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        verdict
    ]).join('\n');
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    fs.writeFileSync(artifactPath, content, 'utf8');
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-review-context.json`);
    const reviewContext = {
        review_type: reviewKey,
        reviewer_routing: createReviewerRoutingFixture('Codex', {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer'
        })
    };
    const reviewContextText = JSON.stringify(reviewContext, null, 2);
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');

    // Authenticity hardening: write a verifiable receipt.
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify({
        schema_version: 2,
        task_id: taskId,
        review_type: reviewKey,
        review_artifact_sha256: artifactHash,
        review_context_sha256: reviewContextHash,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: 'agent:test-reviewer'
    }));

    // Emit mandatory telemetry for authenticity
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    if (fs.existsSync(path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`))) {
        const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
            review_type: reviewKey
        });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
            review_type: reviewKey,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', { review_type: reviewKey });
    }
}

function writeCleanReviewArtifact(repoRoot: string, taskId: string, reviewKey: string, verdict: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, reviewKey, verdict);
}

function seedReusableReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    preflightPath: string,
    reviewContextPath: string,
    reviewerIdentity = 'agent:test-reviewer',
    options: {
        legacyReviewContextIdentity?: boolean;
        legacyReviewContextSourceOfTruth?: string;
        taskModePath?: string | null;
    } = {}
): string {
    const crypto = require('node:crypto');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewKey}.md`);
    const scopedDiffMetadataPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`);
    const artifactText = [
        '# Review',
        '',
        `Validated \`${reviewKey === 'code' ? 'src/app.ts' : 'tests/app.test.ts'}\` and the reuse contract in detail so this artifact remains realistic and non-trivial while reporting no findings for the current scope.`,
        '',
        '## Findings by Severity',
        'none',
        '',
        '## Residual Risks',
        'none',
        '',
        '## Verdict',
        verdict
    ].join('\n');
    buildReviewContext({
        reviewType: reviewKey,
        depth: 2,
        preflightPath,
        taskModePath: options.taskModePath || '',
        tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath,
        outputPath: reviewContextPath,
        repoRoot
    });
    applyReviewerRoutingMetadata(reviewContextPath, {
        actualExecutionMode: 'delegated_subagent',
        reviewerSessionId: reviewerIdentity,
        fallbackReason: null
    });
    if (options.legacyReviewContextIdentity) {
        const legacyReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = legacyReviewContext.reviewer_routing
            && typeof legacyReviewContext.reviewer_routing === 'object'
            && !Array.isArray(legacyReviewContext.reviewer_routing)
            ? legacyReviewContext.reviewer_routing as Record<string, unknown>
            : {};
        if (options.legacyReviewContextSourceOfTruth) {
            reviewerRouting.source_of_truth = options.legacyReviewContextSourceOfTruth;
        }
        delete reviewerRouting.canonical_source_of_truth;
        delete reviewerRouting.execution_provider;
        delete reviewerRouting.execution_provider_source;
        delete reviewerRouting.identity_status;
        legacyReviewContext.reviewer_routing = reviewerRouting;
        fs.writeFileSync(reviewContextPath, JSON.stringify(legacyReviewContext, null, 2) + '\n', 'utf8');
    }
    const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
        codeScopeSha256: reviewKey === 'code'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: reviewContextHash,
        reviewContextReuseSha256: computeReviewContextReuseHash(JSON.parse(reviewContextText) as Record<string, unknown>),
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'LOCAL_AUDITED'
    });
    fs.writeFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    return reviewContextPath;
}

function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i;
    const taskPath = path.join(repoRoot, 'TASK.md');
    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed.split('|').map((cell) => cell.trim()).filter(Boolean);
        if (cells.length < 2 || cells[0] !== taskId) {
            continue;
        }
        const statusMatch = statusPattern.exec(cells[1]);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }
    return null;
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
    it('completion-gate updates the TASK.md row to DONE through the CLI handler', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-sync';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-sync.md');
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
            taskSummary: 'Sync TASK.md status to DONE from completion-gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟧 IN_REVIEW\s*\|/);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion status sync regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'completion-gate',
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903-completion-status-sync\s*\|\s*🟩 DONE\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rerun repairs missing STATUS_CHANGED finalization without duplicating completion pass evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-event-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-event-repair.md');
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
            taskSummary: 'Repair missing STATUS_CHANGED finalization on completion rerun'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion finalization repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[2] || '') === 'STATUS_CHANGED') {
                throw new Error('Injected STATUS_CHANGED append failure');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory STATUS_CHANGED append failed/i);
            assert.match(error.message, /gate completion-gate/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before finalization reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must not be recorded when STATUS_CHANGED append failed'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rerun repairs missing TASK.md DONE sync without duplicating STATUS_CHANGED telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-repair';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-repair.md');
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
            taskSummary: 'Repair missing TASK.md DONE sync on completion rerun'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion task queue repair regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
            '| --- | --- | --- | --- | --- | --- | --- | --- | --- |'
        ].join('\n'), 'utf8');

        const error = await captureExpectedAsyncError(async () => {
            await handleCompletionGate([
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
        });
        assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        assert.match(error.message, /gate completion-gate/i);

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded before TASK.md queue reconciliation succeeds'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'STATUS_CHANGED to DONE must not be recorded before TASK.md queue reconciliation succeeds'
        );

        seedTaskQueue(repoRoot, taskId, '🟧 IN_REVIEW');
        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1,
            'repair rerun must reuse the existing DONE status transition instead of appending a duplicate'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate restores the TASK.md snapshot after a partial write failure during DONE sync', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-task-queue-write-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-task-queue-write-rollback.md');
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
            taskSummary: 'Restore TASK.md snapshot after a partial queue write failure'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion TASK.md write rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskPath = path.join(repoRoot, 'TASK.md');
        const baselineTaskContent = fs.readFileSync(taskPath, 'utf8');
        const fsModule = require('node:fs') as {
            writeFileSync: typeof fs.writeFileSync;
        };
        const originalWriteFileSync = fsModule.writeFileSync;
        let injectedWriteFailureConsumed = false;
        fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | NodeJS.ArrayBufferView, options?: fs.WriteFileOptions) => {
            if (
                !injectedWriteFailureConsumed
                && typeof filePath === 'string'
                && path.resolve(filePath) === path.resolve(taskPath)
            ) {
                injectedWriteFailureConsumed = true;
                originalWriteFileSync(filePath, '| corrupted |\n', options);
                throw new Error('Injected TASK.md write failure');
            }
            return originalWriteFileSync(filePath, data as never, options);
        }) as typeof fs.writeFileSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /TASK\.md queue state could not be reconciled to DONE/i);
        } finally {
            fsModule.writeFileSync = originalWriteFileSync;
        }

        assert.equal(
            fs.readFileSync(taskPath, 'utf8'),
            baselineTaskContent,
            'TASK.md must be restored to its pre-finalization snapshot after a partial write failure'
        );

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rolls back queue and status telemetry when COMPLETION_GATE_PASSED append fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-rollback.md');
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
            taskSummary: 'Roll back queue and status telemetry when completion pass append fails'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion pass rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                throw new Error('Injected COMPLETION_GATE_PASSED append failure');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /gate completion-gate/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be recorded when completion event append fails'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must not remain durable when completion append fails'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        const latestRepairedStatusTransition = [...repairedEvents]
            .reverse()
            .find((event) => event.event_type === 'STATUS_CHANGED');
        assert.equal(
            String((latestRepairedStatusTransition?.details as Record<string, unknown> | undefined)?.new_status || '').toUpperCase(),
            'DONE'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rollback preserves foreign aggregate and summary updates appended after the current task write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-cross-task-rollback';
        const foreignTaskId = 'T-903-foreign-summary-preserved';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-cross-task-rollback.md');
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
            taskSummary: 'Preserve foreign aggregate and summary updates during completion rollback'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Cross-task completion rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    foreignTaskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Foreign task event during completion rollback regression fixture.',
                    {
                        task_summary: 'Foreign task event must survive rollback'
                    }
                );
                throw new Error('Injected post-append failure after foreign task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected post-append failure after foreign task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'current task completion pass must be removed during rollback'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'current task DONE status transition must be removed during rollback'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        const foreignTaskEvents = readTaskTimelineEvents(repoRoot, foreignTaskId);
        assert.equal(
            foreignTaskEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            1,
            'foreign task timeline event must survive current-task rollback'
        );

        const aggregateLines = fs.readFileSync(aggregatePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
            aggregateLines.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            0,
            'current task completion aggregate entry must be removed during rollback'
        );
        assert.equal(
            aggregateLines.filter((entry) => (
                String(entry.task_id || '').trim() === foreignTaskId
                && String(entry.event_type || '').trim() === 'PLAN_CREATED'
            )).length,
            1,
            'foreign aggregate entry must survive current-task rollback'
        );

        const timelineSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            entries?: Record<string, { events_found?: string[]; integrity_event_count?: number }>;
        };
        assert.equal(
            Array.isArray(timelineSummaryIndex.entries?.[taskId]?.events_found)
                ? timelineSummaryIndex.entries?.[taskId]?.events_found?.includes('COMPLETION_GATE_PASSED')
                : false,
            false,
            'current task timeline summary must be reconciled back to the pre-completion state'
        );
        assert.ok(timelineSummaryIndex.entries?.[foreignTaskId], 'foreign task timeline summary entry must survive current-task rollback');
        assert.equal(
            Number(timelineSummaryIndex.entries?.[foreignTaskId]?.integrity_event_count || 0) >= 1,
            true,
            'foreign task timeline summary entry must retain the recorded foreign event state'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate refuses destructive rollback when a same-task event lands after the partial finalization write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before destructive completion rollback'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Same-task concurrent rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended after partial completion write.',
                    {
                        task_summary: 'Same-task concurrency guard fixture'
                    }
                );
                throw new Error('Injected post-append failure after same-task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task guard must not erase the concurrently appended task event'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate refuses destructive rollback when a same-task unsequenced line lands after the partial finalization write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-unsequenced-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-unsequenced-same-task-guard.md');
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
            taskSummary: 'Detect same-task unsequenced append before destructive completion rollback'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Same-task unsequenced rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskTimelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(taskTimelinePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    details: {
                        task_summary: 'Same-task unsequenced concurrency guard fixture'
                    },
                    marker: 'NO_SEQUENCE'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after same-task unsequenced event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task unsequenced event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        assert.equal(
            fs.readFileSync(taskTimelinePath, 'utf8').includes('"marker":"NO_SEQUENCE"'),
            true,
            'same-task rollback guard must not erase the concurrently appended unsequenced timeline line'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate refuses destructive rollback when a same-task event lands after a partial STATUS_CHANGED write', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before destructive rollback after STATUS_CHANGED'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Same-task concurrent STATUS_CHANGED rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'STATUS_CHANGED') {
                const result = await originalAppendTaskEventAsync(...args);
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended after partial STATUS_CHANGED write.',
                    {
                        task_summary: 'Same-task STATUS_CHANGED concurrency guard fixture'
                    }
                );
                throw new Error('Injected post-append failure after same-task STATUS_CHANGED event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected post-append failure after same-task STATUS_CHANGED event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task STATUS_CHANGED guard must not erase the concurrently appended task event'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must not be appended when STATUS_CHANGED finalization already failed'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate refuses destructive rollback when a foreign STATUS_CHANGED event matches the allowed type', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-status-same-type-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-status-same-type-guard.md');
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
            taskSummary: 'Detect foreign STATUS_CHANGED event even when the event type matches the allowed rollback tail'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Foreign STATUS_CHANGED same-type rollback guard regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'STATUS_CHANGED') {
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'STATUS_CHANGED',
                    'INFO',
                    'Task status changed: IN_REVIEW → BLOCKED.',
                    {
                        previous_status: 'IN_REVIEW',
                        new_status: 'BLOCKED'
                    }
                );
                throw new Error('Injected failure before STATUS_CHANGED append after foreign same-type event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected failure before STATUS_CHANGED append after foreign same-type event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'BLOCKED'
            )).length,
            1,
            'foreign STATUS_CHANGED event must survive when its details do not match the expected finalization transition'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate refuses destructive rollback when a same-task event lands before COMPLETION_GATE_PASSED writes anything', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pre-pass-same-task-guard';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pre-pass-same-task-guard.md');
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
            taskSummary: 'Detect same-task concurrent append before COMPLETION_GATE_PASSED writes'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Same-task concurrent append before completion pass write regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const baselinePlanCreatedCount = readTaskTimelineEvents(repoRoot, taskId)
            .filter((event) => event.event_type === 'PLAN_CREATED').length;
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                appendTaskEvent(
                    getOrchestratorRoot(repoRoot),
                    taskId,
                    'PLAN_CREATED',
                    'INFO',
                    'Same-task event appended before COMPLETION_GATE_PASSED could write.',
                    {
                        task_summary: 'Same-task pre-pass concurrency guard fixture'
                    }
                );
                throw new Error('Injected failure before COMPLETION_GATE_PASSED append after same-task event');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /same-task concurrent append detected before rollback/i);
            assert.match(error.message, /Injected failure before COMPLETION_GATE_PASSED append after same-task event/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'PLAN_CREATED').length,
            baselinePlanCreatedCount + 1,
            'same-task pre-pass guard must not erase the concurrently appended task event'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must remain absent when the failure happened before the append'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rollback preserves foreign summary entries when the existing summary index is version-skewed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-version-skew-summary-rollback';
        const foreignTaskId = 'T-903-version-skew-summary-foreign';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-version-skew-summary-rollback.md');
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
            taskSummary: 'Preserve foreign summary entries when rollback sees a version-skewed summary index'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Version-skewed summary rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const currentSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            entries: Record<string, unknown>;
            updated_at_utc: string;
        };
        const currentTaskSummaryEntry = currentSummaryIndex.entries[taskId] as Record<string, unknown> | undefined;
        assert.ok(currentTaskSummaryEntry, 'current task summary entry must exist before synthesizing a version-skewed foreign entry');
        fs.writeFileSync(timelineSummaryPath, JSON.stringify({
            version: 1,
            updated_at_utc: currentSummaryIndex.updated_at_utc,
            entries: {
                ...currentSummaryIndex.entries,
                [foreignTaskId]: {
                    ...currentTaskSummaryEntry,
                    task_id: foreignTaskId
                }
            }
        }, null, 2) + '\n', 'utf8');

        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure on version-skewed summary rollback fixture');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected post-append failure on version-skewed summary rollback fixture/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const restoredSummaryIndex = JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
            version: number;
            entries?: Record<string, { task_id?: string }>;
        };
        assert.equal(restoredSummaryIndex.version, 2, 'rollback reconcile should normalize the summary index back to the canonical version');
        assert.ok(restoredSummaryIndex.entries?.[foreignTaskId], 'foreign summary entry must survive rollback on a version-skewed index');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate aggregate rollback keeps the original aggregate log intact when the rollback temp write fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-rollback-temp-write-failure';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-rollback-temp-write-failure.md');
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
            taskSummary: 'Keep aggregate log intact when rollback temp write fails'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Aggregate rollback temp-write failure regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const baselineAggregateContent = fs.readFileSync(aggregatePath, 'utf8');
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        const originalWriteFileSync = fsModule.writeFileSync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure before aggregate rollback temp-write failure');
            }
            return originalAppendTaskEventAsync(...args);
        };
        fsModule.writeFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
            const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
            if (normalizedPath.startsWith(path.resolve(aggregatePath) + '.') && normalizedPath.endsWith('.tmp')) {
                throw new Error('Injected aggregate rollback temp write failure');
            }
            return originalWriteFileSync(filePath, data, options);
        }) as typeof fsModule.writeFileSync;

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected aggregate rollback temp write failure/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
            fsModule.writeFileSync = originalWriteFileSync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.startsWith(baselineAggregateContent),
            true,
            'aggregate rollback temp write failure must not corrupt or replace the original aggregate log content'
        );
        assert.equal(
            aggregateContentAfterFailure.includes('"event_type":"COMPLETION_GATE_PASSED"'),
            true,
            'aggregate log must retain the pre-rollback partial completion entry when the rollback temp write fails'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rollback drops current-task aggregate rows that are missing integrity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-missing-integrity-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-missing-integrity-rollback.md');
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
            taskSummary: 'Drop current-task aggregate rows that are missing integrity metadata during rollback'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Aggregate missing-integrity rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(aggregatePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    corrupt_marker: 'NO_INTEGRITY'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after adding a current-task aggregate row without integrity');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /without integrity/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.includes('"corrupt_marker":"NO_INTEGRITY"'),
            false,
            'rollback must prune current-task aggregate rows that cannot be trusted because integrity metadata is missing'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rollback preserves baseline aggregate rows that already lack integrity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-aggregate-baseline-missing-integrity-preserved';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-aggregate-baseline-missing-integrity-preserved.md');
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
            taskSummary: 'Preserve baseline aggregate rows without integrity metadata during rollback'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Baseline aggregate missing-integrity preservation regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.appendFileSync(aggregatePath, `${JSON.stringify({
            task_id: taskId,
            event_type: 'PLAN_CREATED',
            legacy_marker: 'BASELINE_NO_INTEGRITY'
        })}\n`, 'utf8');
        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                fs.appendFileSync(aggregatePath, `${JSON.stringify({
                    task_id: taskId,
                    event_type: 'PLAN_CREATED',
                    corrupt_marker: 'NO_INTEGRITY'
                })}\n`, 'utf8');
                throw new Error('Injected post-append failure after adding a current-task aggregate row without integrity');
            }
            return originalAppendTaskEventAsync(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /without integrity/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
        }

        const aggregateContentAfterFailure = fs.readFileSync(aggregatePath, 'utf8');
        assert.equal(
            aggregateContentAfterFailure.includes('"legacy_marker":"BASELINE_NO_INTEGRITY"'),
            true,
            'rollback must preserve baseline aggregate rows that already lacked integrity metadata before finalization'
        );
        assert.equal(
            aggregateContentAfterFailure.includes('"corrupt_marker":"NO_INTEGRITY"'),
            false,
            'rollback must still prune the newly appended current-task aggregate row without integrity metadata'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate does not duplicate DONE status when the existing current-cycle STATUS_CHANGED event is missing sequence metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-missing-sequence-status-dedup';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-missing-sequence-status-dedup.md');
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
            taskSummary: 'Avoid duplicate DONE status writes when STATUS_CHANGED sequence metadata is missing'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Missing-sequence STATUS_CHANGED dedup regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        syncTaskQueueStatus(repoRoot, taskId, 'DONE');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'STATUS_CHANGED',
            'INFO',
            'Task status changed: IN_REVIEW → DONE.',
            {
                previous_status: 'IN_REVIEW',
                new_status: 'DONE'
            }
        );

        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .map((line) => JSON.parse(line) as Record<string, unknown>);
        const doneStatusIndex = [...timelineLines]
            .reverse()
            .findIndex((entry) => (
                String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            ));
        assert.notEqual(doneStatusIndex, -1, 'fixture must contain a current-cycle DONE status event before sequence stripping');
        const actualDoneStatusIndex = timelineLines.length - 1 - doneStatusIndex;
        delete timelineLines[actualDoneStatusIndex].sequence;
        fs.writeFileSync(timelinePath, `${timelineLines.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            1,
            'missing sequence metadata on the existing DONE transition must not trigger a duplicate STATUS_CHANGED append'
        );
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            1,
            'completion finalization must still record the missing completion pass evidence'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate restores TASK.md when timeline rollback succeeded but summary reconciliation fails afterwards', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-summary-rollback-failure';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-summary-rollback-failure.md');
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
            taskSummary: 'Restore TASK.md after rollback summary reconciliation failure'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Rollback summary reconcile failure regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskEventsIoModule = require('../../../../src/gate-runtime/task-events-io') as {
            appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const timelineSummaryModule = require('../../../../src/gate-runtime/timeline-summary') as {
            reconcileTimelineSummaryForTask: (...args: unknown[]) => void;
        };
        const originalAppendTaskEventAsync = taskEventsIoModule.appendTaskEventAsync;
        const originalReconcileTimelineSummaryForTask = timelineSummaryModule.reconcileTimelineSummaryForTask;
        taskEventsIoModule.appendTaskEventAsync = async (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId && String(args[2] || '') === 'COMPLETION_GATE_PASSED') {
                const result = await originalAppendTaskEventAsync(...args);
                throw new Error('Injected post-append failure before summary reconcile');
            }
            return originalAppendTaskEventAsync(...args);
        };
        timelineSummaryModule.reconcileTimelineSummaryForTask = (...args: unknown[]) => {
            if (String(args[1] || '').trim() === taskId) {
                throw new Error('Injected timeline summary reconcile failure');
            }
            return originalReconcileTimelineSummaryForTask(...args);
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /Injected timeline summary reconcile failure/i);
        } finally {
            taskEventsIoModule.appendTaskEventAsync = originalAppendTaskEventAsync;
            timelineSummaryModule.reconcileTimelineSummaryForTask = originalReconcileTimelineSummaryForTask;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            0,
            'completion pass must still be removed when the task timeline rollback succeeded'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            0,
            'DONE status transition must still be removed when the task timeline rollback succeeded'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate restores snapshots when COMPLETION_GATE_PASSED appends with warnings after TASK.md is already DONE', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-pass-warning-rollback';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-pass-warning-rollback.md');
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
            taskSummary: 'Restore snapshots when completion pass append reports warnings after write'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion pass warning rollback regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        syncTaskQueueStatus(repoRoot, taskId, 'DONE');
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'STATUS_CHANGED',
            'INFO',
            'Task status changed: IN_REVIEW → DONE.',
            {
                previous_status: 'IN_REVIEW',
                new_status: 'DONE'
            }
        );

        const baselineEvents = readTaskTimelineEvents(repoRoot, taskId);
        const baselineCompletionCount = baselineEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length;
        const baselineDoneStatusCount = baselineEvents.filter((event) => (
            event.event_type === 'STATUS_CHANGED'
            && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
            && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
        )).length;

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        const timelineSummaryPath = path.join(taskEventsRoot, '.timeline-summary.json');
        const baselineAggregateContent = fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isFile()
            ? fs.readFileSync(aggregatePath, 'utf8')
            : null;
        const baselineAggregateEntries = baselineAggregateContent === null
            ? []
            : baselineAggregateContent
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as Record<string, unknown>);
        const baselineTimelineSummaryContent = fs.existsSync(timelineSummaryPath) && fs.statSync(timelineSummaryPath).isFile()
            ? fs.readFileSync(timelineSummaryPath, 'utf8')
            : null;
        const fsModule = require('node:fs') as typeof import('node:fs');
        const originalAppendFileSync = fsModule.appendFileSync;
        let injectedAggregateFailure = false;

        try {
            fsModule.appendFileSync = ((filePath: fs.PathOrFileDescriptor, data: string | Uint8Array, options?: fs.WriteFileOptions) => {
                const normalizedPath = typeof filePath === 'string' ? path.resolve(filePath) : '';
                const payload = typeof data === 'string' ? data : '';
                if (
                    !injectedAggregateFailure
                    && normalizedPath === path.resolve(aggregatePath)
                    && payload.includes('"event_type":"COMPLETION_GATE_PASSED"')
                ) {
                    injectedAggregateFailure = true;
                    throw new Error('Injected aggregate append failure');
                }
                return originalAppendFileSync(filePath, data, options);
            }) as typeof fsModule.appendFileSync;

            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /mandatory COMPLETION_GATE_PASSED append failed/i);
            assert.match(error.message, /aggregate append\/prune failed/i);
            assert.equal(injectedAggregateFailure, true, 'aggregate append failure must be injected during the warning rollback scenario');
        } finally {
            fsModule.appendFileSync = originalAppendFileSync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            baselineCompletionCount,
            'warning-backed partial completion append must be rolled back from the task timeline'
        );
        assert.equal(
            failedAttemptEvents.filter((event) => (
                event.event_type === 'STATUS_CHANGED'
                && typeof (event.details as Record<string, unknown> | undefined)?.new_status === 'string'
                && String((event.details as Record<string, unknown>).new_status).toUpperCase() === 'DONE'
            )).length,
            baselineDoneStatusCount,
            'warning-backed completion failure must restore the original DONE status timeline snapshot'
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        const aggregateRestoredAsFile = fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isFile();
        assert.equal(aggregateRestoredAsFile, baselineAggregateContent !== null);
        const restoredAggregateEntries = baselineAggregateContent === null
            ? []
            : fs.readFileSync(aggregatePath, 'utf8')
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as Record<string, unknown>);
        assert.equal(
            restoredAggregateEntries.length,
            baselineAggregateEntries.length + 1,
            'warning-backed completion failure must append a single COMPLETION_GATE_FAILED audit marker'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            baselineAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
            )).length,
            'warning-backed completion failure must not leave a partial completion aggregate entry behind'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            )).length,
            baselineAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'STATUS_CHANGED'
                && typeof entry.details === 'object'
                && !Array.isArray(entry.details)
                && String(((entry.details as Record<string, unknown>).new_status) || '').toUpperCase() === 'DONE'
            )).length,
            'warning-backed completion failure must preserve the pre-existing DONE status aggregate state'
        );
        assert.equal(
            restoredAggregateEntries.filter((entry) => (
                String(entry.task_id || '').trim() === taskId
                && String(entry.event_type || '').trim() === 'COMPLETION_GATE_FAILED'
            )).length,
            1,
            'warning-backed completion failure must emit a single failure lifecycle marker for auditability'
        );
        const restoredTimelineSummary = baselineTimelineSummaryContent === null
            ? null
            : (
                fs.existsSync(timelineSummaryPath) && fs.statSync(timelineSummaryPath).isFile()
                    ? JSON.parse(fs.readFileSync(timelineSummaryPath, 'utf8')) as {
                        entries?: Record<string, { events_found?: string[]; events_missing?: string[]; completeness_status?: string }>;
                    }
                    : null
            );
        const restoredCurrentTaskSummary = restoredTimelineSummary?.entries?.[taskId];
        assert.ok(restoredCurrentTaskSummary, 'warning-backed completion failure must keep a timeline summary entry for the current task');
        assert.equal(
            Array.isArray(restoredCurrentTaskSummary?.events_found)
                ? restoredCurrentTaskSummary.events_found.includes('COMPLETION_GATE_PASSED')
                : false,
            false,
            'warning-backed completion failure must not leave COMPLETION_GATE_PASSED in the current task timeline summary'
        );
        assert.equal(
            Array.isArray(restoredCurrentTaskSummary?.events_missing)
                ? restoredCurrentTaskSummary.events_missing.includes('COMPLETION_GATE_PASSED')
                : false,
            true,
            'warning-backed completion failure must keep the current task timeline summary incomplete for COMPLETION_GATE_PASSED'
        );
        assert.equal(
            String(restoredCurrentTaskSummary?.completeness_status || ''),
            'INCOMPLETE',
            'warning-backed completion failure must preserve the current task completion summary state'
        );

        await handleCompletionGate([
            '--preflight-path', preflightPath,
            '--task-id', taskId,
            '--repo-root', repoRoot
        ]);

        const repairedEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            repairedEvents.filter((event) => event.event_type === 'COMPLETION_GATE_PASSED').length,
            baselineCompletionCount + 1
        );
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('handleCompletionGate appends COMPLETION_GATE_FAILED when finalization fails after validation PASS', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-completion-finalization-failed-marker';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-completion-finalization-failed-marker.md');
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
            taskSummary: 'Emit COMPLETION_GATE_FAILED when post-validation finalization fails'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Completion finalization failure marker regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionFinalizationModule = require('../../../../src/cli/commands/gate-flows/completion-finalization') as {
            reconcileSuccessfulCompletionFinalizationAsync: (...args: unknown[]) => Promise<unknown>;
        };
        const originalReconcileSuccessfulCompletionFinalizationAsync =
            completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync;
        completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync = async () => {
            throw new Error('Injected completion finalization failure after validation PASS');
        };

        try {
            const error = await captureExpectedAsyncError(async () => {
                await handleCompletionGate([
                    '--preflight-path', preflightPath,
                    '--task-id', taskId,
                    '--repo-root', repoRoot
                ]);
            });
            assert.match(error.message, /completion-gate finalization failed after validation PASS/i);
            assert.match(error.message, /Injected completion finalization failure after validation PASS/i);
        } finally {
            completionFinalizationModule.reconcileSuccessfulCompletionFinalizationAsync =
                originalReconcileSuccessfulCompletionFinalizationAsync;
        }

        const failedAttemptEvents = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(
            failedAttemptEvents.filter((event) => event.event_type === 'COMPLETION_GATE_FAILED').length,
            1,
            'post-validation finalization failures must emit a failure lifecycle marker'
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('task-audit-summary materializes canonical final closeout artifacts through the CLI handler', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-final-closeout-artifact';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
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
        const commandsPath = path.join(repoRoot, 'commands-final-closeout-artifact.md');
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
            taskSummary: 'Materialize final closeout artifacts from task-audit-summary'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'DOCS_UPDATED',
            behaviorChanged: false,
            changelogUpdated: false,
            docsUpdated: ['docs/cli-reference.md'],
            rationale: 'Final closeout artifact fixture updates workflow documentation.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        try {
            process.chdir(repoRoot);
            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'completion-gate',
                '--preflight-path', preflightPath,
                '--task-id', taskId,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'task-audit-summary',
                '--task-id', taskId,
                '--repo-root', repoRoot,
                '--as-json'
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewsRoot = getReviewsRoot(repoRoot);
        const finalCloseoutJsonPath = path.join(reviewsRoot, `${taskId}-final-closeout.json`);
        const finalCloseoutMarkdownPath = path.join(reviewsRoot, `${taskId}-final-closeout.md`);
        assert.equal(fs.existsSync(finalCloseoutJsonPath), true);
        assert.equal(fs.existsSync(finalCloseoutMarkdownPath), true);
        const finalCloseoutJson = JSON.parse(fs.readFileSync(finalCloseoutJsonPath, 'utf8'));
        assert.equal(finalCloseoutJson.status, 'READY');
        assert.equal(finalCloseoutJson.artifact_state, 'MATERIALIZED');
        assert.deepEqual(finalCloseoutJson.implementation_summary.review_verdicts, {
            code: 'REVIEW PASSED',
            test: 'TEST REVIEW PASSED'
        });
        assert.ok(fs.readFileSync(finalCloseoutMarkdownPath, 'utf8').includes('Do you want me to commit now? (yes/no)'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('task-audit-summary preserves existing final closeout artifacts while completion finalization is in flight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-task-audit-summary-inflight-finalization';
        seedTaskQueue(repoRoot, taskId, '🟧 IN_REVIEW');
        seedInitAnswers(repoRoot);
        writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: false,
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
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPLETION_GATE_PASSED',
            'PASS',
            'Older completion gate passed before the current rerun.',
            {}
        );
        const lockPath = path.join(getReviewsRoot(repoRoot), `${taskId}-completion-gate.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({ pid: process.pid }), 'utf8');
        const staleJsonPath = path.join(getReviewsRoot(repoRoot), `${taskId}-final-closeout.json`);
        const staleMarkdownPath = path.join(getReviewsRoot(repoRoot), `${taskId}-final-closeout.md`);
        fs.writeFileSync(staleJsonPath, '{}\n', 'utf8');
        fs.writeFileSync(staleMarkdownPath, 'stale\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalStdoutWrite = process.stdout.write;
        const capturedStdout: string[] = [];
        process.exitCode = 0;
        process.stdout.write = ((chunk: string | Uint8Array, encoding?: BufferEncoding | ((error?: Error | null) => void), callback?: (error?: Error | null) => void): boolean => {
            capturedStdout.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString(typeof encoding === 'string' ? encoding : 'utf8'));
            if (typeof encoding === 'function') {
                encoding();
            } else if (typeof callback === 'function') {
                callback();
            }
            return true;
        }) as typeof process.stdout.write;

        try {
            process.chdir(repoRoot);
            await runCliMain([
                'gate',
                'task-audit-summary',
                '--task-id', taskId,
                '--repo-root', repoRoot,
                '--as-json'
            ]);
        } finally {
            process.stdout.write = originalStdoutWrite;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const rendered = JSON.parse(capturedStdout.join(''));
        assert.equal(rendered.status, 'INCOMPLETE');
        assert.equal(rendered.point_in_time_snapshot.status, 'FINALIZATION_IN_FLIGHT');
        assert.equal(rendered.point_in_time_snapshot.owner_pid, process.pid);
        assert.equal(rendered.point_in_time_snapshot.owner_metadata_status, 'ok');
        assert.equal(rendered.point_in_time_snapshot.acquisition_policy.timeout_ms, 5000);
        assert.match(rendered.final_report_contract.blocker, /point-in-time snapshot/i);
        assert.match(rendered.final_report_contract.blocker, /Re-run task-audit-summary sequentially/i);
        assert.equal(fs.existsSync(staleJsonPath), true);
        assert.equal(fs.existsSync(staleMarkdownPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes completion gate only after task mode entry, review gate, and doc impact gate', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands.md');
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
            taskSummary: 'Update app flow'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.match(String(completionResult.task_mode_path || ''), /T-903a-task-mode\.json$/);
        // T-003: verify stage_sequence_evidence is present
        assert.ok(completionResult.stage_sequence_evidence);
        assert.equal(completionResult.stage_sequence_evidence.code_changed, true);
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('PREFLIGHT_CLASSIFIED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('IMPLEMENTATION_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_PHASE_STARTED'));
        assert.ok(completionResult.stage_sequence_evidence.observed_order.includes('REVIEW_RECORDED'));
        assert.deepEqual(completionResult.stage_sequence_evidence.review_skill_ids, ['code-review']);
        assert.equal(completionResult.stage_sequence_evidence.review_skill_reference_paths.length, 1);
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes completion gate when a later coherent cycle exists despite stale early task-entry ordering noise', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery.md');
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
            taskSummary: 'Recover a later coherent completion cycle'
        });
        runHandshakeForTask(repoRoot, taskId);
        loadTaskEntryRulePack(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, reviewResult.outputLines.join('\n'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal lifecycle recovery only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.status, 'PASSED');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails completion gate when the latest cycle is misordered and would need compile backfill from an older cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-negative';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-negative.md');
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
            taskSummary: 'Reject cross-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started too early for later cycle.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'COMPILE_GATE_PASSED',
            'PASS',
            'Compile gate passed too late in later cycle.',
            {}
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));
        assert.match(String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || ''), /restart-coherent-cycle/);
        assert.match(String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || ''), new RegExp(escapeRegExp(taskId)));
        assert.match(String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || ''), new RegExp(escapeRegExp(commandsPath.replace(/\\/g, '/'))));
        assert.match(String((completionResult as Record<string, unknown>).coherent_cycle_restart_command || ''), new RegExp(escapeRegExp(outputFiltersPath.replace(/\\/g, '/'))));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails completion gate when the latest cycle has review evidence but no same-cycle implementation or compile', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-recovery-missing-prereq';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3, changed_files_count: 1 },
            changed_files: ['src/app.ts'],
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
        const commandsPath = path.join(repoRoot, 'commands-completion-recovery-missing-prereq.md');
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
            taskSummary: 'Reject missing same-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Initial review phase started.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_SELECTED',
            'INFO',
            'Skill selected: code-review',
            { skill_id: 'code-review', trigger_reason: 'required_review' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Reference loaded: garda-agent-orchestrator/live/skills/code-review/SKILL.md',
            {
                skill_id: 'code-review',
                reference_path: 'garda-agent-orchestrator/live/skills/code-review/SKILL.md',
                trigger_reason: 'review_skill'
            }
        );

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const firstReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstReviewResult.exitCode, 0);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'New preflight started for a later cycle.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Later review phase started without same-cycle implementation or compile.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Later review recorded.',
            { review_type: 'code' }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Later review gate appeared to pass.',
            {}
        );

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'IMPLEMENTATION_STARTED' from an older execution cycle.")));
        assert.ok(completionResult.stage_sequence_evidence.violations.some((item) => item.includes("Do not backfill 'COMPILE_GATE_PASSED' from an older execution cycle.")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate rejects stale task-mode artifacts after review pass when runtime identity metadata is removed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-task-mode-identity-missing-at-completion';
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
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject completion when pinned task-mode identity metadata is removed after review pass',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion-gate fails when workspace canonical ownership drifts after task-mode identity was pinned', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-completion-runtime-identity-drift';
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
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fail completion when workspace canonical SourceOfTruth drifts after task-mode entry',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`),
            'agent:code-reviewer'
        );

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Runtime identity drift regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        seedInitAnswers(repoRoot, 'Qwen');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'FAILED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((entry) => entry.includes('contradicts task-mode canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

});
