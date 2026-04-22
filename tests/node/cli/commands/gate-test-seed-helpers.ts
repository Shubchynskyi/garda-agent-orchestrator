/**
 * Test helpers: rule/config seeding, artifact writers, evidence builders,
 * and gate-lifecycle orchestration for test fixtures.
 *
 * Extracted from gate-test-helpers.ts to isolate seeding and evidence
 * concerns from repo bootstrapping and CLI capture.
 * All exports are test-only.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../src/gates/review-reuse';
import {
    resolveReviewerRoutingPolicy
} from '../../../../src/gates/reviewer-routing';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerProvenance
} from '../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

import {
    getReviewsRoot,
    getOrchestratorRoot
} from './gate-test-repo-bootstrap';

// ---------------------------------------------------------------------------
// Provider routing constants
// ---------------------------------------------------------------------------

export const PROVIDER_ENTRYPOINT_BY_SOURCE: Record<string, string> = {
    Claude: 'CLAUDE.md',
    Codex: 'AGENTS.md',
    Gemini: 'GEMINI.md',
    Qwen: 'QWEN.md',
    GitHubCopilot: '.github/copilot-instructions.md',
    Windsurf: '.windsurf/rules/rules.md',
    Junie: '.junie/guidelines.md',
    Antigravity: '.antigravity/rules.md'
};

export const PROVIDER_BRIDGE_BY_SOURCE: Record<string, string> = {
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

// ---------------------------------------------------------------------------
// Config seeding
// ---------------------------------------------------------------------------

export function writeReviewCapabilitiesConfig(
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

export function writeBudgetOutputFilters(repoRoot: string): string {
    const outputFiltersPath = path.join(getOrchestratorRoot(repoRoot), 'live', 'config', 'output-filters.json');
    fs.mkdirSync(path.dirname(outputFiltersPath), { recursive: true });
    fs.writeFileSync(outputFiltersPath, JSON.stringify({
        version: 2,
        budget_profiles: {
            enabled: true,
            tiers: [
                {
                    label: 'tight',
                    max_tokens: null,
                    passthrough_ceiling_max_lines: 12,
                    fail_tail_lines: 3,
                    max_matches: 5,
                    max_parser_lines: 6,
                    truncate_line_max_chars: 160
                }
            ]
        },
        profiles: {
            compile_success_console: {
                description: 'Compile success telemetry',
                operations: []
            },
            compile_failure_console_generic: {
                description: 'Compile failure telemetry',
                operations: []
            },
            review_gate_success_console: {
                description: 'Review gate success telemetry',
                operations: []
            },
            review_gate_failure_console: {
                description: 'Review gate failure telemetry',
                operations: []
            }
        }
    }, null, 2), 'utf8');
    return outputFiltersPath;
}

export function seedTaskQueue(repoRoot: string, taskId: string, status = 'TODO'): void {
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        `| ${taskId} | ${status} | P1 | test | Update app flow | unassigned | 2026-03-28 | default | fixture |`
    ].join('\n'), 'utf8');
}

export function seedInitAnswers(repoRoot: string, sourceOfTruth = 'Codex'): void {
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

// ---------------------------------------------------------------------------
// Task-mode routing helpers
// ---------------------------------------------------------------------------

export function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
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

export function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
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
    }
    return runEnterTaskModeCommand(resolvedOptions);
}

// ---------------------------------------------------------------------------
// Reviewer routing fixture
// ---------------------------------------------------------------------------

export function createReviewerRoutingFixture(
    sourceOfTruth: string,
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const attestedRoute = resolveAttestedTaskModeRoute(normalizedSourceOfTruth);
    const executionProviderSource = (
        attestedRoute
        && PROVIDER_BRIDGE_BY_SOURCE[normalizedSourceOfTruth] === attestedRoute
    )
        ? 'provider_bridge'
        : 'provider_entrypoint';
    const policy = resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource);
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: executionProviderSource,
        identity_status: 'resolved',
        capability_level: policy.capability_level,
        expected_execution_mode: policy.expected_execution_mode,
        fallback_allowed: policy.fallback_allowed,
        fallback_reason_required: policy.fallback_reason_required,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
}

// ---------------------------------------------------------------------------
// Artifact writers
// ---------------------------------------------------------------------------

export function writePreflight(
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

export function appendPreflightClassifiedEvent(repoRoot: string, taskId: string, preflightPath: string): void {
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

export function writeCompilePassEvidence(repoRoot: string, taskId: string, preflightPath: string): void {
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

function readSeededSourceOfTruth(repoRoot: string): string {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    if (!fs.existsSync(initAnswersPath) || !fs.statSync(initAnswersPath).isFile()) {
        return 'Codex';
    }
    try {
        const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
        return typeof payload.SourceOfTruth === 'string' && payload.SourceOfTruth.trim()
            ? payload.SourceOfTruth.trim()
            : 'Codex';
    } catch {
        return 'Codex';
    }
}

function resolveDefaultReviewerEvidence(repoRoot: string, taskId: string, reviewKey: string): {
    sourceOfTruth: string;
    executionMode: 'delegated_subagent' | 'same_agent_fallback';
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    routingOverrides: Record<string, unknown>;
} {
    const sourceOfTruth = readSeededSourceOfTruth(repoRoot);
    const policy = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint');
    const executionMode = policy.expected_execution_mode === 'same_agent_fallback'
        ? 'same_agent_fallback'
        : 'delegated_subagent';
    const delegatedReviewerIdentity = reviewKey === 'code'
        ? 'agent:code-reviewer'
        : reviewKey === 'test'
            ? 'agent:test-reviewer'
            : `agent:${reviewKey}-reviewer`;
    const reviewerIdentity = executionMode === 'same_agent_fallback'
        ? `self:${taskId}`
        : delegatedReviewerIdentity;
    const reviewerFallbackReason = executionMode === 'same_agent_fallback'
        ? 'attested reviewer launch unavailable in direct provider session'
        : null;
    return {
        sourceOfTruth,
        executionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        routingOverrides: {
            execution_provider_source: 'provider_entrypoint',
            delegation_required: policy.delegation_required,
            expected_execution_mode: policy.expected_execution_mode,
            fallback_allowed: policy.fallback_allowed,
            fallback_reason_required: policy.fallback_reason_required,
            actual_execution_mode: executionMode,
            reviewer_session_id: reviewerIdentity,
            fallback_reason: reviewerFallbackReason
        }
    };
}

export function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[]
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, { recursive: true });
    const reviewerEvidence = resolveDefaultReviewerEvidence(repoRoot, taskId, reviewKey);
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
        reviewer_routing: createReviewerRoutingFixture(reviewerEvidence.sourceOfTruth, {
            ...reviewerEvidence.routingOverrides
        })
    };
    const reviewContextText = JSON.stringify(reviewContext, null, 2);
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');

    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');

    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
        review_type: reviewKey
    });
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
        review_type: reviewKey,
        reviewer_execution_mode: reviewerEvidence.executionMode,
        reviewer_session_id: reviewerEvidence.reviewerIdentity,
        reviewer_fallback_reason: reviewerEvidence.reviewerFallbackReason,
        delegation_used: reviewerEvidence.executionMode === 'delegated_subagent'
    }, { passThru: true });
    const reviewerProvenance = buildReviewReceiptReviewerProvenance(
        'REVIEWER_DELEGATION_ROUTED',
        routedEvent?.integrity
    );

    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    let preflightSha256: string | null = null;
    let scopeSha256: string | null = null;
    let codeScopeSha256: string | null = null;
    let reviewContextReuseSha256: string | null = null;
    if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflight = JSON.parse(preflightText) as Record<string, unknown>;
        preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        scopeSha256 = String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null;
        codeScopeSha256 = reviewKey === 'code'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null;
        reviewContextReuseSha256 = computeReviewContextReuseHash(reviewContext);
    }

    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256,
        scopeSha256,
        codeScopeSha256,
        reviewContextSha256: reviewContextHash,
        reviewContextReuseSha256,
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: reviewerEvidence.executionMode,
        reviewerIdentity: reviewerEvidence.reviewerIdentity,
        reviewerFallbackReason: reviewerEvidence.reviewerFallbackReason,
        reviewerProvenance
    });
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', { review_type: reviewKey });
}

export function writeCleanReviewArtifact(repoRoot: string, taskId: string, reviewKey: string, verdict: string): void {
    writeReceiptBackedReviewArtifact(repoRoot, taskId, reviewKey, verdict);
}

export function seedReusableReviewEvidence(
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
    const builtReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const builtReviewerRouting = builtReviewContext.reviewer_routing
        && typeof builtReviewContext.reviewer_routing === 'object'
        && !Array.isArray(builtReviewContext.reviewer_routing)
        ? builtReviewContext.reviewer_routing as Record<string, unknown>
        : {};
    const expectedExecutionMode = typeof builtReviewerRouting.expected_execution_mode === 'string'
        ? builtReviewerRouting.expected_execution_mode.trim()
        : 'delegated_subagent';
    const executionMode = expectedExecutionMode === 'same_agent_fallback'
        ? 'same_agent_fallback'
        : 'delegated_subagent';
    const resolvedReviewerIdentity = executionMode === 'same_agent_fallback'
        ? `self:${taskId}`
        : reviewerIdentity;
    const reviewerFallbackReason = executionMode === 'same_agent_fallback'
        ? 'attested reviewer launch unavailable in direct provider session'
        : null;
    applyReviewerRoutingMetadata(reviewContextPath, {
        actualExecutionMode: executionMode,
        reviewerSessionId: resolvedReviewerIdentity,
        fallbackReason: reviewerFallbackReason
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
        reviewerExecutionMode: executionMode,
        reviewerIdentity: resolvedReviewerIdentity,
        reviewerFallbackReason,
        trustLevel: 'LOCAL_AUDITED'
    });
    fs.writeFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), JSON.stringify(receipt, null, 2) + '\n', 'utf8');
    return reviewContextPath;
}

export function writeHandshakeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
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

export function writeShellSmokeArtifact(repoRoot: string, taskId: string, provider = 'Codex'): void {
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

// ---------------------------------------------------------------------------
// Gate lifecycle helpers
// ---------------------------------------------------------------------------

export function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
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

export function loadPostPreflightRulePack(
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

export function runHandshakeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
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

export function runShellSmokeForTask(repoRoot: string, taskId: string, provider = 'Codex') {
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

export function prepareCurrentReviewPhase(repoRoot: string, taskId: string, preflightPath: string, provider = 'Codex'): void {
    const initAnswersPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    let seededSourceOfTruth = '';
    if (fs.existsSync(initAnswersPath) && fs.statSync(initAnswersPath).isFile()) {
        try {
            const payload = JSON.parse(fs.readFileSync(initAnswersPath, 'utf8')) as Record<string, unknown>;
            seededSourceOfTruth = typeof payload.SourceOfTruth === 'string' ? payload.SourceOfTruth.trim() : '';
        } catch {
            seededSourceOfTruth = '';
        }
    }
    const shouldPinExplicitProvider = !!provider && provider !== seededSourceOfTruth;
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: `Prepare review lifecycle for ${taskId}`,
        ...(shouldPinExplicitProvider
            ? { provider, routedTo: resolveAttestedTaskModeRoute(provider) }
            : {})
    });
    assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
    runHandshakeForTask(repoRoot, taskId, provider);
    runShellSmokeForTask(repoRoot, taskId, provider);
    assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
    writeCompilePassEvidence(repoRoot, taskId, preflightPath);
}

export function runExplicitPreflight(
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

// ---------------------------------------------------------------------------
// Timeline and task-queue helpers
// ---------------------------------------------------------------------------

export function readTaskTimelineEvents(repoRoot: string, taskId: string): Array<Record<string, unknown>> {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    return fs.readFileSync(timelinePath, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function findLastTimelineEventIndex(
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

export function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
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
