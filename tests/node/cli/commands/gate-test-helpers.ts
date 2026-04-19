/**
 * Shared test helpers for CLI gate tests.
 *
 * Extracted from gates.test.ts to enable reuse across gate-* test suites
 * without copy-paste drift. All exports are test-only utilities—none are
 * shipped in production builds.
 */

import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import {
    runCliMainWithHandling
} from '../../../../src/cli/main';
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

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getReviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

export function getOrchestratorRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator');
}

// ---------------------------------------------------------------------------
// Temp-repo builders
// ---------------------------------------------------------------------------

export function createTempRepo(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-gates-'));
    fs.mkdirSync(path.join(root, 'src'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(root, 'garda-agent-orchestrator', 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'const a = 1;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');
    seedRuleFiles(root);
    return root;
}

export function createWindowsBatchNodeFixture(
    scriptSource: string,
    options: { forwardArgs?: boolean } = {}
): { batchPath: string; cleanup: () => void } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-gates-'));
    const jsPath = path.join(root, 'payload.js');
    const batchPath = path.join(root, 'run-fixture.cmd');
    const forwardArgs = options.forwardArgs ? ' %*' : '';
    fs.writeFileSync(jsPath, `${scriptSource}\n`, 'utf8');
    fs.writeFileSync(batchPath, `@echo off\r\n"${process.execPath}" "${jsPath}"${forwardArgs}\r\n`, 'utf8');
    return {
        batchPath,
        cleanup() {
            fs.rmSync(root, { recursive: true, force: true });
        }
    };
}

export function createDependentValidationFixture(): {
    repoRoot: string;
    consumerPath: string;
    manifestPath: string;
    sourcePath: string;
    lockPath: string;
    nestedCwd: string;
    cleanup: () => void;
} {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-validation-chain-'));
    const sourcePath = path.join(repoRoot, 'src', 'feature.ts');
    const consumerPath = path.join(repoRoot, '.node-build', 'tests', 'node', 'sample.test.js');
    const manifestPath = path.join(repoRoot, '.node-build', 'node-foundation-manifest.json');
    const lockPath = path.join(repoRoot, '.node-build.lock');
    const nestedCwd = path.join(repoRoot, 'packages', 'feature');

    fs.mkdirSync(path.dirname(sourcePath), { recursive: true });
    fs.mkdirSync(path.dirname(consumerPath), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'tests', 'node'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'scripts', 'node-foundation'), { recursive: true });
    fs.mkdirSync(nestedCwd, { recursive: true });
    fs.writeFileSync(sourcePath, 'export const feature = true;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'tests', 'node', 'sample.test.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'scripts', 'node-foundation', 'helper.ts'), 'void 0;\n', 'utf8');
    fs.writeFileSync(consumerPath, 'import test from "node:test";\nimport assert from "node:assert/strict";\n\ntest("sample", () => { assert.equal(1, 1); });\n', 'utf8');

    return {
        repoRoot,
        consumerPath,
        manifestPath,
        sourcePath,
        lockPath,
        nestedCwd,
        cleanup: () => fs.rmSync(repoRoot, { recursive: true, force: true })
    };
}

// ---------------------------------------------------------------------------
// Rule & config seeding
// ---------------------------------------------------------------------------

export function seedRuleFiles(repoRoot: string): void {
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

export function writeNodeFoundationManifest(manifestPath: string): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        sourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
        files: ['tests/node/sample.test.js']
    }, null, 2) + '\n', 'utf8');
}

// ---------------------------------------------------------------------------
// Task-mode routing helpers
// ---------------------------------------------------------------------------

export function withDefaultTaskModeRouting<T extends { repoRoot?: string; provider?: unknown; routedTo?: unknown }>(options: T): T {
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

export function runEnterTaskMode(options: Parameters<typeof runEnterTaskModeCommand>[0]) {
    return runEnterTaskModeCommand(withDefaultTaskModeRouting(options));
}

// ---------------------------------------------------------------------------
// Reviewer routing fixture
// ---------------------------------------------------------------------------

export function createReviewerRoutingFixture(
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

export function writeReceiptBackedReviewArtifact(
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
            execution_provider_source: artifact.execution_provider_source ?? 'explicit_provider',
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
        ...(shouldPinExplicitProvider ? { provider, routedTo: PROVIDER_ENTRYPOINT_BY_SOURCE[provider] } : {})
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
// Git helpers
// ---------------------------------------------------------------------------

export function runGit(repoRoot: string, args: string[]): childProcess.SpawnSyncReturns<string> {
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

export function initializeGitRepo(repoRoot: string): void {
    runGit(repoRoot, ['init']);
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'test: baseline']);
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

// ---------------------------------------------------------------------------
// Capture / assertion helpers
// ---------------------------------------------------------------------------

export async function captureExpectedAsyncError(callback: () => Promise<void>): Promise<Error> {
    try {
        await callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
}

export async function runCliWithCapturedOutput(
    argv: readonly string[],
    options: { cwd?: string } = {}
): Promise<{ exitCode: number; logs: string[]; errors: string[] }> {
    const previousExitCode = process.exitCode;
    const previousCwd = process.cwd();
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const logs: string[] = [];
    const errors: string[] = [];
    process.exitCode = 0;
    console.log = (...args: unknown[]) => {
        logs.push(args.map((value) => String(value)).join(' '));
    };
    console.error = (...args: unknown[]) => {
        errors.push(args.map((value) => String(value)).join(' '));
    };
    try {
        process.chdir(path.resolve(options.cwd || '.'));
        await runCliMainWithHandling(Array.from(argv));
        return {
            exitCode: process.exitCode ?? 0,
            logs,
            errors
        };
    } finally {
        console.log = originalConsoleLog;
        console.error = originalConsoleError;
        process.chdir(previousCwd);
        process.exitCode = previousExitCode;
    }
}

// ---------------------------------------------------------------------------
// Misc utilities
// ---------------------------------------------------------------------------

export function ageFixturePath(filePath: string, ageMs: number): void {
    const agedDate = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, agedDate, agedDate);
}
