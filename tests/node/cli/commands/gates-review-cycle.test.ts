import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { EXIT_GATE_FAILURE } from '../../../../src/cli/exit-codes';
import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand,
    runRequiredReviewsCheckCommand
} from '../../../../src/cli/commands/gates';
import { formatCompletionGateResult, runCompletionGate } from '../../../../src/gates/completion';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
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
import { ensureSkillsHeadlinesCurrent } from '../../../../src/runtime/skill-headlines';
import { writeOptionalSkillSelectionArtifact } from '../../../../src/runtime/optional-skill-selection';
import * as childProcess from 'node:child_process';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

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
    taskId: string,
    sourceOfTruth = 'Codex',
    delegatedIdentity = 'agent:test-reviewer'
): {
    reviewerExecutionMode: 'delegated_subagent' | 'same_agent_fallback';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    trustLevel: 'LOCAL_ASSERTED';
} {
    const policy = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint');
    const reviewerExecutionMode = policy.expected_execution_mode;
    return {
        reviewerExecutionMode,
        reviewerIdentity: reviewerExecutionMode === 'same_agent_fallback'
            ? `self:${taskId}`
            : delegatedIdentity,
        reviewerFallbackReason: reviewerExecutionMode === 'same_agent_fallback'
            ? `${sourceOfTruth} provider_entrypoint fixtures cannot supply attested reviewer launch evidence.`
            : null,
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
    ensureSkillsHeadlinesCurrent(path.join(root, 'garda-agent-orchestrator'));
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
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: providerBridgePath || routedTo,
        reviewer_subagent_launch_reason: `Reviewer subagent launch is attested via explicit provider selection '${provider}' inside the orchestrator runtime.`,
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

describe('cli/commands/gates – review-cycle suites', () => {
    it('restarts the latest coherent cycle on a dirty tree while reusing the previous explicit preflight scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle.md');
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
            taskSummary: 'Restart the latest coherent cycle after misordered recovery noise',
            startBanner: 'Garda rewrites my code'
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

        const failedCompletion = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(failedCompletion.outcome, 'FAIL');

        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastTaskModeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'TASK_MODE_ENTERED');
        const lastHandshakeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        const lastShellSmokeIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED');
        const lastPreflightIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'PREFLIGHT_CLASSIFIED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(lastTaskModeIndex >= 0);
        assert.ok(lastHandshakeIndex > lastTaskModeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastPreflightIndex > lastShellSmokeIndex);
        assert.ok(lastCompileIndex > lastPreflightIndex);
        const lastTaskModeEvent = events[lastTaskModeIndex] as Record<string, unknown>;
        assert.equal(
            String((lastTaskModeEvent.details as Record<string, unknown>).start_banner || ''),
            'Garda rewrites my code'
        );
        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(
            path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`),
            'utf8'
        )) as Record<string, unknown>;
        assert.equal(refreshedTaskModeArtifact.start_banner, 'Garda rewrites my code');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts a coherent cycle from a legacy task-mode artifact without forcing a new start banner', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-legacy-task-mode';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart a coherent cycle from a legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        });

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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-legacy.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        assert.equal(taskModeEnteredEvents.length, 1);

        const refreshedTaskModeArtifact = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        assert.equal(Object.prototype.hasOwnProperty.call(refreshedTaskModeArtifact, 'start_banner'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle reuses the latest coherent restart floor for legacy task-mode artifacts after an older review pass', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-legacy-coherent-floor';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-legacy-coherent-floor.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        fs.mkdirSync(getReviewsRoot(repoRoot), { recursive: true });
        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before restart.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        });

        loadTaskEntryRulePack(repoRoot, taskId, taskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle after a coherent restart from a legacy task-mode artifact',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            taskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath);

        const initialCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(initialCompileResult.exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_GATE_PASSED',
            'PASS',
            'Legacy review gate passed before coherent restart.',
            {}
        );

        const coherentRestartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(coherentRestartResult.exitCode, 0, coherentRestartResult.outputLines.join('\n'));
        assert.match(coherentRestartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);

        const reviewRestartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewRestartResult.exitCode, 0, reviewRestartResult.outputLines.join('\n'));
        const output = reviewRestartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const taskModeEnteredEvents = events.filter((event) => event.event_type === 'TASK_MODE_ENTERED');
        const taskEntryRulePackIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (
                event.event_type === 'RULE_PACK_LOADED'
                && String((event.details as Record<string, unknown> | undefined)?.stage || '').toUpperCase() === 'TASK_ENTRY'
            ) {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(taskModeEnteredEvents.length, 1);
        assert.equal(taskEntryRulePackIndexes.length, 2);
        assert.equal(handshakeIndexes.length, 2);
        assert.equal(shellSmokeIndexes.length, 2);
        assert.ok(reviewGateIndex > taskEntryRulePackIndexes[0]);
        assert.ok(taskEntryRulePackIndexes[1] > reviewGateIndex);
        assert.ok(lastCompileIndex > shellSmokeIndexes[1]);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('replays a prior git_auto scope as explicit changed files during coherent-cycle restart', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-git-auto';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'noise.md'), 'unrelated dirty file\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-git-auto.md');
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
            taskSummary: 'Replay prior git_auto scope as explicit changed files during cycle restart'
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);
        assert.match(restartResult.outputLines.join('\n'), /DetectionSource: explicit_changed_files/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts']);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('preserves approved task-plan metadata when coherent-cycle restart re-enters task mode', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-plan';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            detection_source: 'git_auto',
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
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-plan.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const plan = validateTaskPlan({
            schema_version: 1,
            task_id: taskId,
            status: 'approved',
            goal: 'Restart the latest coherent task cycle safely',
            scope_files: ['src/app.ts'],
            risk_level: 'low',
            steps: [{ id: 'step-1', title: 'Replay the coherent cycle', files: ['src/app.ts'] }]
        });
        const planPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-plan.json`);
        fs.writeFileSync(planPath, serializeTaskPlan(plan), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart the latest coherent cycle with approved plan metadata preserved',
            planPath,
            emitMetrics: false
        });

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0);

        const taskModeArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8')
        ) as Record<string, unknown>;
        const planMetadata = taskModeArtifact.plan as Record<string, unknown> | null;
        assert.ok(planMetadata);
        assert.equal(planMetadata?.plan_path, planPath.replace(/\\/g, '/'));
        assert.equal(typeof planMetadata?.plan_sha256, 'string');
        assert.equal(planMetadata?.plan_summary, 'Restart the latest coherent task cycle safely');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff and prepares only upstream reviews when downstream test review is still blocked', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-code-only';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-code-only.md');
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
            taskSummary: 'Restart only the review cycle after a failed code review',
            plannedChangedFiles: [
                'commands-restart-review-cycle-code-only.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart only the review cycle after a failed code review',
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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: code/);
        assert.match(output, /LaunchRequiredReviewTypes: code/);
        assert.match(output, /PendingReviewTypes: test/);
        assert.match(output, /PendingReason: ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code\./);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            false
        );

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const firstCompileIndex = events.findIndex((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.ok(lastCompileIndex >= 0);
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > lastHandshakeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastCompileIndex > lastShellSmokeIndex);
        assert.ok(lastCodeReviewPhaseIndex === -1 || lastCodeReviewPhaseIndex > lastCompileIndex);
        assert.equal(lastTestReviewPhaseIndex, -1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restarts the latest coherent cycle with a custom task-mode artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903a-restart-coherent-cycle-custom-task-mode';
        const customTaskModePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'custom-artifacts',
            `${taskId}-task-mode.json`
        );
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-coherent-cycle-custom-task-mode.md');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the latest coherent cycle with a custom task-mode artifact path'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the latest coherent cycle with a custom task-mode artifact path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartCoherentCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /COHERENT_CYCLE_RESTARTED/);
        assert.match(
            restartResult.outputLines.join('\n'),
            new RegExp(escapeRegExp(customTaskModePath.replace(/\\/g, '/')))
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refreshes the current diff with a custom task-mode artifact path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-custom-task-mode';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-custom-task-mode.md');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Restart the review cycle with a custom task-mode artifact path',
            provider: 'Codex',
            plannedChangedFiles: [
                'commands-restart-review-cycle-custom-task-mode.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle with a custom task-mode artifact path',
            ['src/app.ts', 'tests/app.test.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);
        assert.match(restartResult.outputLines.join('\n'), /PreparedReviewTypes: code/);
        assert.match(restartResult.outputLines.join('\n'), /LaunchRequiredReviewTypes: code/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle materializes downstream test review after current-cycle code review is refreshed via reuse', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-reuse';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-reuse.md');
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
            taskSummary: 'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
            plannedChangedFiles: [
                'commands-restart-review-cycle-reuse.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle and reuse code review evidence before rebuilding downstream test context',
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

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTARTED/);
        assert.match(output, /PreparedReviewTypes: code, test/);
        assert.match(output, /LaunchRequiredReviewTypes: test/);
        assert.match(output, /ReusedReviewTypes: code/);
        assert.doesNotMatch(output, /PendingReviewTypes:/);
        assert.doesNotMatch(output, /PendingReason:/);
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`)),
            true
        );
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            true
        );

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const firstCompileIndex = events.findIndex((event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.ok(lastCompileIndex >= 0);
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(firstCompileIndex >= 0);
        assert.ok(firstCompileIndex > lastHandshakeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);
        assert.ok(lastCompileIndex > lastShellSmokeIndex);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);
        assert.ok(lastTestReviewPhaseIndex > lastCodeReviewPhaseIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle escalates to restart-coherent-cycle after a prior review gate closed the latest cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-after-review-gate';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 4;\nconsole.log(a + b);\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-after-review-gate.md');
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
            taskSummary: 'Restart the review cycle after a prior review gate already closed the last cycle',
            plannedChangedFiles: [
                'commands-restart-review-cycle-after-review-gate.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart the review cycle after a prior review gate already closed the last cycle',
            ['src/app.ts']
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

        const codeReviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            codeReviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_GATE_PASSED/);
        assert.match(restartResult.outputLines.join('\n'), /restart-coherent-cycle/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const reviewGateIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'REVIEW_GATE_PASSED');
        const lastHandshakeIndex = handshakeIndexes.at(-1) ?? -1;
        const lastShellSmokeIndex = shellSmokeIndexes.at(-1) ?? -1;
        assert.equal(handshakeIndexes.length, 1);
        assert.equal(shellSmokeIndexes.length, 1);
        assert.ok(reviewGateIndex >= 0);
        assert.ok(reviewGateIndex > lastShellSmokeIndex);
        assert.ok(lastShellSmokeIndex > lastHandshakeIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle defaults to the current workspace diff instead of silently reusing the old explicit preflight scope', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-current-diff';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        writeReviewCapabilitiesConfig(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-current-diff.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Restart review cycle from the latest workspace diff after a failed review',
            plannedChangedFiles: [
                'src/app.ts',
                'tests/app.test.ts'
            ]
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Restart review cycle from the latest workspace diff after a failed review',
            ['src/app.ts']
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

        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));

        const output = restartResult.outputLines.join('\n');
        assert.match(output, /DetectionSource: git_auto_current_workspace/);
        assert.match(output, /PendingReviewTypes: test/);

        const refreshedPreflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        assert.deepEqual(refreshedPreflight.changed_files, ['src/app.ts', 'tests/app.test.ts']);
        assert.equal((refreshedPreflight.required_reviews as Record<string, boolean>).test, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle refuses to rebuild from a fresh task-mode cycle that never restored TASK_ENTRY rule-pack evidence', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-restart-review-cycle-missing-task-entry';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 5;\nconsole.log(a + b);\n', 'utf8');
        const commandsPath = path.join(repoRoot, 'commands-restart-review-cycle-missing-task-entry.md');
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
            taskSummary: 'Reject review-cycle restart when the latest task-mode cycle never restored task-entry rule-pack evidence',
            plannedChangedFiles: [
                'commands-restart-review-cycle-missing-task-entry.md',
                'garda-agent-orchestrator/live/config/review-capabilities.json',
                'src/app.ts'
            ]
        });

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

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        const output = restartResult.outputLines.join('\n');
        assert.match(output, /REVIEW_CYCLE_RESTART_FAILED/);
        assert.match(output, /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/);
        assert.match(output, /restart-coherent-cycle/);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const handshakeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'HANDSHAKE_DIAGNOSTICS_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        const shellSmokeIndexes = events.reduce<number[]>((indexes, event, index) => {
            if (event.event_type === 'SHELL_SMOKE_PREFLIGHT_RECORDED') {
                indexes.push(index);
            }
            return indexes;
        }, []);
        assert.equal(handshakeIndexes.length, 0);
        assert.equal(shellSmokeIndexes.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runBuildReviewContextCommand preserves the public key-value output contract', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-build-review-context-output-contract';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-build-review-context-output-contract.md');
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
            taskSummary: 'Preserve build-review-context output formatting contract'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Preserve build-review-context output formatting contract',
            ['src/app.ts']
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => /^TokenEconomyActive: (True|False)$/.test(line)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects optional skill loads when policy mode is off', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-off-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'src', 'api'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'api', 'orders.ts'), 'export const order = 1;\n', 'utf8');
        const optionalSkillPath = seedNodeBackendOptionalSkillFixture(repoRoot, 'off');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject optional skill loads at review gate when policy mode is off'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['src/api/orders.ts'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint.',
            changedPaths: ['src/api/orders.ts'],
            preflightPath,
            preflightSha256
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'SKILL_REFERENCE_LOADED',
            'INFO',
            'Optional skill loaded after an off-mode selection.',
            {
                skill_id: 'node-backend',
                reference_path: optionalSkillPath,
                trigger_reason: 'manual'
            }
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes("policy mode is 'off'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects stale strict optional-skill artifacts when the current TASK.md title changes', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-stale-task-text';
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Implement request validation for a Node.js API endpoint',
                'Refresh landing-page copy for the marketing site'
            ),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects strict optional-skill artifacts when the task row disappears from TASK.md', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-149-review-missing-task-row';
        seedTaskQueue(repoRoot, taskId);
        const taskPath = path.join(repoRoot, 'TASK.md');
        fs.writeFileSync(
            taskPath,
            fs.readFileSync(taskPath, 'utf8').replace(
                'Update app flow',
                'Implement request validation for a Node.js API endpoint'
            ),
            'utf8'
        );
        seedInitAnswers(repoRoot, 'Codex');
        fs.mkdirSync(path.join(repoRoot, 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'docs', 'landing.md'), 'hello\n', 'utf8');
        seedNodeBackendOptionalSkillFixture(repoRoot, 'strict');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Implement request validation for a Node.js API endpoint'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 3 },
            changed_files: ['docs/landing.md'],
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
        const crypto = require('node:crypto');
        const preflightSha256 = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        writeOptionalSkillSelectionArtifact(getOrchestratorRoot(repoRoot), taskId, {
            taskText: 'Implement request validation for a Node.js API endpoint',
            changedPaths: ['docs/landing.md'],
            preflightPath,
            preflightSha256
        });
        fs.writeFileSync(
            taskPath,
            [
                '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
                '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
                '| T-999 | TODO | P2 | docs | Placeholder task | unassigned | 2026-03-28 | default | fixture |'
            ].join('\n'),
            'utf8'
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewContextPath = path.join(getReviewsRoot(repoRoot), `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            reviewContextPath,
            'agent:code-reviewer'
        );

        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewGateResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewGateResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewGateResult.outputLines.some((line) => line.includes('current task summary hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion diagnostics surface restart-review-cycle when review evidence is incomplete without a stage-sequence failure', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-review-recovery-command.md');
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
            taskSummary: 'Surface a narrow review-cycle recovery command from completion diagnostics'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Surface a narrow review-cycle recovery command from completion diagnostics',
            ['src/app.ts']
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );
        assert.match(
            formatCompletionGateResult(completionResult as Record<string, unknown>),
            /RecoveryCommand: .*restart-review-cycle/
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after COMPLETION_GATE_FAILED when completion diagnostics advertise that narrow recovery path', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-command-after-completion-fail';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it(\"works\", () => {});\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-review-recovery-command-after-completion-fail.md');
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
            taskSummary: 'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable after completion diagnostics surface it as the recovery command',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);
        assert.match(
            String((completionResult as Record<string, unknown>).review_cycle_restart_command || ''),
            /restart-review-cycle/
        );

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle fails after a fresh TASK_MODE_ENTERED when TASK_ENTRY was not restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-missing-task-entry';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-review-recovery-missing-task-entry.md');
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
            taskSummary: 'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject restart-review-cycle when a fresh task-mode cycle did not reload task-entry rules',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle without task-entry reload must not use restart-review-cycle'
        });

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, EXIT_GATE_FAILURE, restartResult.outputLines.join('\n'));
        assert.match(
            restartResult.outputLines.join('\n'),
            /TASK_MODE_ENTERED without matching RULE_PACK_LOADED for TASK_ENTRY/
        );
        assert.match(restartResult.outputLines.join('\n'), /Run restart-coherent-cycle/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('restart-review-cycle remains usable after a fresh TASK_MODE_ENTERED when TASK_ENTRY is restored for that new cycle', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b-review-recovery-restored-task-entry';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-review-recovery-restored-task-entry.md');
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
            taskSummary: 'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Keep restart-review-cycle usable when a fresh task-mode cycle reloads task-entry rules',
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

        const buildResult = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: '2',
            preflightPath
        });
        assert.ok(buildResult.outputLines.some((line) => line.startsWith('OutputPath: ')));

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.equal(completionResult.stage_sequence_evidence.violations.length, 0);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Fresh task-mode cycle with task-entry reload should keep restart-review-cycle available'
        });
        loadTaskEntryRulePack(repoRoot, taskId);

        const restartResult = await runRestartReviewCycleCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(restartResult.exitCode, 0, restartResult.outputLines.join('\n'));
        assert.match(restartResult.outputLines.join('\n'), /REVIEW_CYCLE_RESTARTED/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });
});
