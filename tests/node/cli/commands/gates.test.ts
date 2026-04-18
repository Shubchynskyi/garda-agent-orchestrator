import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    EXIT_GATE_FAILURE,
    EXIT_GENERAL_FAILURE
} from '../../../../src/cli/exit-codes';
import {
    acquireFilesystemLock,
    releaseFilesystemLock
} from '../../../../src/gate-runtime/task-events-locking';
import * as gateReviewHandlers from '../../../../src/cli/commands/gate-review-handlers';
import { runBuildReviewContextCommand } from '../../../../src/cli/commands/gate-build-handlers';
import { syncTaskQueueStatus } from '../../../../src/cli/commands/gate-flows/gate-flow-helpers';
import {
    handleCompletionGate,
    handleEnterTaskMode
} from '../../../../src/cli/commands/gate-task-handlers';
import {
    runClassifyChangeCommand,
    runCompileGateCommand,
    runCommandTimeoutDiagnosticsCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runHandshakeDiagnosticsCommand,
    runHumanCommitCommand,
    runLoadRulePackCommand,
    runLogTaskEventCommand,
    runRecordNoOpCommand,
    runRestartCoherentCycleCommand,
    runRestartReviewCycleCommand,
    runRequiredReviewsCheckCommand,
    runShellSmokePreflightCommand,
    splitCommandLine,
    executeCommand,
    executeCommandAsync
} from '../../../../src/cli/commands/gates';
import {
    runCliMain,
    runCliMainWithHandling
} from '../../../../src/cli/main';
import { formatCompletionGateResult, runCompletionGate } from '../../../../src/gates/completion';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../../../src/gates/review-reuse';
import { serializeTaskPlan, validateTaskPlan } from '../../../../src/schemas/task-plan';
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

