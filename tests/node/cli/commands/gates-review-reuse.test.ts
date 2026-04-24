import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    EXIT_GATE_FAILURE
} from '../../../../src/cli/exit-codes';
import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { runCompletionGate } from '../../../../src/gates/completion';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerProvenance
} from '../../../../src/gate-runtime/review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../src/gates/review-reuse';
import { resolveReviewerRoutingPolicy } from '../../../../src/gates/reviewer-routing';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import * as childProcess from 'node:child_process';

function createReviewerRoutingFixture(
    sourceOfTruth: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const policy = resolveReviewerRoutingPolicy(normalizedSourceOfTruth, 'provider_entrypoint');
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: 'provider_entrypoint',
        identity_status: 'resolved',
        capability_level: policy.capability_level,
        delegation_required: policy.delegation_required,
        expected_execution_mode: policy.expected_execution_mode,
        fallback_allowed: policy.fallback_allowed,
        fallback_reason_required: policy.fallback_reason_required,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
}

function resolveReviewerExecutionFixture(
    _taskId: string,
    sourceOfTruth = 'Codex',
    delegatedIdentity = 'agent:test-reviewer'
): {
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: null;
    trustLevel: 'LOCAL_ASSERTED';
} {
    const reviewerExecutionMode = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint').expected_execution_mode;
    return {
        reviewerExecutionMode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'LOCAL_ASSERTED'
    };
}

function readSeededSourceOfTruth(repoRoot: string): string {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return 'Codex';
    }
    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        const sourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        return sourceOfTruth || 'Codex';
    } catch {
        return 'Codex';
    }
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
    return runEnterTaskModeCommand(withDefaultTaskModeRouting({
        startBanner: 'Garda captures my mind',
        ...options
    }));
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