function captureExpectedError(callback: () => void): Error {
    try {
        callback();
    } catch (error) {
        assert.ok(error instanceof Error);
        return error;
    }
    assert.fail('Expected command to throw an error.');
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

function createWindowsBatchNodeFixture(
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

function createDependentValidationFixture(): {
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

function writeNodeFoundationManifest(manifestPath: string): void {
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({
        sourceRoots: ['src', 'tests/node', 'scripts/node-foundation'],
        files: ['tests/node/sample.test.js']
    }, null, 2) + '\n', 'utf8');
}

function ageFixturePath(filePath: string, ageMs: number): void {
    const agedDate = new Date(Date.now() - ageMs);
    fs.utimesSync(filePath, agedDate, agedDate);
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

function writeBudgetOutputFilters(repoRoot: string): string {
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

function backdateFileMtime(filePath: string, secondsAgo = 5): void {
    const older = new Date(Date.now() - (secondsAgo * 1000));
    fs.utimesSync(filePath, older, older);
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

function prepareCurrentReviewPhase(repoRoot: string, taskId: string, preflightPath: string, provider = 'Codex'): void {
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

describe('cli/commands/gates', () => {
    it('splits quoted command lines', () => {
        assert.deepEqual(
            splitCommandLine('node -e "console.log(\'ok\')"'),
            ['node', '-e', "console.log('ok')"]
        );
    });

    it('preserves backslashes in quoted Windows executable paths', () => {
        assert.deepEqual(
            splitCommandLine('"C:\\Program Files\\nodejs\\npm.cmd" --version'),
            ['C:\\Program Files\\nodejs\\npm.cmd', '--version']
        );
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
        assert.equal(fs.existsSync(outputPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails enter-task-mode early when planned scope includes protected orchestrator files without orchestrator-work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for protected planned scope',
                plannedChangedFiles: ['.github/agents/orchestrator.md']
            }));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: \\.github/agents/orchestrator\\.md\\.` +
                `.*Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'`,
                'i'
            )
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses the source-checkout CLI prefix in the orchestrator-work handoff command', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-source-checkout';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Require explicit orchestrator-work handoff for source-checkout protected scope',
                plannedChangedFiles: ['src/cli/main.ts']
            }));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: src/cli/main\\.ts\\.` +
                `.*Suggested command: node bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file 'src/cli/main\\.ts'`,
                'i'
            )
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runs enter-task-mode through CLI main and merges mixed planned scope hints', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-cli-main-smoke';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
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
                'enter-task-mode',
                '--repo-root', repoRoot,
                '--task-id', taskId,
                '--task-summary', 'Exercise the full CLI main path for mixed planned scope hints',
                '--provider', 'Codex',
                '--routed-to', 'AGENTS.md',
                '--planned-changed-file', 'src/app.ts',
                '--planned-changed-files', 'src/feature.ts,src/app.ts'
            ]);
        } finally {
            process.stdout.write = originalStdoutWrite;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const output = capturedStdout.join('');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(timelinePath), true);
        assert.match(output, /TASK_MODE_ENTERED/);
        assert.match(output, /PlannedChangedFilesCount: 2/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('parses --planned-changed-files through handleEnterTaskMode before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-alias';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Require explicit orchestrator-work handoff through the CLI alias path',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', '.github/agents/orchestrator.md'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Planned task scope includes protected orchestrator files: \\.github/agents/orchestrator\\.md\\.` +
                `.*Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--repo-root '${escapeRegExp(path.resolve(repoRoot))}'` +
                `.*--orchestrator-work` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'`,
                'i'
            )
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('deduplicates mixed planned scope hints before emitting the orchestrator-work handoff', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-merged-aliases';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Deduplicate mixed planned scope aliases before suggesting orchestrator-work handoff',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-file', '.github/agents/orchestrator.md',
            '--planned-changed-files', 'src/app.ts,.github/agents/orchestrator.md',
            '--planned-changed-file', 'src/app.ts'
        ]));
        assert.match(
            error.message,
            new RegExp(
                `Suggested command: node garda-agent-orchestrator/bin/garda\\.js gate enter-task-mode` +
                `.*--planned-changed-file '\\.github/agents/orchestrator\\.md'` +
                `.*--planned-changed-file 'src/app\\.ts'`,
                'i'
            )
        );
        assert.equal((error.message.match(/--planned-changed-file /g) || []).length, 2);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects invalid planned-changed-files lists that escape the repo root', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-handler-invalid-list';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = await captureExpectedAsyncError(() => handleEnterTaskMode([
            '--repo-root', repoRoot,
            '--task-id', taskId,
            '--task-summary', 'Reject planned changed files that escape repo root',
            '--provider', 'Codex',
            '--routed-to', 'AGENTS.md',
            '--planned-changed-files', 'src/app.ts,../outside.ts'
        ]));
        assert.match(error.message, /PlannedChangedFile must stay inside repo root/);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('allows enter-task-mode when protected planned scope is declared with orchestrator-work', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900planned-protected-allowed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow explicit orchestrator-work handoff for protected planned scope',
            orchestratorWork: true,
            plannedChangedFiles: ['.github/agents/orchestrator.md']
        });
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.includes('PlannedChangedFilesCount: 1'));
        assert.ok(result.outputLines.includes('PlannedProtectedFilesCount: 1'));
        assert.equal(artifact.orchestrator_work, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('captures a dirty workspace baseline when entering task mode', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-baseline';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = true;\n', 'utf8');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Capture dirty workspace baseline'
        });
        assert.equal(result.exitCode, 0);

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.deepEqual(
            artifact.dirty_workspace_baseline.changed_files,
            ['src/app.ts', 'src/unrelated.ts']
        );
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/app.ts'], 'string');
        assert.equal(typeof artifact.dirty_workspace_baseline.file_hashes['src/unrelated.ts'], 'string');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('loads rule-pack evidence and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        const result = loadTaskEntryRulePack(repoRoot, taskId);
        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));

        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'RULE_PACK_LOADED');
        assert.equal(artifact.event_source, 'load-rule-pack');
        assert.equal(artifact.stages.task_entry.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails preflight classification when rule-pack evidence is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.throws(
            () => runClassifyChangeCommand({
                repoRoot,
                changedFiles: ['src/app.ts'],
                taskId,
                taskIntent: 'Update app flow',
                emitMetrics: false
            }),
            /Rule-pack evidence missing/
        );

        const eventTypes = readTaskTimelineEvents(repoRoot, taskId).map((event) => event.event_type);
        assert.ok(eventTypes.includes('PREFLIGHT_STARTED'));
        assert.ok(eventTypes.includes('PREFLIGHT_FAILED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('auto-emits plan, status, and routing events when entering task mode', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });

        assert.equal(result.exitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const eventTypes = events.map((event) => event.event_type);
        assert.deepEqual(eventTypes, [
            'TASK_MODE_ENTERED',
            'PLAN_CREATED',
            'STATUS_CHANGED',
            'PROVIDER_ROUTING_DECISION'
        ]);
        const statusDetails = events[2].details as Record<string, unknown>;
        const routingDetails = events[3].details as Record<string, unknown>;
        assert.equal(statusDetails.previous_status, 'TODO');
        assert.equal(statusDetails.new_status, 'IN_PROGRESS');
        assert.equal(routingDetails.provider, 'Qwen');
        assert.equal(routingDetails.routed_to, 'QWEN.md');
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-900c\s*\|\s*🟨 IN_PROGRESS\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('syncTaskQueueStatus keeps plain TASK.md rows plain across lifecycle states', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-plain';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_PROGRESS'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_PROGRESS');
        let taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*IN_PROGRESS\s*\|/);
        assert.equal(taskFile.includes('🟨 IN_PROGRESS'), false);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'IN_REVIEW'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*IN_REVIEW\s*\|/);
        assert.equal(taskFile.includes('🟧 IN_REVIEW'), false);

        assert.equal(syncTaskQueueStatus(repoRoot, taskId, 'DONE'), true);
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'DONE');
        taskFile = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        assert.match(taskFile, /\|\s*T-900c-plain\s*\|\s*DONE\s*\|/);
        assert.equal(taskFile.includes('🟩 DONE'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses explicit provider override for task-mode routing evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-provider';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });

        assert.equal(result.exitCode, 0);
        const taskModeArtifact = JSON.parse(fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`), 'utf8'));
        const routingDetails = (readTaskTimelineEvents(repoRoot, taskId).at(-1)?.details || {}) as Record<string, unknown>;
        assert.equal(taskModeArtifact.provider, 'Codex');
        assert.equal(taskModeArtifact.routed_to, 'AGENTS.md');
        assert.equal(routingDetails.provider, 'Codex');
        assert.equal(routingDetails.routed_to, 'AGENTS.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects legacy fallback and does not reuse stale task-mode routing evidence on a new task-mode entry', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-stale-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(artifactPath), { recursive: true });
        fs.writeFileSync(artifactPath, JSON.stringify({
            schema_version: 1,
            timestamp_utc: '2026-04-17T08:00:00.000Z',
            event_source: 'enter-task-mode',
            status: 'PASS',
            outcome: 'PASS',
            task_id: taskId,
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'stale runtime identity',
            provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved',
            routed_to: 'QWEN.md'
        }, null, 2), 'utf8');

        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Refresh runtime identity without trusting stale task-mode evidence'
        }));

        assert.match(error.message, /Runtime execution identity is 'legacy_fallback' at task-mode entry/i);
        assert.doesNotMatch(error.message, /--provider\s+['"]?Codex['"]?/i);
        assert.match(error.message, /--provider <runtime-provider>|--routed-to/i);
        const staleArtifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(staleArtifact.provider, 'Qwen');
        assert.equal(staleArtifact.routed_to, 'QWEN.md');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when explicit runtime identity is contradictory', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-contradictory-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject contradictory runtime identity at task-mode entry',
            provider: 'Codex',
            routedTo: 'QWEN.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /contradicts routed path 'QWEN\.md'/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?QWEN\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit provider override is unrecognized even if routed identity resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-provider-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit provider override at task-mode entry',
            provider: 'NotAProvider',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /provider override 'NotAProvider' is not recognized/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when an explicit routed-to override is unrecognized even if provider resolves', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-invalid-route-override';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject malformed explicit routed-to override at task-mode entry',
            provider: 'Codex',
            routedTo: 'NOT-A-REAL-ROUTE.md'
        }));

        assert.match(error.message, /Runtime execution identity is 'contradictory' at task-mode entry/i);
        assert.match(error.message, /route override 'NOT-A-REAL-ROUTE\.md' is not a recognized provider bridge or canonical entrypoint/i);
        assert.match(error.message, /--provider ['"]?Codex['"]?/i);
        assert.doesNotMatch(error.message, /--routed-to ['"]?NOT-A-REAL-ROUTE\.md['"]?/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when runtime identity is missing', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-routing';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing runtime identity at task-mode entry'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.match(error.message, /setup\/reinit/i);
        assert.match(error.message, /--task-summary "<task-summary>"/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rejects enter-task-mode when canonical SourceOfTruth is missing even with explicit runtime identity', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-missing-canonical-owner';
        seedTaskQueue(repoRoot, taskId, 'TODO');

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const error = captureExpectedError(() => runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject task start when canonical owner files are missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        }));

        assert.match(error.message, /Canonical SourceOfTruth is missing at task-mode entry/i);
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rolls back task-mode artifact when TASK_MODE_ENTERED append fails', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        const lockPath = path.join(eventsRoot, `.${taskId}.lock`);
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: '2026-03-30T10:00:00.000Z'
        }, null, 2) + '\n', 'utf8');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /TASK_MODE_ENTERED/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails task-mode entry when the review artifact path is already locked', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900artifact-lock';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Codex');

        const artifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews', `${taskId}-task-mode.json`);
        const lockPath = `${artifactPath}.lock`;
        fs.mkdirSync(lockPath, { recursive: true });
        fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
            pid: process.pid,
            hostname: os.hostname(),
            created_at_utc: new Date().toISOString()
        }, null, 2) + '\n', 'utf8');

        assert.throws(
            () => runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Update app flow'
            }),
            /Timed out acquiring file lock/
        );
        assert.equal(fs.existsSync(artifactPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('runs compile gate and writes evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901';
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

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'compile-gate');
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'IMPLEMENTATION_STARTED'));

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
        assert.ok(result.outputLines.some((line) => line.includes('Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT')));
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
        assert.match(error.message, /Re-enter task mode with explicit --provider <runtime-provider> or --routed-to/i);
        assert.match(error.message, /enter-task-mode/i);

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
        assert.match(error.message, /Re-enter task mode with explicit --provider <runtime-provider> or --routed-to/i);
        assert.match(error.message, /command-timeout-diagnostics/i);

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
                    provider: 'Codex'
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
        assert.ok(result.outputLines.some((line) => line.includes('Run classify-change to completion before load-rule-pack --stage POST_PREFLIGHT')));

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

    it('fails compile gate when preflight already recorded trusted protected manifest drift before task start', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-manifest-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            triggers: {
                protected_control_plane_manifest_status: 'DRIFT',
                protected_control_plane_manifest_changed_files: ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-manifest-drift.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject ordinary compile on trusted manifest drift'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest was already drifted before task start')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when inherited protected baseline drift expands after preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-manifest-drift-expanded';
        const baselineProtectedPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md');
        const extraProtectedPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '40-commands.md');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(baselineProtectedPath, '# baseline protected drift\n', 'utf8');
        writeDriftedProtectedManifest(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Block manifest drift that expands beyond the inherited protected baseline'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Block manifest drift that expands beyond the inherited protected baseline',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(extraProtectedPath, '# expanded protected drift\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-manifest-drift-expanded.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

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
        assert.ok(result.outputLines.some((line) => line.includes('Trusted protected control-plane manifest drift detected before compile gate')));
        assert.ok(result.outputLines.some((line) => line.includes('garda-agent-orchestrator/live/docs/agent-rules/40-commands.md')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('applies budget tiers to compile gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-budget';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            budget_forecast: {
                task_id: taskId,
                requested_depth: 1,
                effective_depth: 1,
                depth_escalated: false,
                path_mode: 'FULL_PATH',
                changed_files_count: 1,
                changed_lines_total: 3,
                required_reviews: ['code'],
                review_budget_estimates: [],
                total_estimated_review_tokens: 400,
                compile_gate_estimated_tokens: 300,
                total_forecast_tokens: 700,
                token_economy_enabled: true,
                token_economy_active_for_depth: true,
                forecast_savings_estimate: 200,
                effective_forecast_tokens: 500
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const taskModeResult = runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(taskModeResult.exitCode, 0);
        assert.equal(taskModeResult.outputLines[0], 'TASK_MODE_ENTERED');
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_output_profile, 'compile_success_console');
        assert.equal(evidence.selected_budget_tier, 'tight');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task mode entry evidence is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901a';
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
        assert.ok(result.outputLines.some(line => line.includes('Task-mode entry evidence missing')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when a protected pre-existing dirty file changes outside explicit scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901dirty-protected';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedPath = path.join(repoRoot, 'src', 'unrelated.ts');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 34;\nconst b = 55;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedPath, 'export const unrelated = "before";\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protect unrelated dirty workspace edits'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Protect unrelated dirty workspace edits', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
        assert.deepEqual(preflight.triggers.dirty_workspace_protected_files, ['src/unrelated.ts']);

        fs.writeFileSync(unrelatedPath, 'export const unrelated = "after";\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-protected.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

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
        assert.ok(result.outputLines.some((line) => line.includes('Protected pre-existing workspace edits changed outside task scope')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('explains planned explicit preflight refresh steps when compile gate detects scope drift in a clean workspace', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-guidance';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Clarify planned explicit preflight drift recovery'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Clarify planned explicit preflight drift recovery', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

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
        assert.ok(result.outputLines.some((line) => line.includes('Preflight scope drift detected.')));
        assert.ok(result.outputLines.some((line) => line.includes('planned --changed-file inputs in a clean workspace')));
        assert.ok(result.outputLines.some((line) => line.includes('load-rule-pack --stage POST_PREFLIGHT')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('recovers from planned explicit preflight scope drift after rerunning classify-change and POST_PREFLIGHT rule-pack', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901scope-drift-recovery';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        initializeGitRepo(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Recover planned explicit preflight drift after real diff exists'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(repoRoot, taskId, 'Recover planned explicit preflight drift after real diff exists', ['src/app.ts']);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a + b);\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-scope-drift-recovery.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const firstCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(firstCompile.exitCode, EXIT_GATE_FAILURE);
        assert.ok(firstCompile.outputLines.some((line) => line.includes('Preflight scope drift detected.')));

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Recover planned explicit preflight drift after real diff exists',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, refreshedPreflightPath).exitCode, 0);

        const secondCompile = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(secondCompile.exitCode, 0);
        assert.equal(secondCompile.outputLines[0], 'COMPILE_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records sequence evidence on the successful sequential POST_PREFLIGHT and compile path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-sequence-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-sequence.md');
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
            taskSummary: 'Emit sequence evidence for successful sequential compile flow'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Emit sequence evidence for successful sequential compile flow',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const rulePackArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`), 'utf8')
        );
        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        );

        assert.equal(typeof rulePackArtifact.stages.post_preflight.preflight_event_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_preflight_sequence, 'number');
        assert.equal(typeof compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence, 'number');
        assert.ok(
            compileArtifact.post_preflight_sequence.latest_post_preflight_rule_pack_sequence
            > compileArtifact.post_preflight_sequence.latest_preflight_sequence
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent.md');
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
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0, JSON.stringify(reviewResult, null, 2));
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Equivalent preflight refresh keeps the same downstream rule-pack.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath: refreshedPreflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence from a custom artifact path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-path';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-path.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customRulePackPath = path.join(repoRoot, 'custom-artifacts', `${taskId}-rule-pack.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, customRulePackPath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse custom POST_PREFLIGHT rule-pack evidence',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            rulePackPath: customRulePackPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.evidence_path, customRulePackPath.replace(/\\/g, '/'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses binding-equivalent POST_PREFLIGHT rule-pack evidence with a custom task-mode path after an identical preflight refresh', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-binding-equivalent-custom-task-mode';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-post-preflight-binding-equivalent-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow equivalent preflight refresh to reuse POST_PREFLIGHT rule-pack evidence with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);
        assert.equal(compileResult.outputLines[0], 'COMPILE_GATE_PASSED');

        const compileArtifact = JSON.parse(
            fs.readFileSync(path.join(getReviewsRoot(repoRoot), `${taskId}-compile-gate.json`), 'utf8')
        ) as Record<string, unknown>;
        const postPreflightSequence = compileArtifact.post_preflight_sequence as Record<string, unknown>;
        const rulePackEvidence = compileArtifact.rule_pack as Record<string, unknown>;
        assert.equal(postPreflightSequence.binding_equivalent_to_current_preflight, true);
        assert.equal(rulePackEvidence.binding_equivalent_to_current_preflight, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance for a custom task-mode path when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap-custom-task-mode';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            artifactPath: customTaskModePath
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle with a custom task-mode path',
            ['src/app.ts'],
            `${taskId}-preflight.json`,
            customTaskModePath
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap-custom-task-mode.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: customTaskModePath,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit task-mode path differs from the timeline-recorded TASK_MODE_ENTERED artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateTaskModePath = path.join(repoRoot, 'copied-artifacts', `${taskId}-task-mode.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied task-mode artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied task-mode artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(alternateTaskModePath), { recursive: true });
        fs.copyFileSync(canonicalTaskModePath, alternateTaskModePath);

        const commandsPath = path.join(repoRoot, 'commands-task-mode-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            taskModePath: alternateTaskModePath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Task-mode entry evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when task-mode entry evidence omits pinned runtime identity metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-task-mode-identity-missing-at-compile';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject compile gate when task-mode identity metadata is missing',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject compile gate when task-mode identity metadata is missing',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const commandsPath = path.join(repoRoot, 'commands-task-mode-identity-missing-at-compile.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

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
        assert.ok(result.outputLines.some((line) => line.includes('missing canonical_source_of_truth')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when explicit POST_PREFLIGHT rule-pack path differs from the timeline-recorded artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-rule-pack-artifact-path-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const alternateRulePackPath = path.join(repoRoot, 'copied-artifacts', `${taskId}-rule-pack.json`);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject copied POST_PREFLIGHT rule-pack artifacts that differ from the timeline-recorded path',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        const canonicalRulePackPath = path.join(getReviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
        fs.mkdirSync(path.dirname(alternateRulePackPath), { recursive: true });
        fs.copyFileSync(canonicalRulePackPath, alternateRulePackPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-rule-pack-artifact-path-mismatch.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            rulePackPath: alternateRulePackPath,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Rule-pack evidence artifact path mismatch')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate with explicit unsafe parallelism guidance when a newer preflight supersedes POST_PREFLIGHT rule-pack evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-post-preflight-overlap';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);

        fs.writeFileSync(appPath, 'const a = 10;\nconst b = 2;\nconsole.log(a - b);\n', 'utf8');

        const refreshedPreflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale POST_PREFLIGHT rule-pack after a newer preflight cycle',
            ['src/app.ts']
        );
        assert.equal(refreshedPreflightPath, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-post-preflight-overlap.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const result = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath: refreshedPreflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'COMPILE_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('Do not parallelize classify-change, load-rule-pack --stage POST_PREFLIGHT, and compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails compile gate when the latest handshake supersedes shell smoke evidence for the current task cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-901-handshake-shell-smoke-overlap';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const commandsPath = path.join(repoRoot, 'commands-handshake-shell-smoke-overlap.md');
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
            taskSummary: 'Reject stale shell smoke evidence before compile'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Reject stale shell smoke evidence before compile',
            ['src/app.ts']
        );
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);

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
        assert.ok(result.outputLines.some((line) => line.includes('Unsafe same-task overlap detected')));
        assert.ok(result.outputLines.some((line) => line.includes('shell-smoke-preflight -> classify-change -> load-rule-pack --stage POST_PREFLIGHT -> compile-gate')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes doc-impact gate and writes artifact', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-902';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);

        const result = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Internal cleanup only, no public behavior change.',
            emitMetrics: false
        });

        const artifactPath = path.join(getReviewsRoot(repoRoot), `${taskId}-doc-impact.json`);
        const artifact = JSON.parse(fs.readFileSync(artifactPath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'DOC_IMPACT_GATE_PASSED');
        assert.equal(artifact.status, 'PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes required reviews gate with compile evidence and review artifact', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903';
        seedTaskQueue(repoRoot, taskId, '🟦 TODO');
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });

        // Telemetry must be in the timeline; writeCleanReviewArtifact handles it.

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(reviewsRoot, `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.event_source, 'required-reviews-check');
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'STATUS_CHANGED'
            && event.details
            && typeof event.details === 'object'
            && (event.details as Record<string, unknown>).new_status === 'IN_REVIEW'
        )));
        assert.equal(readTaskQueueStatusFromTaskFile(repoRoot, taskId), 'IN_REVIEW');
        assert.match(fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8'), /\|\s*T-903\s*\|\s*🟧 IN_REVIEW\s*\|/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

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

    it('defaults required review verdicts from preflight when CLI verdict flags are omitted', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-defaulted-verdicts';
        seedTaskQueue(repoRoot, taskId);
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
        const commandsPath = path.join(repoRoot, 'commands-defaulted-verdicts.md');
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
            taskSummary: 'Default required review verdicts from preflight'
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
        writeCleanReviewArtifact(repoRoot, taskId, 'test', 'TEST REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.equal(evidence.verdicts.code, 'REVIEW PASSED');
        assert.equal(evidence.verdicts.test, 'TEST REVIEW PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when a preflight-defaulted required review artifact is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-defaulted-verdicts-missing-artifact';
        seedTaskQueue(repoRoot, taskId);
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
        const commandsPath = path.join(repoRoot, 'commands-defaulted-verdicts-missing-artifact.md');
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
            taskSummary: 'Keep defaulted required reviews strict when artifacts are missing'
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

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.equal(evidence.verdicts.test, 'TEST REVIEW PASSED');
        assert.ok(result.outputLines.some((line) => line.includes("Review artifact not found for claimed 'TEST REVIEW PASSED'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when review artifact is missing mandatory findings sections', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-invalid-sections';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-invalid-sections.md');
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
            taskSummary: 'Reject schema-invalid review artifacts earlier'
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

        writeReceiptBackedReviewArtifact(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            [
                '# Review',
                '',
                'Validated `src/app.ts` and related wiring with enough implementation detail to look realistic, but this fixture intentionally uses the wrong section names so review-gate must reject it before completion-gate ever runs.',
                '',
                'REVIEW PASSED',
                '',
                '## Findings',
                'none',
                '',
                '## Residual',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ]
        );

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes("missing required section '## Findings by Severity'")));
        assert.ok(result.outputLines.some((line) => line.includes("missing required section '## Residual Risks'")));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails required reviews gate when review artifact is trivial even with valid receipt/context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-trivial-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-trivial-review.md');
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
            taskSummary: 'Reject trivial synthetic review artifacts earlier'
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

        writeReceiptBackedReviewArtifact(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            [
                '# Review',
                '',
                'REVIEW PASSED',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ]
        );

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        assert.equal(result.exitCode, EXIT_GATE_FAILURE);
        assert.equal(result.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(result.outputLines.some((line) => line.includes('trivial or obviously synthetic')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('applies budget tiers to review gate telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903-budget';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            budget_forecast: {
                task_id: taskId,
                requested_depth: 1,
                effective_depth: 1,
                depth_escalated: false,
                path_mode: 'FULL_PATH',
                changed_files_count: 1,
                changed_lines_total: 3,
                required_reviews: ['code'],
                review_budget_estimates: [],
                total_estimated_review_tokens: 400,
                compile_gate_estimated_tokens: 300,
                total_forecast_tokens: 700,
                token_economy_enabled: true,
                token_economy_active_for_depth: true,
                forecast_savings_estimate: 200,
                effective_forecast_tokens: 500
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-review-budget.md');
        const outputFiltersPath = writeBudgetOutputFilters(repoRoot);
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'budget ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Budget telemetry check'
        });
        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        writeCleanReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');

        const result = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });

        const evidencePath = path.join(getReviewsRoot(repoRoot), `${taskId}-review-gate.json`);
        const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
        assert.equal(result.exitCode, 0);
        assert.equal(evidence.status, 'PASSED');
        assert.equal(evidence.selected_budget_tier, 'tight');

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
            taskSummary: 'Restart the latest coherent cycle after misordered recovery noise'
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
        seedInitAnswers(repoRoot, 'Codex');
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
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.ok(lastCompileIndex >= 0);
        assert.ok(lastCodeReviewPhaseIndex > lastCompileIndex);
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

    it('restart-review-cycle reuses eligible code review evidence so downstream test review can be prepared in one command', { concurrency: false }, async () => {
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
        assert.equal(
            fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-test-review-context.json`)),
            true
        );

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const lastCompileIndex = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const lastCodeReviewRecordedIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const lastTestReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.ok(lastCompileIndex >= 0);
        assert.ok(lastCodeReviewRecordedIndex > lastCompileIndex);
        assert.ok(lastTestReviewPhaseIndex > lastCodeReviewRecordedIndex);

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

    it('requires audited no-op evidence before zero-diff completion can pass', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903b';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        const preflightPath = writePreflight(repoRoot, taskId, {
            metrics: { changed_lines_total: 0 },
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
            },
            changed_files: [],
            zero_diff_guard: {
                zero_diff_detected: true,
                status: 'BASELINE_ONLY',
                completion_requires_audited_no_op: true,
                no_op_artifact_suffix: '-no-op.json',
                rationale: 'Preflight on a clean workspace is baseline-only.'
            }
        });
        const commandsPath = path.join(repoRoot, 'commands-zero.md');
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
            taskSummary: 'Implement lifecycle hardening'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        // Review gate must fail when zero-diff preflight has no no-op artifact.
        const failedReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(failedReviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.ok(failedReviewResult.outputLines.some((line) => String(line).includes('zero-diff')));

        // Record a no-op artifact to satisfy the guard
        const noOpResult = runRecordNoOpCommand({
            repoRoot,
            taskId,
            preflightPath,
            classification: 'ALREADY_DONE',
            reason: 'Task behavior already matches the requested outcome after earlier local changes.',
            emitMetrics: false
        });
        assert.equal(noOpResult.exitCode, 0);

        // Review gate should now pass with no-op artifact
        const passedReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(passedReviewResult.exitCode, 0);

        // A later compile+review rerun must emit a fresh REVIEW_PHASE_STARTED
        // for the latest no-required-review cycle, otherwise completion would
        // incorrectly demand a missing same-cycle review phase.
        const rerunCompileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(rerunCompileResult.exitCode, 0);

        const rerunReviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(rerunReviewResult.exitCode, 0);
        assert.ok(
            readTaskTimelineEvents(repoRoot, taskId)
                .filter((event) => event.event_type === 'REVIEW_PHASE_STARTED').length >= 2
        );

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'No public docs impact.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        // Completion gate should pass — no-op artifact was already recorded above
        const passedCompletion = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(passedCompletion.outcome, 'PASS');
        assert.equal(passedCompletion.zero_diff_evidence.status, 'SATISFIED_BY_AUDITED_NO_OP');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('fails completion gate when a protected pre-existing dirty file changes after review passed', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903dirty-completion';
        const appPath = path.join(repoRoot, 'src', 'app.ts');
        const unrelatedPath = path.join(repoRoot, 'src', 'unrelated.ts');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);
        fs.writeFileSync(appPath, 'const a = 89;\nconst b = 144;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(unrelatedPath, 'export const unrelated = "baseline";\n', 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Protect unrelated dirty workspace edits through completion'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Protect unrelated dirty workspace edits through completion',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-dirty-completion.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

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

        fs.writeFileSync(unrelatedPath, 'export const unrelated = "mutated";\n', 'utf8');

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.outcome, 'FAIL');
        assert.ok(completionResult.violations.some((item: string) => item.includes('Protected pre-existing workspace edits changed outside task scope')));
        assert.equal(completionResult.dirty_workspace_protection_evidence.status, 'DRIFT_DETECTED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes completion gate when protected manifest drift is inherited baseline only', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-903manifest-drift-baseline-only';
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
            taskSummary: 'Allow inherited protected manifest drift through completion'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        const preflightPath = runExplicitPreflight(
            repoRoot,
            taskId,
            'Allow inherited protected manifest drift through completion',
            ['src/app.ts']
        );
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        const commandsPath = path.join(repoRoot, 'commands-manifest-drift-completion.md');
        const outputFiltersPath = path.resolve('live/config/output-filters.json');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

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
            rationale: 'Ordinary task scope stayed non-protected; no operator-facing docs changed.',
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
        assert.equal(completionResult.dirty_workspace_protection_evidence.status, 'PASS');
        assert.deepEqual(completionResult.isolation_mode_warnings, []);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('logs terminal task events with review-temp cleanup and command audit', () => {
        for (const eventType of ['TASK_DONE', 'TASK_BLOCKED'] as const) {
            const repoRoot = createTempRepo();
            const taskId = `T-904-${eventType.toLowerCase()}`;
            const reviewsRoot = getReviewsRoot(repoRoot);
            fs.mkdirSync(reviewsRoot, { recursive: true });
            const reviewTempRoot = path.join(repoRoot, '.review-temp');
            const stagedReviewOutputPath = path.join(reviewTempRoot, `${taskId}-code-output.md`);
            const foreignReviewOutputPath = path.join(reviewTempRoot, 'T-foreign-code-output.md');
            fs.mkdirSync(reviewTempRoot, { recursive: true });
            fs.writeFileSync(stagedReviewOutputPath, 'temporary reviewer output\n', 'utf8');
            fs.writeFileSync(foreignReviewOutputPath, 'leave unrelated reviewer output alone\n', 'utf8');
            const compileOutputPath = path.join(reviewsRoot, `${taskId}-compile-output.log`);
            fs.writeFileSync(compileOutputPath, 'temporary compile output\n', 'utf8');
            fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
                task_id: taskId,
                compile_output_path: `garda-agent-orchestrator/runtime/reviews/${taskId}-compile-output.log`
            }, null, 2), 'utf8');

            const result = runLogTaskEventCommand({
                repoRoot,
                taskId,
                eventType,
                outcome: eventType === 'TASK_DONE' ? 'PASS' : 'BLOCKED',
                detailsJson: JSON.stringify({
                    command: 'docker logs api',
                    command_mode: 'scan'
                })
            });

            const payload = JSON.parse(result.outputText);
            assert.equal(result.exitCode, 0);
            assert.equal(payload.status, 'TASK_EVENT_LOGGED');
            assert.equal(payload.command_policy_audit.warning_count > 0, true);
            assert.equal(payload.terminal_log_cleanup.deleted_paths.length, 1);
            assert.equal(payload.terminal_review_temp_cleanup.deleted_paths.length, 1);
            assert.equal(fs.existsSync(compileOutputPath), false);
            assert.equal(fs.existsSync(stagedReviewOutputPath), false);
            assert.equal(fs.existsSync(foreignReviewOutputPath), true);

            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('runs human commit through git with commit guard override', async () => {
        const repoRoot = createTempRepo();
    
        runGit(repoRoot, ['init']);
        runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
        runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
        runGit(repoRoot, ['add', '.']);

        const exitCode = await runHumanCommitCommand(['-m', 'test: initial commit'], { cwd: repoRoot });
        const logResult = childProcess.spawnSync('git', ['log', '--oneline', '-1'], {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore']
        });

        assert.equal(exitCode, 0);
        assert.match(logResult.stdout, /test: initial commit/);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing updates review-context routing metadata and emits delegated telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:test-reviewer');
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes delegated reviewer output into canonical artifact and receipt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/app.ts` and the delegated review ingestion path with concrete routing, receipt, and artifact persistence details so this reviewer output is realistic and non-trivial.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.existsSync(reviewOutputPath), false);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('## Verdict\nREVIEW PASSED'));
        assert.ok(fs.readFileSync(rawReviewOutputPath, 'utf8').includes('## Verdict\nREVIEW PASSED'));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: path')));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts legacy review-context identity when task-mode runtime identity is backfilled safely', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-legacy-backfill';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Record a review against a legacy provider-bridge review-context after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, taskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

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
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', taskModePath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const crypto = require('node:crypto');
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            schema_version: 2,
            task_id: taskId,
            review_type: 'code',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: preflightSha256,
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/review-context-routing.ts`, and the legacy provider-bridge resume path, confirming that legacy review-context routing metadata can still be materialized after runtime identity is safely backfilled from a provider bridge while receipt, routing telemetry, and canonical artifact writes remain bound to the active preflight and task-mode evidence.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-context-path', reviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.source_of_truth, 'Codex');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result accepts stdin reviewer output only through the same audited raw-artifact path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-stdin';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const stdinReviewOutput = [
            '# Review',
            '',
            'Validated direct stdin ingestion while keeping `src/cli/commands/gate-review-handlers.ts` and `garda-agent-orchestrator/runtime/reviews/*-review-output.md` on the same audited raw-artifact path, with concrete receipt and routing persistence details. Reviewed the raw artifact rewrite, verdict extraction, context binding, and receipt emission flow so this fixture remains realistic and non-trivial.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n');

        const mutableGateReviewHandlers = gateReviewHandlers as typeof gateReviewHandlers & {
            readReviewOutputFromStdin: typeof gateReviewHandlers.readReviewOutputFromStdin;
        };
        const originalReadReviewOutputFromStdin = mutableGateReviewHandlers.readReviewOutputFromStdin;
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        mutableGateReviewHandlers.readReviewOutputFromStdin = async () => stdinReviewOutput;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            mutableGateReviewHandlers.readReviewOutputFromStdin = originalReadReviewOutputFromStdin;
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.equal(fs.readFileSync(rawReviewOutputPath, 'utf8'), stdinReviewOutput);
        assert.ok(capturedLogs.some((line) => line.includes('ReviewOutputMode: stdin')));
        assert.ok(capturedLogs.some((line) => line.includes(`ReviewOutputPath: ${rawReviewOutputPath.replace(/\\/g, '/')}`)));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects dual review-output sources to avoid a weaker ingestion path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-dual-input';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--review-output-stdin',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes failed reviewer output with active findings when lifecycle sections are present', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that failed reviewer verdicts are still materialized as canonical evidence for the release gate.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` reviewer intentionally failed this artifact to exercise the failed-verdict ingestion path.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            '- REVIEW FAILED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleLog = console.log;
        const capturedLogs: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.log = (...args: unknown[]) => {
            capturedLogs.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.log = originalConsoleLog;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('## Verdict\n- REVIEW FAILED'));
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('High: `src/app.ts:1` reviewer intentionally failed this artifact'));
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW FAILED')));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result keeps failed reviewer output materializable when residual risks remain explicit', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed-risks';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that failed reviewer verdicts with explicit unresolved risk detail still materialize as canonical evidence while the task remains blocked from completion.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` the reviewer found a blocking issue and intentionally kept the review in a failed state.',
            '',
            '## Residual Risks',
            '- Integration rerun is still pending for `tests/node/cli/commands/gates.test.ts`, so follow-up work remains open until the blocker is fixed.',
            '',
            '## Verdict',
            'REVIEW FAILED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        assert.equal(fs.existsSync(artifactPath), true);
        assert.equal(fs.existsSync(receiptPath), true);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('Integration rerun is still pending'));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects reviewer output without a recognized verdict token before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-no-verdict';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'This artifact intentionally omits the canonical verdict token.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            '- APPROVED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(fs.readFileSync(rawReviewOutputPath, 'utf8').includes('- APPROVED'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects trivial passed reviewer output before routing or receipt materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-trivial-pass';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Short pass.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes('trivial or obviously synthetic')));
        assert.ok(capturedErrors.some((line) => line.includes('Minimal compliant PASS review template')));
        assert.ok(capturedErrors.some((line) => line.includes('## Findings by Severity')));
        assert.ok(capturedErrors.some((line) => line.includes('## Residual Risks')));
        assert.ok(capturedErrors.some((line) => line.includes('## Verdict')));
        assert.ok(capturedErrors.some((line) => line.includes('REVIEW PASSED')));
        assert.ok(capturedErrors.some((line) => line.includes('Deferred Findings')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects passed reviewer output that still carries active findings', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-findings';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the materialization guard against a synthetic pass artifact that still reports active code-review findings.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this reviewer intentionally kept an unresolved blocker while claiming a pass verdict.',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes('still contains active High findings')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result explains no-findings pass review recovery when residual risks are missing and deferred findings lack justification', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-pass-no-findings-recovery';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the no-findings pass-review materialization path with concrete scope notes and enough detail to stay above the trivial-review threshold while still keeping the artifact intentionally malformed for recovery guidance.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            '- [low] follow up on reviewer wording in `src/cli/commands/gate-review-handlers.ts:1`',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes("missing required section '## Residual Risks'")));
        assert.ok(capturedErrors.some((line) => line.includes("has deferred finding without usable 'Justification:'")));
        assert.ok(capturedErrors.some((line) => line.includes('No-findings PASS review recovery:')));
        assert.ok(capturedErrors.some((line) => line.includes("Add mandatory section '## Residual Risks' and set it to 'none' when no active risks remain.")));
        assert.ok(capturedErrors.some((line) => line.includes("Every '## Deferred Findings' entry must include 'Justification:'.")));
        assert.ok(capturedErrors.some((line) => line.includes('Minimal compliant PASS review template for a no-findings review')));
        assert.ok(capturedErrors.some((line) => line.includes('## Deferred Findings')));
        assert.ok(capturedErrors.some((line) => line.includes('REVIEW PASSED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects failed reviewer output that omits required lifecycle sections', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed-missing-section';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const rawReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated that a failed verdict still needs the canonical lifecycle sections before it can become auditable evidence.',
            '',
            '## Findings by Severity',
            '- High: `src/app.ts:1` this failed review is intentionally missing residual-risk lifecycle evidence.',
            '',
            '## Verdict',
            'REVIEW FAILED'
        ].join('\n'), 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        process.exitCode = 0;
        let observedExitCode = 0;
        console.error = (...args: unknown[]) => {
            capturedErrors.push(args.map((value) => String(value)).join(' '));
        };
        try {
            process.chdir(repoRoot);
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(rawReviewOutputPath), true);
        assert.ok(capturedErrors.some((line) => line.includes("missing required section '## Residual Risks'")));
        assert.ok(!capturedErrors.some((line) => line.includes('Minimal compliant PASS review template')));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result records same_agent_fallback routing and receipt through the public CLI path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-fallback';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated fallback-mode ingestion through `src/cli/commands/gate-review-handlers.ts`, confirming that same-agent fallback still writes the canonical artifact, routing metadata, and receipt without bypassing delegated review controls. The fixture also references the fallback routing contract and receipt persistence behavior so the review text is clearly substantive.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(receipt.reviewer_execution_mode, 'same_agent_fallback');
        assert.equal(receipt.reviewer_identity, `self:${taskId}`);
        assert.equal(receipt.reviewer_fallback_reason, 'provider bridge does not expose subagent routing');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'same_agent_fallback');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, `self:${taskId}`);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, 'provider bridge does not expose subagent routing');
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rolls back artifact and routing metadata when delegation telemetry cannot be recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-routing-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated rollback semantics when routing telemetry cannot be appended.',
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
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-code-review-output.md`)), true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(taskEventsRoot, `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects non-canonical preflight paths before materialization', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-preflight';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writePreflight(repoRoot, taskId);
        const customPreflightPath = path.join(repoRoot, 'custom-preflight.json');
        fs.writeFileSync(customPreflightPath, JSON.stringify({
            task_id: taskId,
            required_reviews: { code: true }
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, '# Review\n\n## Verdict\nREVIEW PASSED\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', customPreflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const events = fs.existsSync(timelinePath) ? readTaskTimelineEvents(repoRoot, taskId) : [];
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result preserves artifact materialization but fails cleanly when receipt path is locked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated the receipt-lock failure path with realistic delegated reviewer output, including `src/cli/commands/gate-review-handlers.ts` and the canonical review receipt persistence path so the fixture stays non-trivial while exercising the lock failure. The review text intentionally covers artifact materialization, routing, and locked receipt emission behavior in one cohesive scenario.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            const lockPath = `${receiptPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), true);
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('Validated the receipt-lock failure path'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(fs.existsSync(reviewOutputPath), true);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context rejects late review preparation after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-late-build';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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

    it('reuses prior code-review evidence when a rerun keeps the code scope unchanged', async () => {
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

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review evidence when only test scope changes'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        writeCompilePassEvidence(repoRoot, taskId, priorPreflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:code-reviewer');
        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'historical code review started', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review delegated', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical code review recorded', {
            review_type: 'code',
            reused_existing_review: false
        });
        const legacyReceiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const legacyReceipt = JSON.parse(fs.readFileSync(legacyReceiptPath, 'utf8')) as Record<string, unknown>;
        delete legacyReceipt.review_context_reuse_sha256;
        fs.writeFileSync(legacyReceiptPath, JSON.stringify(legacyReceipt, null, 2) + '\n', 'utf8');
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
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const refreshedReceipt = JSON.parse(fs.readFileSync(legacyReceiptPath, 'utf8')) as Record<string, unknown>;
        const crypto = require('node:crypto');
        const expectedPreflightSha = crypto.createHash('sha256').update(fs.readFileSync(preflightPath, 'utf8')).digest('hex');
        const expectedContextReuseSha = computeReviewContextReuseHash(reviewContext as Record<string, unknown>);
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(refreshedReceipt.preflight_sha256, expectedPreflightSha);
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot).code_scope_sha256
        );
        assert.equal(refreshedReceipt.review_context_reuse_sha256, expectedContextReuseSha);
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
        assert.ok(recordedEvents.some(({ index }) => index > latestCompileSequence));
        assert.equal((recordedEvents.at(-1)?.event.details as Record<string, unknown>).reused_existing_review, true);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Reuse regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a pure test-only rerun', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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

    it('does not reuse prior code-review evidence when the runtime reviewer identity changes for the same code scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-runtime-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical code review delegated', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:code-reviewer',
            delegation_used: true
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

        assert.equal(observedExitCode, 0);
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
        seedInitAnswers(repoRoot, 'Codex');
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
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const codeEvents = events.filter((event) => (
            (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(codeEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when compile evidence does not belong to the current preflight', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-stale-compile-evidence';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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

        assert.equal(observedExitCode, 0);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const codeEvents = events.filter((event) => (
            (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEW_RECORDED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(codeEvents.length, 0);
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

        assert.equal(observedExitCode, 0);
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

    it('record-review-receipt rejects unsupported reviewer execution modes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904x';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904x',
            '## Summary',
            'Verified `src/app.ts` delegated routing wiring with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_magic',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects delegated mode without pre-recorded routing evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y',
            '## Summary',
            'Verified `src/app.ts` delegated routing wiring with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects stale routing telemetry replayed from a prior cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-stale-routing-replay';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const priorPreflightPath = writePreflight(repoRoot, taskId, {
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
        prepareCurrentReviewPhase(repoRoot, taskId, priorPreflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Historical review phase started.', {
            review_type: 'code'
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Historical code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });

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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Current review phase started.', {
            review_type: 'code'
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-stale-routing-replay',
            '## Summary',
            'Verified stale routing replay handling with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCodeReviewPhaseIndex = findLastTimelineEventIndex(events, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const matchingRoutingIndices = events
            .map((event, index) => ({ event, index }))
            .filter(({ event }) => (
                event.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && String((event.details as Record<string, unknown> | undefined)?.reviewer_session_id || '') === 'agent:test-reviewer'
            ))
            .map(({ index }) => index);
        assert.ok(latestCodeReviewPhaseIndex >= 0);
        assert.ok(matchingRoutingIndices.some((index) => index < latestCodeReviewPhaseIndex));
        assert.equal(matchingRoutingIndices.some((index) => index > latestCodeReviewPhaseIndex), false);

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects superseded same-cycle routing telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-superseded-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Earlier same-cycle code review routed.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'Later same-cycle code review rerouted to a different reviewer.', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:new-reviewer',
            delegation_used: true
        });

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-superseded-routing',
            '## Summary',
            'Verified that superseded same-cycle routing telemetry cannot be replayed by tampering the review-context back to an older reviewer identity.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects same-agent fallback without a required fallback reason', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-fallback-reason';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-fallback-reason',
            '## Summary',
            'Verified fallback receipt policy enforcement with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'same_agent_fallback',
            reviewerSessionId: `self:${taskId}`,
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'fallback routed without reason', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects fallback reasons that diverge from pre-recorded routing metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-fallback-mismatch';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-fallback-mismatch',
            '## Summary',
            'Verified receipt fallback binding enforcement with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'same_agent_fallback',
            reviewerSessionId: `self:${taskId}`,
            fallbackReason: 'provider limitation'
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'fallback routed with canonical reason', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            reviewer_fallback_reason: 'provider limitation',
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered fallback'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects delegated_subagent for single-agent providers', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-single-agent';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Qwen');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-single-agent',
            '## Summary',
            'Verified delegated receipt rejection for a single-agent provider with realistic detail.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Qwen', {
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback',
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: 'agent:test-reviewer',
            fallbackReason: null
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated routing recorded for single-agent fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects tampered fallback policy fields when active runtime provider forbids fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-receipt-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904y-receipt-policy-tamper',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts` and the receipt-side routing enforcement path with enough implementation detail to prove that forged review-context policy fields cannot force same-agent fallback on Codex.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Deferred Findings',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'same_agent_fallback',
            reviewerSessionId: `self:${taskId}`,
            fallbackReason: 'tampered review-context policy'
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'tampered fallback routed for receipt fixture', {
            review_type: 'code',
            reviewer_execution_mode: 'same_agent_fallback',
            reviewer_session_id: `self:${taskId}`,
            reviewer_fallback_reason: 'tampered review-context policy',
            delegation_used: false
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered review-context policy'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath.replace(/\.md$/, '-receipt.json')), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects tampered fallback policy fields when active runtime provider forbids fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered review-context policy'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects delegated_subagent with a self-scoped reviewer identity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-routing-self-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', `self:${taskId}`
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects tampered fallback policy fields when active runtime provider forbids fallback', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-result-policy-tamper';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/reviewer-routing.ts`, and the current routing/receipt enforcement path to confirm that tampered review-context policy fields cannot force same-agent fallback on a delegation-required provider. The fixture is intentionally implementation-aware, references concrete files, and documents the guardrail behavior in enough detail to stay well above the trivial-review filter.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'tampered review-context policy'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(artifactPath), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result rejects same_agent_fallback with an agent-scoped reviewer identity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-result-agent-identity';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');

        const reviewOutputDir = path.join(repoRoot, '.review-temp');
        const reviewOutputPath = path.join(reviewOutputDir, `${taskId}-code-output.md`);
        fs.mkdirSync(reviewOutputDir, { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated fallback identity authenticity in the public result-ingest path with concrete implementation detail and realistic wording.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-output-path', reviewOutputPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', 'agent:test-reviewer',
                '--reviewer-fallback-reason', 'provider limitation'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(path.join(getReviewsRoot(repoRoot), `${taskId}-code.md`)), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects late routing after the review gate already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904y-late-routing';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('records fallback routing and receipt through the public CLI path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z',
            '## Summary',
            'Verified fallback reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(observedExitCode, 0);
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8'));
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(receipt.reviewer_execution_mode, 'same_agent_fallback');
        assert.equal(receipt.reviewer_identity, `self:${taskId}`);
        assert.equal(receipt.reviewer_fallback_reason, 'provider bridge does not expose subagent routing');
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'same_agent_fallback');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, `self:${taskId}`);
        assert.equal(reviewContext.reviewer_routing.fallback_reason, 'provider bridge does not expose subagent routing');
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt fails when the receipt artifact path is already locked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-lock';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
        const preflightPath = writePreflight(repoRoot, taskId);
        prepareCurrentReviewPhase(repoRoot, taskId, preflightPath, 'Antigravity');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z-lock',
            '## Summary',
            'Verified fallback reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity')
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);

            const lockPath = `${receiptPath}.lock`;
            fs.mkdirSync(lockPath, { recursive: true });
            fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                created_at_utc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge does not expose subagent routing'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(receiptPath), false);
        assert.ok(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects late receipt recording after completion already passed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904z-late-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(artifactPath, [
            '# Code Review T-904z-late-receipt',
            '## Summary',
            'Verified delegated reviewer routing with concrete implementation detail and realistic wording.',
            '## Findings by Severity',
            'none',
            '## Residual Risks',
            'none',
            '## Verdict',
            'REVIEW PASSED'
        ].join('\n'), 'utf8');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:test-reviewer'
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer',
            delegation_used: true
        });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'COMPLETION_GATE_PASSED', 'PASS', 'Completion gate passed.', {});

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        assert.equal(fs.existsSync(receiptPath), false);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.some((event) => event.event_type === 'REVIEW_RECORDED'), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing rejects delegated_subagent for single-agent providers', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904za';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Qwen', {
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback',
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        let observedExitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(observedExitCode !== 0, `Expected non-zero exit code, got ${observedExitCode}`);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const hasRoutingEvent = fs.existsSync(timelinePath)
            ? readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED')
            : false;
        assert.equal(hasRoutingEvent, false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('passes required review and completion flow for delegated test review evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId, {
            required_reviews: {
                code: false,
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
            taskSummary: 'Validate delegated test review flow',
            routedTo: 'AGENTS.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'test'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Test Review',
            '',
            'Verified changes in `src/app.ts`. This review artifact content has been extended with more words to ensure it strictly passes the newly introduced triviality check, which demands at least thirty words if there are no meaningful findings or risks.',
            '',
            'TEST REVIEW PASSED',
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
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'test',
            reviewer_routing: createReviewerRoutingFixture('Codex')
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'testing-strategy' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/testing-strategy/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'test',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            testReviewVerdict: 'TEST REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');
        assert.ok(reviewResult.outputLines.includes('TrustStatus: LOCAL_AUDITED'));

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises delegated test review only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');
        assert.equal(completionResult.review_artifacts?.test?.receipt?.trust_level, 'LOCAL_AUDITED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context blocks downstream test review until current-cycle code review is recorded', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-sequenced-test-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        const commandsPath = path.join(repoRoot, 'commands-sequenced-review.md');
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
            taskSummary: 'Block downstream test review until code review is recorded',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context-blocked.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped-blocked.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        const testReviewScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped.json`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let blockedExitCode = 0;
        let blockedAttemptTestPhaseCount = 0;
        let blockedErrorOutput = '';
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
            blockedAttemptTestPhaseCount = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )).length;
            blockedErrorOutput = blockedErrors.join('\n');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', codeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/completion.ts` and `src/cli/commands/gate-build-handlers.ts`, confirming that current-cycle upstream review evidence is present before downstream test review preparation is allowed to continue.',
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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', testReviewScopedDiffPath,
                '--output-path', testReviewContextPath
            ]);
            testReviewBuildExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.equal(blockedAttemptTestPhaseCount, 0);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('Run and record those reviews first.'),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('code: no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);
        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(fs.existsSync(codeReviewContextPath), true);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(fs.existsSync(testReviewContextPath), true);
        assert.equal(fs.existsSync(testReviewScopedDiffPath), false);

        const testReviewPhaseEvents = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.equal(testReviewPhaseEvents.length, 1);
        const allEvents = readTaskTimelineEvents(repoRoot, taskId);
        const codeReviewRecordedIndex = findLastTimelineEventIndex(allEvents, (event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        const testReviewPhaseIndex = findLastTimelineEventIndex(allEvents, (event) => (
            event.event_type === 'REVIEW_PHASE_STARTED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.ok(codeReviewRecordedIndex >= 0);
        assert.ok(testReviewPhaseIndex > codeReviewRecordedIndex);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context keeps downstream test review blocked when upstream code review is not gate-eligible', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-sequenced-test-review-invalid-code';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        const commandsPath = path.join(repoRoot, 'commands-sequenced-review-invalid.md');
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
            taskSummary: 'Keep downstream test review blocked until upstream code review is gate-eligible',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context-blocked.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-test-scoped-blocked.json`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let blockedExitCode = 0;
        let blockedAttemptTestPhaseCount = 0;
        let blockedErrorOutput = '';
        try {
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
            codeReviewBuildExitCode = process.exitCode ?? 0;

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Looks good.',
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
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = process.exitCode ?? 0;

            process.exitCode = 0;
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
            blockedAttemptTestPhaseCount = readTaskTimelineEvents(repoRoot, taskId).filter((event) => (
                event.event_type === 'REVIEW_PHASE_STARTED'
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )).length;
            blockedErrorOutput = blockedErrors.join('\n');
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.ok(codeReviewRecordExitCode !== 0, `Expected invalid upstream code review to be rejected, got ${codeReviewRecordExitCode}`);
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.equal(blockedAttemptTestPhaseCount, 0);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result blocks downstream test review materialization until upstream code review passes current cycle', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-record-test-review-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        const commandsPath = path.join(repoRoot, 'commands-record-review-blocked.md');
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
            taskSummary: 'Block downstream test review materialization until upstream code review passes current cycle',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-manual-test-context.json`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const testReviewArtifactPath = path.join(reviewsRoot, `${taskId}-test.md`);
        const testReviewReceiptPath = testReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(testReviewContextPath, JSON.stringify({
            review_type: 'test',
            reviewer_routing: createReviewerRoutingFixture('Codex', {
                capability_level: 'delegation_capable'
            })
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(testReviewOutputPath, [
            '# Review',
            '',
            'Validated the downstream test-review materialization path against current-cycle review sequencing evidence, including `src/gates/review-dependencies.ts` and the `T-904b-record-test-review-blocked-test-review-context.json` binding that should stay blocked until code review passes. The review body also calls out current-cycle receipt binding and dependency ordering so it is substantive even with no active findings.',
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

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        process.exitCode = 0;
        let blockedExitCode = 0;
        try {
            process.chdir(repoRoot);
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            blockedExitCode = process.exitCode ?? 0;
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const blockedErrorOutput = blockedErrors.join('\n');
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('code: no REVIEW_RECORDED evidence after the latest COMPILE_GATE_PASSED'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(testReviewArtifactPath), false);
        assert.equal(fs.existsSync(testReviewReceiptPath), false);
        assert.equal(readTaskTimelineEvents(repoRoot, taskId).some((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        )), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context accepts upstream code review evidence recorded with an explicit custom review-context path', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-code-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        const commandsPath = path.join(repoRoot, 'commands-custom-code-context.md');
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
            taskSummary: 'Allow downstream test review after code review was recorded from a custom context path',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-code-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        let testReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-build-handlers.ts`, `src/gates/review-dependencies.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that current-cycle upstream review readiness now follows recorded review-context paths and that downstream sequencing is enforced consistently across both preparation and materialization gates.',
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
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', testReviewContextPath
            ]);
            testReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(testReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gates-artifacts.ts`, and `src/gates/completion.ts`, confirming that downstream review validation now follows the recorded custom code review-context path through materialization, review-gate verification, and completion-gate consumption.',
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

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', testReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            testReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(testReviewRecordExitCode, 0);
        assert.equal(fs.existsSync(customCodeReviewContextPath), true);
        assert.equal(fs.existsSync(testReviewContextPath), true);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
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
            rationale: 'Custom review-context path is an internal gate-contract regression fixture.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check and completion prefer canonical review-context artifacts over stale legacy default files', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-canonical-review-context-preferred';
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
        const commandsPath = path.join(repoRoot, 'commands-canonical-review-context-preferred.md');
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
            taskSummary: 'Prefer canonical review-context artifacts over stale legacy default files',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyContextPath = path.join(reviewsRoot, `${taskId}-code-context.json`);
        const reviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let recordExitCode = 0;
        try {
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

            fs.writeFileSync(reviewOutputPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gates-artifacts.ts`, `src/gates/completion.ts`, and `src/gates/required-reviews-check.ts`, confirming that review gates now resolve the canonical review-context artifact deterministically and ignore stale legacy default siblings.',
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
                '--review-context-path', canonicalContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            recordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(recordExitCode, 0);

        const canonicalContext = JSON.parse(fs.readFileSync(canonicalContextPath, 'utf8')) as Record<string, unknown>;
        const staleLegacyContext = {
            ...canonicalContext,
            preflight_sha256: 'stale-legacy-hash',
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:stale-legacy-reviewer'
            }
        };
        fs.writeFileSync(legacyContextPath, JSON.stringify(staleLegacyContext, null, 2) + '\n', 'utf8');

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
            rationale: 'Canonical review-context path selection is an internal gate-contract change.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context, record-review-result, required-reviews-check, and completion honor an explicit custom task-mode artifact path end-to-end', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-end-to-end';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode artifact path across review and closeout gates',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-code-review-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(customCodeReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/build-review-context.ts`, `src/cli/commands/gate-review-handlers.ts`, `src/cli/commands/gate-flows/review-flow.ts`, and `src/gates/completion.ts`, confirming that the explicit custom task-mode artifact path remains authoritative through review materialization, review-gate verification, and completion-gate closeout even when a conflicting default task-mode artifact exists.',
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
                '--task-mode-path', customTaskModePath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
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
            rationale: 'Custom task-mode path regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context and record-review-result honor explicit custom task-mode paths for downstream test-review dependency checks', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-downstream-test';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
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

        runEnterTaskMode({
            repoRoot,
            taskId,
            artifactPath: customTaskModePath,
            taskSummary: 'Honor an explicit custom task-mode path when unblocking downstream test review',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for downstream custom task-mode dependency regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const driftedDefaultTaskMode = JSON.parse(fs.readFileSync(customTaskModePath, 'utf8')) as Record<string, unknown>;
        driftedDefaultTaskMode.provider = 'Codex';
        driftedDefaultTaskMode.routed_to = 'AGENTS.md';
        driftedDefaultTaskMode.canonical_source_of_truth = 'Codex';
        driftedDefaultTaskMode.execution_provider = 'Codex';
        driftedDefaultTaskMode.execution_provider_source = 'task_mode.provider';
        driftedDefaultTaskMode.runtime_identity_status = 'resolved';
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify(driftedDefaultTaskMode, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const customCodeReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-code-context.json');
        const customTestReviewContextPath = path.join(reviewsRoot, 'custom-task-mode-downstream-test-context.json');
        const codeReviewOutputPath = path.join(reviewsRoot, `${taskId}-code-review-output.md`);
        const testReviewOutputPath = path.join(reviewsRoot, `${taskId}-test-review-output.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let codeReviewBuildExitCode = 0;
        let codeReviewRecordExitCode = 0;
        let testReviewBuildExitCode = 0;
        let testReviewRecordExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(codeReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that upstream code-review evidence remains bound to the explicit custom task-mode artifact path even when a drifted default task-mode artifact exists.',
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
                '--task-mode-path', customTaskModePath,
                '--review-output-path', codeReviewOutputPath,
                '--review-context-path', customCodeReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            codeReviewRecordExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', customTestReviewContextPath
            ]);
            testReviewBuildExitCode = Number(process.exitCode ?? 0);

            const builtTestReviewContext = JSON.parse(fs.readFileSync(customTestReviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtTestReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');

            fs.writeFileSync(testReviewOutputPath, [
                '# Review',
                '',
                'Validated `src/gates/review-dependencies.ts`, `src/cli/commands/gate-build-handlers.ts`, and `src/cli/commands/gate-review-handlers.ts`, confirming that downstream test-review dependency checks now stay bound to the explicit custom task-mode artifact path instead of falling back to a drifted default task-mode artifact.',
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

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-result',
                '--task-id', taskId,
                '--review-type', 'test',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--review-output-path', testReviewOutputPath,
                '--review-context-path', customTestReviewContextPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:test-reviewer'
            ]);
            testReviewRecordExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(codeReviewBuildExitCode, 0);
        assert.equal(codeReviewRecordExitCode, 0);
        assert.equal(testReviewBuildExitCode, 0);
        assert.equal(testReviewRecordExitCode, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-routing and record-review-receipt honor an explicit custom task-mode artifact path when the default artifact drifts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-routing-receipt';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Honor explicit custom task-mode evidence across split routing and receipt recording',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for split routing and receipt custom task-mode path regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        fs.mkdirSync(path.dirname(defaultTaskModePath), { recursive: true });
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-17T12:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact for split routing/receipt regression coverage',
            provider: 'Qwen',
            routed_to: 'QWEN.md',
            canonical_source_of_truth: 'Qwen',
            execution_provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved'
        }, null, 2) + '\n', 'utf8');

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        let buildExitCode = 0;
        let routingExitCode = 0;
        let receiptExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--task-mode-path', customTaskModePath,
                '--output-path', reviewContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            const builtReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = builtReviewContext.reviewer_routing as Record<string, unknown>;
            assert.equal(reviewerRouting.canonical_source_of_truth, 'Codex');
            assert.equal(reviewerRouting.execution_provider, 'Antigravity');
            assert.equal(reviewerRouting.source_of_truth, 'Antigravity');

            fs.writeFileSync(artifactPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts`, `src/gates/reviewer-routing.ts`, and the split routing/receipt lifecycle, confirming that the explicit custom task-mode artifact path remains authoritative even when a conflicting default task-mode artifact exists.',
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
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            routingExitCode = Number(process.exitCode ?? 0);

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            receiptExitCode = Number(process.exitCode ?? 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(routingExitCode, 0);
        assert.equal(receiptExitCode, 0);

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(artifactPath.replace(/\.md$/, '-receipt.json'), 'utf8')) as Record<string, unknown>;
        const events = readTaskTimelineEvents(repoRoot, taskId);

        assert.equal(reviewerRouting.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewerRouting.reviewer_session_id, 'agent:code-reviewer');
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');
        assert.ok(events.some((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED'));
        assert.ok(events.some((event) => event.event_type === 'REVIEW_RECORDED'));

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
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
            rationale: 'Custom task-mode path split routing/receipt regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-receipt rejects stripped split runtime identity for explicit custom task-mode paths', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-task-mode-receipt-identity-guard';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        writeReviewCapabilitiesConfig(repoRoot);
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
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
            artifactPath: customTaskModePath,
            taskSummary: 'Reject stripped split runtime identity on the public receipt path',
            provider: 'Antigravity',
            routedTo: '.antigravity/agents/orchestrator.md'
        });
        loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation started for stripped split runtime identity receipt guard regression fixture.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const reviewsRoot = getReviewsRoot(repoRoot);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const capturedErrors: string[] = [];
        let buildExitCode = 0;
        let routingExitCode = 0;
        let receiptExitCode = 0;
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
                '--task-mode-path', customTaskModePath,
                '--output-path', reviewContextPath
            ]);
            buildExitCode = Number(process.exitCode ?? 0);

            fs.writeFileSync(artifactPath, [
                '# Review',
                '',
                'Validated `src/cli/commands/gate-review-handlers.ts` and the stripped split runtime identity fixture while keeping the artifact realistic and non-trivial.',
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
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            routingExitCode = Number(process.exitCode ?? 0);

            const strippedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
            const reviewerRouting = strippedContext.reviewer_routing as Record<string, unknown>;
            delete reviewerRouting.canonical_source_of_truth;
            delete reviewerRouting.execution_provider;
            delete reviewerRouting.execution_provider_source;
            delete reviewerRouting.identity_status;
            strippedContext.reviewer_routing = reviewerRouting;
            fs.writeFileSync(reviewContextPath, JSON.stringify(strippedContext, null, 2) + '\n', 'utf8');

            process.exitCode = 0;
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--review-context-path', reviewContextPath,
                '--task-mode-path', customTaskModePath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'delegated_subagent',
                '--reviewer-identity', 'agent:code-reviewer'
            ]);
            receiptExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.equal(buildExitCode, 0);
        assert.equal(routingExitCode, 0);
        assert.notEqual(receiptExitCode, 0);
        assert.ok(capturedErrors.some((line) => (
            line.includes('missing canonical_source_of_truth')
            || line.includes('missing execution_provider')
            || line.includes('missing identity_status')
        )));
        assert.equal(fs.existsSync(receiptPath), false);
        assert.equal(
            readTaskTimelineEvents(repoRoot, taskId).some((event) => event.event_type === 'REVIEW_RECORDED'),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check rejects pre-recorded review artifacts when task-mode identity metadata is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-task-mode-identity-missing-at-review';
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
            taskSummary: 'Reject required-reviews-check when pinned task-mode identity metadata is missing',
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

        const taskModePath = path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`);
        const tamperedTaskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        delete tamperedTaskMode.canonical_source_of_truth;
        delete tamperedTaskMode.execution_provider_source;
        delete tamperedTaskMode.runtime_identity_status;
        fs.writeFileSync(taskModePath, JSON.stringify(tamperedTaskMode, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('missing canonical_source_of_truth')));

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

    it('required-reviews-check fails when workspace canonical ownership drifts after task-mode identity was pinned', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-review-runtime-identity-drift';
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
            taskSummary: 'Fail required-reviews-check when workspace canonical SourceOfTruth drifts after task-mode entry',
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

        seedInitAnswers(repoRoot, 'Qwen');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes('contradicts task-mode canonical_source_of_truth')));

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

    it('legacy task-mode artifacts can resume review and completion after upgrade when runtime identity can be backfilled safely', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-legacy-task-mode-resume';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy task-mode entry before runtime identity split.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: 'AGENTS.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

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
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(reviewsRoot, `${taskId}-code-review-context.json`),
            'agent:code-reviewer',
            {
                legacyReviewContextIdentity: true,
                legacyReviewContextSourceOfTruth: 'Codex'
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started for resumed legacy task-mode fixture.',
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
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_DELEGATION_ROUTED',
            'INFO',
            'Delegated code review routed for resumed legacy task-mode fixture.',
            {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Code review evidence recorded for resumed legacy task-mode fixture.',
            { review_type: 'code' }
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
            rationale: 'Legacy task-mode compatibility regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('legacy provider-bridge task-mode artifacts can resume review and completion after upgrade when runtime identity can be backfilled safely', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-legacy-bridge-task-mode-resume';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        const reviewsRoot = getReviewsRoot(repoRoot);
        const taskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(taskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: taskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

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
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(reviewsRoot, `${taskId}-code-review-context.json`),
            'agent:code-reviewer',
            { legacyReviewContextIdentity: true }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started for resumed legacy provider-bridge task-mode fixture.',
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
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_DELEGATION_ROUTED',
            'INFO',
            'Delegated code review routed for resumed legacy provider-bridge task-mode fixture.',
            {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Code review evidence recorded for resumed legacy provider-bridge task-mode fixture.',
            { review_type: 'code' }
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
            rationale: 'Legacy provider-bridge task-mode compatibility regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('legacy provider-bridge task-mode artifacts can resume review and completion from an explicit custom task-mode path when the default artifact drifts', { concurrency: false }, async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-legacy-bridge-custom-task-mode-resume';
        const customTaskModePath = path.join(repoRoot, 'custom-artifacts', `${taskId}-task-mode.json`);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'VERSION'), '0.0.0-test\n', 'utf8');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.dirname(customTaskModePath), { recursive: true });
        fs.mkdirSync(reviewsRoot, { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.agents', 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, '.antigravity', 'agents'), { recursive: true });
        fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'AGENTS.md'), '# AGENTS\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.agents', 'workflows', 'start-task.md'), '# start-task\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.antigravity', 'agents', 'orchestrator.md'), '# antigravity bridge\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'garda-agent-orchestrator', 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
        fs.writeFileSync(customTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-16T09:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact from a custom path after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTERED', 'PASS', 'Legacy provider-bridge task-mode entry before runtime identity split.', {
            artifact_path: customTaskModePath.replace(/\\/g, '/'),
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Resume legacy provider-bridge task-mode artifact from a custom path after upgrade',
            provider: 'Codex',
            routed_to: '.antigravity/agents/orchestrator.md'
        });
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 2;\nconsole.log(a + b);\nconsole.log(\'done\');\n', 'utf8');

        assert.equal(loadTaskEntryRulePack(repoRoot, taskId, customTaskModePath).exitCode, 0);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');

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
        assert.equal(loadPostPreflightRulePack(repoRoot, taskId, preflightPath, true, '', customTaskModePath).exitCode, 0);
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'IMPLEMENTATION_STARTED',
            'INFO',
            'Implementation resumed after upgrade on a legacy provider-bridge custom task-mode artifact.',
            {}
        );
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const defaultTaskModePath = path.join(reviewsRoot, `${taskId}-task-mode.json`);
        fs.writeFileSync(defaultTaskModePath, JSON.stringify({
            timestamp_utc: '2026-04-17T12:00:00.000Z',
            event_source: 'enter-task-mode',
            task_id: taskId,
            status: 'PASSED',
            outcome: 'PASS',
            entry_mode: 'EXPLICIT_TASK_EXECUTION',
            requested_depth: 2,
            effective_depth: 2,
            task_summary: 'Drifted default task-mode artifact for legacy custom-path compatibility coverage',
            provider: 'Qwen',
            routed_to: 'QWEN.md',
            canonical_source_of_truth: 'Qwen',
            execution_provider: 'Qwen',
            execution_provider_source: 'task_mode',
            runtime_identity_status: 'resolved'
        }, null, 2) + '\n', 'utf8');

        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            preflightPath,
            path.join(reviewsRoot, `${taskId}-code-review-context.json`),
            'agent:code-reviewer',
            {
                legacyReviewContextIdentity: true,
                taskModePath: customTaskModePath
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_PHASE_STARTED',
            'INFO',
            'Review phase started for resumed legacy provider-bridge custom task-mode fixture.',
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
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEWER_DELEGATION_ROUTED',
            'INFO',
            'Delegated code review routed for resumed legacy provider-bridge custom task-mode fixture.',
            {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'Code review evidence recorded for resumed legacy provider-bridge custom task-mode fixture.',
            { review_type: 'code' }
        );

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            taskModePath: customTaskModePath,
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
            rationale: 'Legacy provider-bridge custom task-mode compatibility regression fixture only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId,
            taskModePath: customTaskModePath
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('build-review-context keeps downstream test review blocked when upstream code review uses a legacy custom context path without strict binding metadata', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-custom-code-context-legacy-blocked';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
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
        const commandsPath = path.join(repoRoot, 'commands-custom-code-context-legacy-blocked.md');
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
            taskSummary: 'Keep downstream test review blocked when legacy custom upstream review contexts fail strict gate validation',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
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

        const reviewsRoot = getReviewsRoot(repoRoot);
        const canonicalCodeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const legacyCodeReviewContextPath = path.join(reviewsRoot, 'legacy-code-context.json');
        const codeReviewArtifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const codeReviewReceiptPath = codeReviewArtifactPath.replace(/\.md$/, '-receipt.json');
        const blockedTestReviewContextPath = path.join(reviewsRoot, `${taskId}-blocked-test-review-context.json`);
        const blockedTestReviewContextArtifactPath = blockedTestReviewContextPath.replace(/\.json$/, '.md');
        const blockedTestScopedDiffPath = path.join(reviewsRoot, `${taskId}-blocked-test-scoped.json`);
        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        const originalConsoleError = console.error;
        const blockedErrors: string[] = [];
        let codeReviewBuildExitCode = 0;
        let blockedExitCode = 0;
        try {
            process.chdir(repoRoot);

            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--output-path', canonicalCodeReviewContextPath
            ]);
            codeReviewBuildExitCode = Number(process.exitCode ?? 0);

            const canonicalContext = JSON.parse(fs.readFileSync(canonicalCodeReviewContextPath, 'utf8')) as Record<string, unknown>;
            const routing = (canonicalContext.reviewer_routing && typeof canonicalContext.reviewer_routing === 'object')
                ? canonicalContext.reviewer_routing as Record<string, unknown>
                : {};
            const legacyContext = {
                review_type: canonicalContext.review_type,
                reviewer_routing: {
                    ...routing,
                    actual_execution_mode: 'delegated_subagent',
                    reviewer_session_id: 'agent:code-reviewer'
                }
            };
            fs.writeFileSync(legacyCodeReviewContextPath, JSON.stringify(legacyContext, null, 2) + '\n', 'utf8');

            const artifactText = [
                '# Review',
                '',
                'Validated `src/app.ts` and the downstream review sequencing contract in detail, confirming that the upstream code-review artifact is otherwise realistic and non-trivial while leaving no active findings for this fixture.',
                '',
                '## Findings by Severity',
                'none',
                '',
                '## Residual Risks',
                'none',
                '',
                '## Verdict',
                'REVIEW PASSED'
            ].join('\n');
            fs.writeFileSync(codeReviewArtifactPath, artifactText, 'utf8');

            const crypto = require('node:crypto');
            const preflightText = fs.readFileSync(preflightPath, 'utf8');
            const preflight = JSON.parse(preflightText) as Record<string, unknown>;
            const legacyContextText = fs.readFileSync(legacyCodeReviewContextPath, 'utf8');
            const receipt = buildReviewReceipt({
                taskId,
                reviewType: 'code',
                preflightSha256: crypto.createHash('sha256').update(preflightText).digest('hex'),
                scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
                codeScopeSha256: computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256,
                reviewContextSha256: crypto.createHash('sha256').update(legacyContextText).digest('hex'),
                reviewContextReuseSha256: computeReviewContextReuseHash(JSON.parse(legacyContextText) as Record<string, unknown>),
                reviewArtifactSha256: crypto.createHash('sha256').update(artifactText).digest('hex'),
                reviewerExecutionMode: 'delegated_subagent',
                reviewerIdentity: 'agent:code-reviewer',
                reviewerFallbackReason: null,
                trustLevel: 'LOCAL_AUDITED'
            });
            fs.writeFileSync(codeReviewReceiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
                review_type: 'code'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', {
                skill_id: 'code-review'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
                reference_path: '/live/skills/code-review/SKILL.md'
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:code-reviewer',
                delegation_used: true
            });
            appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', {
                review_type: 'code',
                review_context_path: legacyCodeReviewContextPath.replace(/\\/g, '/')
            });

            process.exitCode = 0;
            console.error = (...args: unknown[]) => {
                blockedErrors.push(args.map((value) => String(value)).join(' '));
            };
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--repo-root', repoRoot,
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', preflightPath,
                '--scoped-diff-metadata-path', blockedTestScopedDiffPath,
                '--output-path', blockedTestReviewContextPath
            ]);
            blockedExitCode = Number(process.exitCode ?? 0);
        } finally {
            console.error = originalConsoleError;
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const blockedErrorOutput = blockedErrors.join('\n');
        assert.equal(codeReviewBuildExitCode, 0);
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('missing task_id')
            || blockedErrorOutput.includes('missing preflight_path')
            || blockedErrorOutput.includes('missing preflight_sha256'),
            blockedErrorOutput
        );
        assert.equal(fs.existsSync(blockedTestReviewContextPath), false);
        assert.equal(fs.existsSync(blockedTestReviewContextArtifactPath), false);
        assert.equal(fs.existsSync(blockedTestScopedDiffPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

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
            });

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

    it('required-reviews-check rejects rerun after the review gate already passed without mutating the timeline', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-rerun-review-gate';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Required reviews gate passed.', {});

        const beforeEvents = readTaskTimelineEvents(repoRoot, taskId).length;
        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        const afterEvents = readTaskTimelineEvents(repoRoot, taskId);

        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => line.includes("Do not rerun 'required-reviews-check' in place")));
        assert.equal(afterEvents.length, beforeEvents);
        assert.equal(afterEvents.filter((event) => event.event_type === 'REVIEW_GATE_FAILED').length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('required-reviews-check allows a fresh review cycle after a newer compile pass', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904b-rerun-review-gate-recovered';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const commandsPath = path.join(repoRoot, 'commands-rerun.md');
        fs.writeFileSync(commandsPath, [
            '### Compile Gate (Mandatory)',
            '```bash',
            'node -e "console.log(\'build ok\')"',
            '```'
        ].join('\n'), 'utf8');

        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Allow review-gate rerun after a new compile cycle'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeReceiptBackedReviewArtifact(repoRoot, taskId, 'code', 'REVIEW PASSED');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_GATE_PASSED', 'PASS', 'Prior review gate passed.', {});

        const compileResult = await runCompileGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            commandsPath,
            emitMetrics: false
        });
        assert.equal(compileResult.exitCode, 0);

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });

        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });


    it('passes required review and completion flow for conditional-provider fallback evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904c';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Antigravity');
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
            taskSummary: 'Validate fallback review flow',
            provider: 'Antigravity'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
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
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'Review phase started.', {
            review_type: 'code'
        });
        const reviewsRoot = getReviewsRoot(repoRoot);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(artifactPath, [
            '# Code Review',
            '',
            'Validated the Antigravity fallback path across `src/cli/main.ts`, `src/gates/required-reviews-check.ts`, and `src/gates/completion.ts`, confirming that same-agent fallback requires an explicit reason, preserves reviewer identity consistency, and is consumed correctly by both review-gate and completion-gate in the absence of delegated subagent execution.',
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
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: createReviewerRoutingFixture('Antigravity', {
                execution_provider_source: 'explicit_provider',
                capability_level: 'delegation_conditional',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: true,
                fallback_reason_required: true
            })
        }, null, 2) + '\n', 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: 'code-review' });
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {
            reference_path: '/live/skills/code-review/SKILL.md'
        });

        const previousExitCode = process.exitCode;
        const previousCwd = process.cwd();
        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'record-review-routing',
                '--task-id', taskId,
                '--review-type', 'code',
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge did not expose subagent execution'
            ]);
            await runCliMainWithHandling([
                'gate',
                'record-review-receipt',
                '--task-id', taskId,
                '--review-type', 'code',
                '--preflight-path', preflightPath,
                '--repo-root', repoRoot,
                '--reviewer-execution-mode', 'same_agent_fallback',
                '--reviewer-identity', `self:${taskId}`,
                '--reviewer-fallback-reason', 'provider bridge did not expose subagent execution'
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, 0);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_PASSED');

        const docImpactResult = runDocImpactGateCommand({
            repoRoot,
            taskId,
            preflightPath,
            decision: 'NO_DOC_UPDATES',
            behaviorChanged: false,
            changelogUpdated: false,
            rationale: 'Test fixture exercises conditional-provider fallback review flow only.',
            emitMetrics: false
        });
        assert.equal(docImpactResult.exitCode, 0);

        const completionResult = runCompletionGate({
            repoRoot,
            preflightPath,
            taskId
        });
        assert.equal(completionResult.status, 'PASSED', JSON.stringify(completionResult, null, 2));
        assert.equal(completionResult.outcome, 'PASS');

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

describe('executeCommand timeout protection (T-061)', () => {
    it('runs a simple command successfully with default timeout', () => {
        const result = executeCommand(`node -e "console.log('hello')"`, {
            cwd: process.cwd()
        });
        assert.equal(result.exitCode, 0);
        assert.ok(result.outputLines.some(line => line.includes('hello')));
        assert.equal(result.timedOut, false);
    });

    it('reports timedOut when command exceeds specified timeout', () => {
        const result = executeCommand(
            `node -e "const s=Date.now();while(Date.now()-s<10000){}"`,
            { cwd: process.cwd(), timeoutMs: 500 }
        );
        assert.equal(result.timedOut, true);
        assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
        assert.ok(result.outputLines.some(line => /timed out/i.test(line)));
    });

    it('throws ENOENT for missing executable', () => {
        assert.throws(
            () => executeCommand('__nonexistent_executable_12345__', { cwd: process.cwd() }),
            /not found in PATH/
        );
    });

    it('blocks direct .node-build sync consumers when the node-foundation producer output is stale', () => {
        const fixture = createDependentValidationFixture();
        try {
            writeNodeFoundationManifest(fixture.manifestPath);
            ageFixturePath(fixture.manifestPath, 10_000);
            fs.writeFileSync(fixture.sourcePath, 'export const feature = false;\n', 'utf8');

            assert.throws(
                () => executeCommand(`node --test "${fixture.consumerPath}"`, { cwd: fixture.repoRoot }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*npm run build:node-foundation.*Do not run the producer and consumer in parallel/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build async consumers while the node-foundation producer lock is active', async () => {
        const fixture = createDependentValidationFixture();
        try {
            ageFixturePath(fixture.sourcePath, 10_000);
            writeNodeFoundationManifest(fixture.manifestPath);
            fs.mkdirSync(fixture.lockPath, { recursive: true });
            fs.writeFileSync(path.join(fixture.lockPath, 'owner.json'), JSON.stringify({
                pid: process.pid,
                hostname: os.hostname(),
                startedAtUtc: new Date().toISOString()
            }, null, 2) + '\n', 'utf8');

            const error = await captureExpectedAsyncError(() => executeCommandAsync(
                `node --test "${fixture.consumerPath}"`,
                { cwd: fixture.repoRoot, timeoutMs: 10_000 }
            ).then(() => undefined));
            assert.match(
                error.message,
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'.*producer lock.*npm test/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('blocks direct .node-build consumers from nested cwd values that point back to the repo artifact root', () => {
        const fixture = createDependentValidationFixture();
        try {
            const nestedConsumerPath = path.relative(fixture.nestedCwd, fixture.consumerPath);
            assert.throws(
                () => executeCommand(`node --test "${nestedConsumerPath}"`, { cwd: fixture.nestedCwd }),
                /Dependent validation chain 'node_foundation_build_to_compiled_tests'/i
            );
        } finally {
            fixture.cleanup();
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for sync execution on Windows', () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_SYNC\r\n', 'utf8');
            const result = executeCommand('npm --version', { cwd: repoRoot });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_SYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('prefers the resolved PATH batch executable over a cwd shadow for async execution on Windows', async () => {
        if (process.platform !== 'win32') return;
        const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-batch-shadow-'));
        try {
            fs.writeFileSync(path.join(repoRoot, 'npm.cmd'), '@echo off\r\necho HIJACKED_ASYNC\r\n', 'utf8');
            const result = await executeCommandAsync('npm --version', { cwd: repoRoot, timeoutMs: 10_000 });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => /^\d+\.\d+\.\d+/.test(line)), 'expected real npm version output');
            assert.ok(!result.outputLines.some((line) => line.includes('HIJACKED_ASYNC')));
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });

    it('forwards quoted batch arguments through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = executeCommand(`"${fixture.batchPath}" "safe literal"`, { cwd: process.cwd() });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('forwards quoted batch arguments through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('process.stdout.write(process.argv[2] || "")', { forwardArgs: true });
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}" "safe literal"`, {
                cwd: process.cwd(),
                timeoutMs: 10_000
            });
            assert.equal(result.exitCode, 0);
            assert.ok(result.outputLines.some((line) => line.includes('safe literal')));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommandAsync on Windows', async () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = await executeCommandAsync(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });

    it('reports timedOut for batch execution through executeCommand on Windows', () => {
        if (process.platform !== 'win32') return;
        const fixture = createWindowsBatchNodeFixture('setTimeout(() => {}, 60000)');
        try {
            const result = executeCommand(`"${fixture.batchPath}"`, {
                cwd: process.cwd(),
                timeoutMs: 500
            });
            assert.equal(result.timedOut, true);
            assert.equal(result.exitCode, EXIT_GENERAL_FAILURE);
            assert.ok(result.outputLines.some((line) => /timed out/i.test(line)));
        } finally {
            fixture.cleanup();
        }
    });
});