function writeReviewCapabilitiesConfig(
    repoRoot: string,
    overrides: Partial<Record<'code' | 'db' | 'security' | 'refactor' | 'api' | 'test' | 'performance' | 'infra' | 'dependency', boolean>> = {}
): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const configPath = path.join(configDir, 'review-capabilities.json');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: true,
        ...overrides
    }, null, 2) + '\n', 'utf8');
    return configPath;
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
    const sourceOfTruth = readSeededSourceOfTruth(repoRoot);
    const execution = resolveReviewerExecutionFixture(taskId, sourceOfTruth);
    const reviewContext = {
        review_type: reviewKey,
        reviewer_routing: createReviewerRoutingFixture(sourceOfTruth, {
            actual_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            fallback_reason: execution.reviewerFallbackReason
        })
    };
    const reviewContextText = JSON.stringify(reviewContext, null, 2);
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');

    // Authenticity hardening: write a verifiable receipt with attested routing provenance.
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    let reviewerProvenance = null;
    if (fs.existsSync(path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`))) {
        const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
            review_type: reviewKey
        });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
        const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'review routing recorded', {
            review_type: reviewKey,
            reviewer_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            delegation_used: execution.reviewerExecutionMode === 'delegated_subagent',
            reviewer_fallback_reason: execution.reviewerFallbackReason
        }, { passThru: true });
        reviewerProvenance = buildReviewReceiptReviewerProvenance('REVIEWER_DELEGATION_ROUTED', routedEvent?.integrity);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', { review_type: reviewKey });
    }
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify({
        schema_version: 2,
        task_id: taskId,
        review_type: reviewKey,
        review_artifact_sha256: artifactHash,
        review_context_sha256: reviewContextHash,
        reviewer_execution_mode: execution.reviewerExecutionMode,
        reviewer_identity: execution.reviewerIdentity,
        reviewer_fallback_reason: execution.reviewerFallbackReason,
        reviewer_provenance: reviewerProvenance,
        trust_level: execution.trustLevel
    }));
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
    const sourceOfTruth = readSeededSourceOfTruth(repoRoot);
    const execution = resolveReviewerExecutionFixture(taskId, sourceOfTruth, reviewerIdentity);
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
        actualExecutionMode: execution.reviewerExecutionMode,
        reviewerSessionId: execution.reviewerIdentity,
        fallbackReason: execution.reviewerFallbackReason
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
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical review started', {
        review_type: reviewKey
    });
    const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical review routing recorded', {
        review_type: reviewKey,
        reviewer_execution_mode: execution.reviewerExecutionMode,
        reviewer_session_id: execution.reviewerIdentity,
        delegation_used: execution.reviewerExecutionMode === 'delegated_subagent',
        reviewer_fallback_reason: execution.reviewerFallbackReason
    }, { passThru: true });
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
        reviewerExecutionMode: execution.reviewerExecutionMode,
        reviewerIdentity: execution.reviewerIdentity,
        reviewerFallbackReason: execution.reviewerFallbackReason,
        reviewerProvenance: buildReviewReceiptReviewerProvenance('REVIEWER_DELEGATION_ROUTED', routedEvent?.integrity),
        trustLevel: execution.trustLevel
    });
    fs.writeFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical review recorded', {
        review_type: reviewKey
    });
    return reviewContextPath;
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

function findLastTimelineEventIndex(
    events: Array<Record<string, unknown>>,
    predicate: (event: Record<string, unknown>) => boolean
): number {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return index;
        }
    }
    return -1;
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

describe('cli/commands/gates – review-reuse suites', () => {
    it('build-review-context rejects late review preparation after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-late-build';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewContextArtifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-context.json`);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(reviewContextArtifactPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_PHASE_STARTED'), false);
        assert.equal(events.some((event) => event.event_type === 'SKILL_SELECTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses current-cycle code review evidence and unblocks downstream test review when runtime code scope is unchanged', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-code-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');

        const priorPreflightPath = writePreflight(
            repoRoot,
            taskId,
            {
                detection_source: 'explicit_changed_files',
                mode: 'FULL_PATH',
                changed_files: ['src/app.ts'],
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
                }
            },
            `${taskId}-prior-preflight.json`
        );
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-reuse.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        const codeExecution = resolveReviewerExecutionFixture(taskId, 'Qwen', 'agent:code-reviewer');
        const testExecution = resolveReviewerExecutionFixture(taskId, 'Qwen', 'agent:test-reviewer');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when only test scope changes'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, codeExecution.reviewerIdentity);
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical code review started', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: codeExecution.reviewerExecutionMode,
            reviewer_session_id: codeExecution.reviewerIdentity,
            delegation_used: codeExecution.reviewerExecutionMode === 'delegated_subagent',
            reviewer_fallback_reason: codeExecution.reviewerFallbackReason
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical code review recorded', {
            review_type: 'code',
            reused_existing_review: false
        });
        const legacyReceiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reuse code review evidence when only test scope changes',
            ['src/app.ts', 'tests/app.test.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot
            ]);
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-test.md`), [
                '# Test Review',
                '',
                'Validated `tests/app.test.ts` and the rerun-only scope for the fresh review cycle. This review artifact is intentionally detailed enough to satisfy the anti-triviality check while reporting no concrete failures for the updated test surface.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'TEST REVIEW PASSED'
            ].join('\n'), 'utf8');
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', testExecution.reviewerExecutionMode,
                '--reviewer-identity', testExecution.reviewerIdentity,
                ...(testExecution.reviewerFallbackReason
                    ? ['--reviewer-fallback-reason', testExecution.reviewerFallbackReason]
                    : [])
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', testExecution.reviewerExecutionMode,
                '--reviewer-identity', testExecution.reviewerIdentity,
                ...(testExecution.reviewerFallbackReason
                    ? ['--reviewer-fallback-reason', testExecution.reviewerFallbackReason]
                    : [])
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, codeExecution.reviewerIdentity);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, codeExecution.reviewerIdentity);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        let latestCompileSequence = -1;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            if (events[index].event_type === 'COMPILE_GATE_PASSED') {
                latestCompileSequence = index;
                break;
            }
        }
        const reviewPhaseSequences = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ))
            .map(({ index }) => index);
        const recordedEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEW_RECORDED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.ok(latestCompileSequence >= 0);
        assert.ok(reviewPhaseSequences.some((sequence) => sequence < latestCompileSequence));
        assert.ok(recordedEvents.some(({ index }) => index < latestCompileSequence));
        assert.equal(recordedEvents.some(({ index }) => index > latestCompileSequence), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a pure test-only rerun', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a pure test-only rerun'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot).code_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence when only the aggregate telemetry index fails', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-aggregate-warning';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when aggregate telemetry index fails'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        const aggregatePath = path.join(taskEventsRoot, 'all-tasks.jsonl');
        fs.rmSync(aggregatePath, { force: true });
        fs.mkdirSync(aggregatePath, { recursive: true });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });
        assert.equal(result.reusedReviewEvidence, true);
        assert.equal(result.reusedReviewerExecutionMode, 'delegated_subagent');
        assert.equal(result.reusedReviewerIdentity, 'agent:code-reviewer');
        assert.equal(
            fs.existsSync(aggregatePath) && fs.statSync(aggregatePath).isDirectory(),
            true,
            'fixture must keep aggregate index unavailable while reuse succeeds from canonical task events'
        );

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(refreshedReceipt.preflight_sha256, require('node:crypto')
            .createHash('sha256')
            .update(fs.readFileSync(preflightPath, 'utf8'))
            .digest('hex'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewerRouting.reviewer_session_id, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > latestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
            1
        );
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEW_RECORDED').length,
            1
        );
        assert.equal(
            (currentCycleCodeEvents.find(({ event }) => event.event_type === 'REVIEW_RECORDED')?.event.details as Record<string, unknown>).reused_existing_review,
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves delegated reviewer provenance when historical code review evidence is reused in the current cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-delegated-reuse-provenance';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable delegated code review evidence before a pure test-only rerun',
            provider: 'Codex'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(refreshedReceipt.reviewer_identity, 'agent:code-reviewer');
        assert.equal(refreshedReceipt.trust_level, 'LOCAL_ASSERTED');
        const refreshedProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown> | null;
        assert.ok(refreshedProvenance);

        const refreshedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const refreshedRouting = refreshedContext.reviewer_routing as Record<string, unknown>;
        assert.equal(refreshedRouting.actual_execution_mode, 'delegated_subagent');
        assert.equal(refreshedRouting.reviewer_session_id, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        let currentCycleRoutedEvent: Record<string, unknown> | null = null;
        for (let index = events.length - 1; index >= 0; index -= 1) {
            const event = events[index];
            if (index <= latestCompileSequence) {
                break;
            }
            if (
                event.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ) {
                currentCycleRoutedEvent = event;
                break;
            }
        }
        assert.ok(currentCycleRoutedEvent);
        const routedIntegrity = currentCycleRoutedEvent?.integrity as Record<string, unknown> | undefined;
        assert.equal(refreshedProvenance?.task_sequence, routedIntegrity?.task_sequence);
        assert.equal(refreshedProvenance?.event_sha256, routedIntegrity?.event_sha256);
        assert.equal(refreshedProvenance?.prev_event_sha256 ?? null, routedIntegrity?.prev_event_sha256 ?? null);

        const recordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.ok(recordedEvents.length >= 1);
        assert.equal((recordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when the runtime reviewer identity changes for the same code scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-runtime-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Record a baseline code review before switching runtime provider'
        });
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical code review started', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            delegation_used: false,
            reviewer_fallback_reason: 'Codex provider_entrypoint fixtures cannot supply attested reviewer launch evidence.'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical code review recorded', {
            review_type: 'code',
            reused_existing_review: false
        });

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Switch runtime provider while keeping the code scope unchanged',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.execution_provider, 'Antigravity');
        assert.equal(reviewContext.reviewer_routing.execution_provider_source, 'provider_bridge');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestTaskModeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'TASK_MODE_ENTERED');
        const postRestartReviewEvents = events.filter((event, index) => (
            index > latestTaskModeIndex
            && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(postRestartReviewEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when the code scope fingerprint changed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-code-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before the code scope changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 1;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 6 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when compile evidence does not belong to the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-stale-compile-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before stale compile validation'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-prior-preflight.json`);
        const staleCurrentPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 }
        }, `${taskId}-stale-current-preflight.json`);
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 6 },
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review evidence when compile evidence is stale'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, staleCurrentPreflightPath);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('Compile gate evidence preflight hash mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not report reuse success when current-cycle reuse telemetry cannot be recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-reuse-telemetry-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before reuse telemetry lock validation'
        });
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
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
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const taskEventsRoot = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events');
        fs.mkdirSync(taskEventsRoot, { recursive: true });
        const lockPath = path.join(taskEventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const crypto = require('node:crypto');
        const priorPreflightSha = crypto.createHash('sha256').update(fs.readFileSync(priorPreflightPath, 'utf8')).digest('hex');
        const currentPreflightSha = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.preflight_sha256, priorPreflightSha);
        assert.notEqual(refreshedReceipt.preflight_sha256, currentPreflightSha);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentCycleCodeEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > latestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(currentCycleCodeEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
