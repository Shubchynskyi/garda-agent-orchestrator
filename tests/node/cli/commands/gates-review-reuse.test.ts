import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    EXIT_GENERAL_FAILURE,
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
import { validateReviewSkillEvidence } from '../../../../src/gates/completion';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance
} from '../../../../src/gate-runtime/review-context';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    computeReviewContextReuseHash,
    isNonTestReviewScope
} from '../../../../src/gates/review-reuse';
import { resolveReviewerRoutingPolicy } from '../../../../src/gates/reviewer-routing';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';

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
    trustLevel: 'INDEPENDENT_AUDITED';
} {
    const reviewerExecutionMode = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint').expected_execution_mode;
    return {
        reviewerExecutionMode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'INDEPENDENT_AUDITED'
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

function getReviewTreeStateSha256FromFixtureContext(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state
        && typeof reviewContext.tree_state === 'object'
        && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const normalized = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
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

function runGitBestEffort(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
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
        stdio: ['ignore', 'pipe', 'pipe']
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
            fs.writeFileSync(absolutePath, `// review reuse fixture for ${changedFile}\n`, 'utf8');
        }
    }
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
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(artifactSnapshotPath, content, 'utf8');
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
        const invocationDetails = {
            task_id: taskId,
            review_type: reviewKey,
            reviewer_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            reviewer_identity: execution.reviewerIdentity,
            review_context_sha256: reviewContextHash,
            routing_event_sha256: routedEvent?.integrity?.event_sha256
        };
        const invocationEvent = appendTaskEvent(
            orchestratorRoot,
            taskId,
            'REVIEWER_INVOCATION_ATTESTED',
            'INFO',
            'reviewer invocation attested',
            invocationDetails,
            { passThru: true }
        );
        reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
            'REVIEWER_INVOCATION_ATTESTED',
            invocationEvent?.integrity,
            invocationDetails
        );
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', { review_type: reviewKey });
    }
    const receipt = {
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
    };
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptSha256 = crypto.createHash('sha256').update(receiptText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptSha256}.json`);
    fs.writeFileSync(receiptPath, receiptText, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptText, 'utf8');
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
        omitInvocationTreeState?: boolean;
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
    ensureReviewDiffFixture(repoRoot, preflightPath);
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
    const reviewContextPayload = JSON.parse(reviewContextText) as Record<string, unknown>;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const reviewTreeStateSha256 = getReviewTreeStateSha256FromFixtureContext(reviewContextPayload);
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
    const invocationDetails: Record<string, unknown> = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: execution.reviewerExecutionMode,
        reviewer_session_id: execution.reviewerIdentity,
        reviewer_identity: execution.reviewerIdentity,
        review_context_sha256: reviewContextHash,
        routing_event_sha256: routedEvent?.integrity?.event_sha256
    };
    if (!options.omitInvocationTreeState) {
        invocationDetails.review_tree_state_sha256 = reviewTreeStateSha256;
    }
    const invocationEvent = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'historical reviewer invocation attested',
        invocationDetails,
        { passThru: true }
    );
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
        reviewScopeSha256: computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256,
        codeScopeSha256: isNonTestReviewScope(reviewKey)
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: reviewContextHash,
        reviewTreeStateSha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(reviewContextPayload),
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: execution.reviewerExecutionMode,
        reviewerIdentity: execution.reviewerIdentity,
        reviewerFallbackReason: execution.reviewerFallbackReason,
        reviewerProvenance: buildReviewReceiptReviewerInvocationProvenance(
            'REVIEWER_INVOCATION_ATTESTED',
            invocationEvent?.integrity,
            invocationDetails
        ),
        trustLevel: execution.trustLevel
    });
    const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptSha256 = crypto.createHash('sha256').update(receiptText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptSha256}.json`);
    fs.writeFileSync(receiptPath, receiptText, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptText, 'utf8');
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'historical review recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
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

function insertTaskEventWithoutIntegrityBeforeLatest(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: Record<string, unknown>,
    predicate: (event: Record<string, unknown>) => boolean
): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    fs.mkdirSync(path.dirname(timelinePath), { recursive: true });
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0);
    const insertBeforeIndex = findLastTimelineEventIndex(
        lines.map((line) => JSON.parse(line) as Record<string, unknown>),
        predicate
    );
    assert.notEqual(insertBeforeIndex, -1);
    lines.splice(insertBeforeIndex, 0, JSON.stringify({
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'test',
        message,
        details
    }));
    fs.writeFileSync(timelinePath, lines.join('\n') + '\n', 'utf8');
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

function tamperLatestHistoricalReceiptSnapshot(repoRoot: string, taskId: string, reviewType: string): string {
    const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
        .reverse()
        .find((event) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            return (
                event.event_type === 'REVIEW_RECORDED'
                && details
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
                && details.reused_existing_review !== true
            );
        });
    assert.ok(historicalReviewRecorded);
    const details = historicalReviewRecorded.details as Record<string, unknown>;
    const snapshotPathRaw = String(details.receipt_snapshot_path || details.receiptSnapshotPath || '').trim();
    assert.ok(snapshotPathRaw);
    const snapshotPath = path.isAbsolute(snapshotPathRaw)
        ? snapshotPathRaw
        : path.resolve(repoRoot, snapshotPathRaw);
    fs.appendFileSync(snapshotPath, '\nTampered historical receipt snapshot after reuse telemetry was recorded.\n', 'utf8');
    return snapshotPath;
}

function tamperLatestHistoricalArtifactSnapshot(repoRoot: string, taskId: string, reviewType: string): string {
    const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
        .reverse()
        .find((event) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : null;
            return (
                event.event_type === 'REVIEW_RECORDED'
                && details
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
                && details.reused_existing_review !== true
            );
        });
    assert.ok(historicalReviewRecorded);
    const details = historicalReviewRecorded.details as Record<string, unknown>;
    const snapshotPathRaw = String(details.review_artifact_snapshot_path || details.reviewArtifactSnapshotPath || '').trim();
    assert.ok(snapshotPathRaw);
    const snapshotPath = path.isAbsolute(snapshotPathRaw)
        ? snapshotPathRaw
        : path.resolve(repoRoot, snapshotPathRaw);
    fs.appendFileSync(snapshotPath, '\nTampered historical artifact snapshot after reuse telemetry was recorded.\n', 'utf8');
    return snapshotPath;
}

function stripLatestHistoricalReceiptSnapshotTelemetry(repoRoot: string, taskId: string, reviewType: string): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    let stripped = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        if (
            event.event_type === 'REVIEW_RECORDED'
            && details
            && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
            && details.reused_existing_review !== true
        ) {
            delete details.receipt_snapshot_path;
            delete details.receiptSnapshotPath;
            delete details.receipt_snapshot_sha256;
            delete details.receiptSnapshotSha256;
            lines[index] = JSON.stringify(event);
            stripped = true;
            break;
        }
    }
    assert.equal(stripped, true);
    fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
}

function listReviewSnapshotArtifactNames(reviewsRoot: string, taskId: string, reviewType: string): string[] {
    return fs.readdirSync(reviewsRoot)
        .filter((name) => (
            name.startsWith(`${taskId}-${reviewType}-receipt-`)
            || name.startsWith(`${taskId}-${reviewType}-artifact-`)
        ))
        .sort();
}

function updateLatestHistoricalReviewRecordedDetails(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    update: (details: Record<string, unknown>) => void
): void {
    const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter(Boolean);
    let updated = false;
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const event = JSON.parse(lines[index]) as Record<string, unknown>;
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        if (
            event.event_type === 'REVIEW_RECORDED'
            && details
            && String(details.review_type || details.reviewType || '').trim().toLowerCase() === reviewType
            && details.reused_existing_review !== true
        ) {
            update(details);
            lines[index] = JSON.stringify(event);
            updated = true;
            break;
        }
    }
    assert.equal(updated, true);
    fs.writeFileSync(timelinePath, `${lines.join('\n')}\n`, 'utf8');
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
        assert.equal(refreshedReceipt.reused_existing_review, true);
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(reviewContext)
        );
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, null);
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, null);
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);
        const reviewGateResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            testReviewVerdict: 'TEST REVIEW PASSED',
            outputFiltersPath,
            emitMetrics: false
        });
        assert.equal(reviewGateResult.exitCode, 0, reviewGateResult.outputLines.join('\n'));
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
        const priorReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;

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
        const refreshedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.review_tree_state_sha256,
            getReviewTreeStateSha256FromFixtureContext(refreshedReviewContext)
        );
        assert.equal(
            refreshedReceipt.reused_from_review_tree_state_sha256,
            priorReceipt.review_tree_state_sha256
        );
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

        const firstReuseProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown>;
        const secondPreflightPath = writePreflight(repoRoot, taskId, {
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
        writeCompilePassEvidence(repoRoot, taskId, secondPreflightPath);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'code',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--output-path', reviewContextPath,
                '--repo-root', repoRoot
            ]);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        const secondRefreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(secondRefreshedReceipt.reused_existing_review, true);
        assert.deepEqual(secondRefreshedReceipt.reviewer_provenance, firstReuseProvenance);
        assert.equal(
            secondRefreshedReceipt.reused_from_review_context_sha256,
            firstReuseProvenance.review_context_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_receipt_sha256,
            refreshedReceipt.reused_from_receipt_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_tree_state_sha256,
            refreshedReceipt.reused_from_review_tree_state_sha256
        );
        assert.equal(
            secondRefreshedReceipt.reused_from_review_scope_sha256,
            refreshedReceipt.reused_from_review_scope_sha256
        );
        const secondEvents = readTaskTimelineEvents(repoRoot, taskId);
        const secondLatestCompileSequence = findLastTimelineEventIndex(secondEvents, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const secondCurrentCycleCodeEvents = secondEvents
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > secondLatestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length, 0);
        assert.equal(secondCurrentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEW_RECORDED').length, 1);

        process.exitCode = 0;
        try {
            process.chdir(repoRoot);
            await runCliMainWithHandling([
                'gate',
                'build-review-context',
                '--review-type', 'test',
                '--depth', '2',
                '--preflight-path', secondPreflightPath,
                '--repo-root', repoRoot
            ]);
            assert.equal(process.exitCode ?? 0, 0);
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }
        assert.equal(fs.existsSync(path.join(reviewsRoot, `${taskId}-test-review-context.json`)), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('skips rebuilding an unchanged current-cycle PASS review context', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-context-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse current-cycle PASS review context when bindings are unchanged'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');

        const originalContextText = fs.readFileSync(reviewContextPath, 'utf8');
        const originalReceiptText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8');
        const eventsBefore = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(
            eventsBefore,
            (event) => event.event_type === 'COMPILE_GATE_PASSED'
        );
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeReviewPhaseCount = eventsBefore.filter((event, index) => {
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            return (
                index > latestCompileSequence
                && event.event_type === 'REVIEW_PHASE_STARTED'
                && String(details.review_type || '').trim().toLowerCase() === 'code'
            );
        }).length;
        assert.equal(currentCycleCodeReviewPhaseCount, 1);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: True'));
        assert.ok(result.outputLines.some((line) => line.includes('review context rebuild skipped')));
        assert.equal(fs.readFileSync(reviewContextPath, 'utf8'), originalContextText);
        assert.equal(fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8'), originalReceiptText);
        assert.deepEqual(readTaskTimelineEvents(repoRoot, taskId), eventsBefore);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when review-recorded telemetry lacks integrity', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-recorded';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when REVIEW_RECORDED telemetry is untrusted'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const timelineLines = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0);
        const tamperedLines = timelineLines.map((line) => {
            const event = JSON.parse(line) as Record<string, unknown>;
            const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                ? event.details as Record<string, unknown>
                : {};
            if (
                event.event_type === 'REVIEW_RECORDED'
                && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
            ) {
                delete event.integrity;
            }
            return JSON.stringify(event);
        });
        fs.writeFileSync(timelinePath, tamperedLines.join('\n') + '\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('trusted current-cycle REVIEW_RECORDED telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the review context JSON is corrupt', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-corrupt-context';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when review context JSON is corrupt'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        fs.writeFileSync(reviewContextPath, '{not-json', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('existing review context is missing or corrupt')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when the receipt is no longer independently audited', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when receipt trust level is downgraded'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.trust_level = 'LOCAL_ASSERTED';
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review receipt bindings do not match')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle fresh PASS context when reviewer invocation provenance is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-provenance';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer invocation provenance is missing'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = null;
        fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('reviewer invocation attestation')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the handoff artifact is missing', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-missing-handoff';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when the handoff artifact is missing'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const ruleContext = reviewContext.rule_context as Record<string, unknown>;
        const ruleContextArtifactPath = String(ruleContext.artifact_path || '');
        assert.ok(ruleContextArtifactPath);
        fs.rmSync(ruleContextArtifactPath, { force: true });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('readable reviewer prompt artifact')));
        assert.equal(fs.existsSync(ruleContextArtifactPath), true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle PASS review context when the reviewer-visible tree-state is stale', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-stale-tree-state';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reviewer-visible tree state changes'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:code-reviewer');
        const originalContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const originalTreeStateSha256 = getReviewTreeStateSha256FromFixtureContext(originalContext);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changedAfterPass = true;\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('review context tree_state is stale')));
        const rebuiltContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        assert.notEqual(getReviewTreeStateSha256FromFixtureContext(rebuiltContext), originalTreeStateSha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('rebuilds current-cycle reused PASS context when strict reuse telemetry is incomplete', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-current-pass-untrusted-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject current PASS reuse when reused evidence telemetry is incomplete'
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
        await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        const crypto = require('node:crypto');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const forgedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        delete forgedReceipt.reused_from_receipt_sha256;
        delete forgedReceipt.reused_from_review_context_sha256;
        delete forgedReceipt.reused_from_review_context_reuse_sha256;
        delete forgedReceipt.reused_from_review_tree_state_sha256;
        delete forgedReceipt.reused_from_review_scope_sha256;
        delete forgedReceipt.reused_from_code_scope_sha256;
        const forgedReceiptText = `${JSON.stringify(forgedReceipt, null, 2)}\n`;
        const forgedReceiptSha256 = crypto.createHash('sha256').update(forgedReceiptText).digest('hex');
        const forgedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${forgedReceiptSha256}.json`);
        fs.writeFileSync(receiptPath, forgedReceiptText, 'utf8');
        fs.writeFileSync(forgedReceiptSnapshotPath, forgedReceiptText, 'utf8');
        const artifactText = fs.readFileSync(artifactPath, 'utf8');
        const artifactSha256 = crypto.createHash('sha256').update(artifactText).digest('hex');
        const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactSha256}.md`);
        fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'forged current reuse recorded', {
            ...forgedReceipt,
            reused_existing_review: true,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: forgedReceiptSha256,
            receipt_snapshot_path: path.normalize(forgedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: forgedReceiptSha256,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: artifactSha256,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/'),
            review_context_sha256: forgedReceipt.review_context_sha256
        });

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.ok(result.outputLines.includes('CurrentPassReviewEvidence: rejected'));
        assert.ok(result.outputLines.some((line) => line.includes('strict reused evidence telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses matching historical code-review evidence when later mutable and recorded receipts were overwritten by polluted scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-historical-reuse-after-receipt-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse historical code review evidence after mutable receipt overwrite'
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

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const originalArtifactText = fs.readFileSync(artifactPath, 'utf8');
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const originalHistoricalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(originalHistoricalReviewRecorded);
        const originalHistoricalDetails = originalHistoricalReviewRecorded.details as Record<string, unknown>;
        const originalReceiptSnapshotSha256 = String(originalHistoricalDetails.receipt_snapshot_sha256 || '').trim();
        assert.ok(originalReceiptSnapshotSha256);
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        const pollutedArtifactText = [
            '# Review',
            '',
            'This later polluted review artifact represents a real subsequent review cycle that overwrote the canonical markdown artifact for a broader scope.',
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
        fs.writeFileSync(artifactPath, pollutedArtifactText, 'utf8');
        const crypto = require('node:crypto');
        const pollutedArtifactHash = crypto
            .createHash('sha256')
            .update(pollutedArtifactText)
            .digest('hex');
        const pollutedArtifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${pollutedArtifactHash}.md`);
        fs.writeFileSync(pollutedArtifactSnapshotPath, pollutedArtifactText, 'utf8');
        const overwrittenReceipt = {
            ...originalReceipt,
            review_artifact_sha256: pollutedArtifactHash,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        };
        assert.notEqual(overwrittenReceipt.code_scope_sha256, originalReceipt.code_scope_sha256);
        writeCompilePassEvidence(repoRoot, taskId, pollutedPreflightPath);
        const pollutedReceiptText = JSON.stringify(overwrittenReceipt, null, 2) + '\n';
        const pollutedReceiptHash = crypto.createHash('sha256').update(pollutedReceiptText).digest('hex');
        const pollutedReceiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${pollutedReceiptHash}.json`);
        fs.writeFileSync(receiptPath, pollutedReceiptText, 'utf8');
        fs.writeFileSync(pollutedReceiptSnapshotPath, pollutedReceiptText, 'utf8');
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'REVIEW_RECORDED', 'PASS', 'polluted review recorded', {
            ...overwrittenReceipt,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: pollutedReceiptHash,
            receipt_snapshot_path: path.normalize(pollutedReceiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: pollutedReceiptHash,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(pollutedArtifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: pollutedArtifactHash,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, true);
        assert.ok(result.outputLines.some((line) => line.includes('matched historical REVIEW_RECORDED')));
        assert.ok(result.outputLines.some((line) => line.includes('rejected latest mutable receipt')));
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reused_existing_review, true);
        assert.equal(refreshedReceipt.reused_from_receipt_sha256, originalReceiptSnapshotSha256);
        assert.notEqual(refreshedReceipt.reused_from_receipt_sha256, pollutedReceiptHash);
        assert.equal(refreshedReceipt.reused_from_code_scope_sha256, originalReceipt.code_scope_sha256);
        assert.notEqual(refreshedReceipt.reused_from_code_scope_sha256, overwrittenReceipt.code_scope_sha256);
        assert.equal(refreshedReceipt.reused_from_review_scope_sha256, originalReceipt.review_scope_sha256);
        assert.equal(fs.readFileSync(artifactPath, 'utf8'), originalArtifactText);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result restores existing receipt and historical snapshots when review-recorded telemetry is blocked', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-record-review-result-rollback-preserves-snapshots';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Preserve existing review evidence when REVIEW_RECORDED telemetry cannot be persisted'
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, reviewContextPath, 'agent:old-code-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const oldReceiptText = fs.readFileSync(receiptPath, 'utf8');
        const oldSnapshotNames = listReviewSnapshotArtifactNames(reviewsRoot, taskId, 'code');
        const oldArtifactText = fs.readFileSync(path.join(reviewsRoot, `${taskId}-code.md`), 'utf8');

        const orchestratorRoot = getOrchestratorRoot(repoRoot);
        const newReviewerIdentity = 'agent:new-code-reviewer';
        const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'new code review routing recorded', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: newReviewerIdentity,
            delegation_used: true,
            reviewer_fallback_reason: null
        }, { passThru: true });
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: 'delegated_subagent',
            reviewerSessionId: newReviewerIdentity,
            fallbackReason: null
        });
        const crypto = require('node:crypto');
        const reviewContextSha256 = crypto.createHash('sha256')
            .update(fs.readFileSync(reviewContextPath))
            .digest('hex');
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', 'new code reviewer invocation attested', {
            task_id: taskId,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: newReviewerIdentity,
            reviewer_identity: newReviewerIdentity,
            review_context_sha256: reviewContextSha256,
            routing_event_sha256: routedEvent?.integrity?.event_sha256
        });

        const reviewOutputPath = path.join(repoRoot, '.review-temp', taskId, 'code', 'review-output.md');
        fs.mkdirSync(path.dirname(reviewOutputPath), { recursive: true });
        fs.writeFileSync(reviewOutputPath, [
            '# Review',
            '',
            'Validated `src/cli/commands/gate-review-handlers/index.ts` rollback behavior for review receipt materialization when telemetry append is blocked after an existing review receipt and immutable snapshots already exist. This reviewer output intentionally describes the receipt path, receipt snapshot path, artifact snapshot path, and task-event append boundary so the materialized review is substantive before the lock-induced persistence failure is exercised.',
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

        const taskEventsRoot = path.join(orchestratorRoot, 'runtime', 'task-events');
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
                '--reviewer-identity', newReviewerIdentity
            ]);
            observedExitCode = process.exitCode ?? 0;
        } finally {
            process.chdir(previousCwd);
            process.exitCode = previousExitCode;
        }

        assert.notEqual(observedExitCode, 0);
        assert.equal(fs.readFileSync(receiptPath, 'utf8'), oldReceiptText);
        assert.deepEqual(listReviewSnapshotArtifactNames(reviewsRoot, taskId, 'code'), oldSnapshotNames);
        assert.equal(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code.md`), 'utf8').trimEnd(),
            oldArtifactText.trimEnd()
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const newRecordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && typeof event.details === 'object'
            && event.details !== null
            && !Array.isArray(event.details)
            && String((event.details as Record<string, unknown>).reviewer_identity || '').trim() === newReviewerIdentity
        ));
        assert.equal(newRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses matching historical test-review evidence when the latest mutable receipt was overwritten by polluted scope', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-historical-test-reuse-after-receipt-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse historical test review evidence after mutable receipt overwrite'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, reviewContextPath, 'agent:test-reviewer');

        const receiptPath = path.join(reviewsRoot, `${taskId}-test-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        const overwrittenReceipt = {
            ...originalReceipt,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        };
        assert.notEqual(overwrittenReceipt.review_scope_sha256, originalReceipt.review_scope_sha256);
        fs.writeFileSync(receiptPath, JSON.stringify(overwrittenReceipt, null, 2) + '\n', 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
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
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'test',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, true);
        assert.ok(result.outputLines.some((line) => line.includes('matched historical REVIEW_RECORDED')));
        assert.ok(result.outputLines.some((line) => line.includes('rejected latest mutable receipt')));
        const refreshedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        assert.equal(refreshedReceipt.reused_existing_review, true);
        assert.equal(refreshedReceipt.reused_from_review_scope_sha256, originalReceipt.review_scope_sha256);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the historical artifact snapshot hash is tampered after receipt overwrite', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-tampered-artifact-after-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence when artifact snapshot hash is tampered after receipt overwrite'
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

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(historicalReviewRecorded);
        const historicalDetails = historicalReviewRecorded.details as Record<string, unknown>;
        const artifactSnapshotPathRaw = String(historicalDetails.review_artifact_snapshot_path || '').trim();
        assert.ok(artifactSnapshotPathRaw);
        const artifactSnapshotPath = path.isAbsolute(artifactSnapshotPathRaw)
            ? artifactSnapshotPathRaw
            : path.resolve(repoRoot, artifactSnapshotPathRaw);
        fs.appendFileSync(artifactSnapshotPath, '\nTampered after the historical review was recorded.\n', 'utf8');
        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review artifact snapshot hash no longer matches telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the historical receipt snapshot hash is tampered after receipt overwrite', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-tampered-receipt-after-overwrite';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence when receipt snapshot hash is tampered after receipt overwrite'
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

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const historicalReviewRecorded = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => (
                event.event_type === 'REVIEW_RECORDED'
                && typeof event.details === 'object'
                && event.details !== null
                && !Array.isArray(event.details)
                && String((event.details as Record<string, unknown>).review_type || '').trim() === 'code'
            ));
        assert.ok(historicalReviewRecorded);
        const historicalDetails = historicalReviewRecorded.details as Record<string, unknown>;
        const receiptSnapshotPathRaw = String(historicalDetails.receipt_snapshot_path || '').trim();
        assert.ok(receiptSnapshotPathRaw);
        const receiptSnapshotPath = path.isAbsolute(receiptSnapshotPathRaw)
            ? receiptSnapshotPathRaw
            : path.resolve(repoRoot, receiptSnapshotPathRaw);
        fs.appendFileSync(receiptSnapshotPath, '\nTampered historical receipt snapshot.\n', 'utf8');

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot hash no longer matches telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the receipt snapshot path is outside runtime reviews', async () => {
        const repoRoot = createTempRepo();
        const externalRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-external-'));
        const taskId = 'T-904a-no-historical-reuse-external-receipt-snapshot';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence with an external receipt snapshot path'
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

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceiptText = fs.readFileSync(receiptPath, 'utf8');
        const originalReceipt = JSON.parse(originalReceiptText) as Record<string, unknown>;
        const externalReceiptSnapshotPath = path.join(externalRoot, `${taskId}-code-receipt-external.json`);
        fs.writeFileSync(externalReceiptSnapshotPath, originalReceiptText, 'utf8');
        updateLatestHistoricalReviewRecordedDetails(repoRoot, taskId, 'code', (details) => {
            details.receipt_snapshot_path = path.normalize(externalReceiptSnapshotPath).replace(/\\/g, '/');
        });

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot path must reference canonical runtime review artifact')));

        fs.rmSync(externalRoot, { recursive: true, force: true });
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse historical review-recorded evidence when the review artifact path uses parent traversal', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-reuse-traversal-review-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject historical review evidence with a traversal review artifact path'
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

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const originalReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const traversalArtifactDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'outside');
        fs.mkdirSync(traversalArtifactDir, { recursive: true });
        const historicalDetails = readTaskTimelineEvents(repoRoot, taskId)
            .reverse()
            .find((event) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                return (
                    event.event_type === 'REVIEW_RECORDED'
                    && details
                    && String(details.review_type || details.reviewType || '').trim().toLowerCase() === 'code'
                    && details.reused_existing_review !== true
                );
            })?.details as Record<string, unknown>;
        assert.ok(historicalDetails);
        const artifactSnapshotSha256 = String(historicalDetails.review_artifact_snapshot_sha256 || '').trim();
        assert.ok(artifactSnapshotSha256);
        const traversalArtifactPath = path.join(traversalArtifactDir, `${taskId}-code-artifact-${artifactSnapshotSha256}.md`);
        fs.copyFileSync(path.join(reviewsRoot, `${taskId}-code-artifact-${artifactSnapshotSha256}.md`), traversalArtifactPath);
        updateLatestHistoricalReviewRecordedDetails(repoRoot, taskId, 'code', (details) => {
            details.review_artifact_snapshot_path = `garda-agent-orchestrator/runtime/reviews/../outside/${taskId}-code-artifact-${artifactSnapshotSha256}.md`;
        });

        fs.mkdirSync(path.join(repoRoot, 'scratch'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'scratch', 'foreign.ts'), 'export const unrelated = true;\n', 'utf8');
        const pollutedPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'scratch/foreign.ts'],
            metrics: { changed_lines_total: 6 },
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
        }, `${taskId}-polluted-preflight.json`);
        const pollutedPreflight = JSON.parse(fs.readFileSync(pollutedPreflightPath, 'utf8')) as Record<string, unknown>;
        fs.writeFileSync(receiptPath, JSON.stringify({
            ...originalReceipt,
            code_scope_sha256: computeCodeReviewScopeFingerprint(pollutedPreflight, repoRoot).code_scope_sha256,
            review_scope_sha256: computeReviewRelevantScopeFingerprint(pollutedPreflight, repoRoot).review_scope_sha256
        }, null, 2) + '\n', 'utf8');

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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.ok(result.outputLines.some((line) => line.includes('historical review artifact snapshot path must not contain parent-directory traversal segments')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse the latest mutable receipt when historical telemetry lacks a verifiable source receipt hash', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-latest-receipt-reuse-without-source-receipt-hash';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reject latest mutable receipt reuse when historical telemetry lacks source receipt hashes'
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
        stripLatestHistoricalReceiptSnapshotTelemetry(repoRoot, taskId, 'code');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);
        assert.ok(result.outputLines.some((line) => line.includes('historical review receipt snapshot path is missing from REVIEW_RECORDED telemetry')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence for a docs-only post-review delta', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n\n- Updated docs.\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a docs-only delta'
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
            scope_category: 'docs-only',
            changed_files: ['CHANGELOG.md'],
            metrics: { changed_lines_total: 2 },
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

    it('reuses prior code and test review evidence when only changelog is added after reviews', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-only-code-test-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code and test review evidence after changelog-only delta'
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
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Documented the user-visible change.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 4 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.startsWith('ReviewReuseReason: accepted:')));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, true);

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedTestReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-test-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedTestReceipt.review_scope_sha256,
            computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256
        );
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const testRecordedEvents = events.filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
        ));
        assert.equal((testRecordedEvents.at(-1)?.details as Record<string, unknown>).reused_existing_review, true);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses prior code-review evidence when non-runtime performance support is delegated to performance review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-code-reuse-performance-support';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse code review when only benchmark support changes'
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
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: true },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: accepted'));
        assert.ok(codeBuild.outputLines.some((line) => line.includes('non-runtime performance support file(s) delegated')));

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const refreshedReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        assert.equal(
            refreshedReceipt.code_scope_sha256,
            computeReviewReuseCodeScopeFingerprint('code', preflight, repoRoot).code_scope_sha256
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse code-review evidence for non-runtime performance support without performance review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-code-no-reuse-performance-support';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review when benchmark support is not delegated'
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
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: false },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, false);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(codeBuild.outputLines.some((line) => (
            line.includes('non-runtime performance support file(s)')
            && line.includes('performance review is not required')
            && line.includes('benchmark/reviewed.ts')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse code-review evidence for non-src runtime performance paths', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-runtime-perf-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'apps', 'shop', 'perf'), { recursive: true });
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse code review for runtime performance paths'
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
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'apps', 'shop', 'perf', 'cache.ts'), 'export const cache = "alpha";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'apps/shop/perf/cache.ts'],
            metrics: { changed_lines_total: 4 },
            triggers: { performance: true },
            required_reviews: {
                code: true,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, false);
        assert.ok(codeBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(codeBuild.outputLines.some((line) => line.includes('non-test scope changed')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse performance-review evidence when benchmark support content changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-performance-support-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'benchmark'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "alpha";\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse performance review after benchmark support changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 3 },
            triggers: { performance: true },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const performanceReviewContextPath = path.join(reviewsRoot, `${taskId}-performance-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'performance',
            'PERFORMANCE REVIEW PASSED',
            priorPreflightPath,
            performanceReviewContextPath,
            'agent:performance-reviewer'
        );

        fs.writeFileSync(path.join(repoRoot, 'benchmark', 'reviewed.ts'), 'export const benchmark = "bravo";\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['benchmark/reviewed.ts'],
            metrics: { changed_lines_total: 3 },
            triggers: { performance: true },
            required_reviews: {
                code: false,
                db: false,
                security: false,
                refactor: false,
                api: false,
                test: false,
                performance: true,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const performanceBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'performance',
            depth: 2,
            preflightPath,
            outputPath: performanceReviewContextPath
        });
        assert.equal(performanceBuild.reusedReviewEvidence, false);
        assert.ok(performanceBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(performanceBuild.outputLines.some((line) => line.includes('non-test scope changed')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior test-review evidence when a test file changes after the review', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-test-change-no-test-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse test review evidence after test file changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
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
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works after change", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
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

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, false);

        const testContext = JSON.parse(fs.readFileSync(testReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = testContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('reuses non-test review evidence when only tests change after domain reviews', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-domain-reuse-after-test-delta';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 5;\nconst b = 7;\nconsole.log(a + b);\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Reuse non-test reviews when a later delta only changes tests'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        const testReviewContextPath = path.join(reviewsRoot, `${taskId}-test-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', priorPreflightPath, securityReviewContextPath, 'agent:security-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'test', 'TEST REVIEW PASSED', priorPreflightPath, testReviewContextPath, 'agent:test-reviewer');

        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works after the test-only delta", () => {});\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'code',
            changed_files: ['src/app.ts', 'tests/app.test.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: codeReviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, true);
        assert.ok(securityBuild.outputLines.includes('ReviewReuseDecision: accepted'));

        const testBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'test',
            depth: 2,
            preflightPath,
            outputPath: testReviewContextPath
        });
        assert.equal(testBuild.reusedReviewEvidence, false);
        assert.ok(testBuild.outputLines.includes('ReviewReuseDecision: rejected'));
        assert.ok(testBuild.outputLines.some((line) => line.includes('review-relevant scope changed')));

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => event.event_type === 'REVIEW_RECORDED');
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
                && (event.details as Record<string, unknown> | undefined)?.reused_existing_review === true
            )),
            true
        );
        assert.equal(
            currentRecordedEvents.some((event) => (
                String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'test'
            )),
            false
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse legacy non-test review evidence through a newer peer code receipt after code changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-legacy-domain-reuse-after-code-change';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse legacy domain review evidence after code changes'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', priorPreflightPath, codeReviewContextPath, 'agent:old-code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', priorPreflightPath, securityReviewContextPath, 'agent:security-reviewer');

        const securityReceiptPath = path.join(reviewsRoot, `${taskId}-security-receipt.json`);
        const securityReceipt = JSON.parse(fs.readFileSync(securityReceiptPath, 'utf8')) as Record<string, unknown>;
        securityReceipt.code_scope_sha256 = null;
        fs.writeFileSync(securityReceiptPath, JSON.stringify(securityReceipt, null, 2) + '\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 10;\nconst b = 20;\nconsole.log(a + b);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 4 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:new-code-reviewer');

        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, false);

        const securityContext = JSON.parse(fs.readFileSync(securityReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = securityContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentSecurityRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
        ));
        assert.equal(currentSecurityRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse legacy non-test review evidence through a same-preflight peer code receipt after code changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-same-preflight-legacy-domain-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse legacy domain review evidence through same-preflight peer code scope'
        });

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: true,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        const codeReviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const securityReviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:old-code-reviewer');
        seedReusableReviewEvidence(repoRoot, taskId, 'security', 'SECURITY REVIEW PASSED', preflightPath, securityReviewContextPath, 'agent:security-reviewer');

        const securityReceiptPath = path.join(reviewsRoot, `${taskId}-security-receipt.json`);
        const securityReceipt = JSON.parse(fs.readFileSync(securityReceiptPath, 'utf8')) as Record<string, unknown>;
        securityReceipt.code_scope_sha256 = null;
        fs.writeFileSync(securityReceiptPath, JSON.stringify(securityReceipt, null, 2) + '\n', 'utf8');

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 10;\nconst b = 20;\nconsole.log(a + b);\n', 'utf8');
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);
        seedReusableReviewEvidence(repoRoot, taskId, 'code', 'REVIEW PASSED', preflightPath, codeReviewContextPath, 'agent:new-code-reviewer');

        const securityBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: securityReviewContextPath
        });
        assert.equal(securityBuild.reusedReviewEvidence, false);

        const securityContext = JSON.parse(fs.readFileSync(securityReviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = securityContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentSecurityRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'security'
        ));
        assert.equal(currentSecurityRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse review evidence after rule context content changes', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-rule-context-change';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse review evidence after reviewer rule context changes'
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

        fs.appendFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', '00-core.md'),
            '\nReviewer rule content changed after the prior review.\n',
            'utf8'
        );
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 1 },
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

        const build = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(build.reusedReviewEvidence, false);

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);
        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        const currentRecordedEvents = events.slice(latestCompileSequence + 1).filter((event) => (
            event.event_type === 'REVIEW_RECORDED'
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(currentRecordedEvents.length, 0);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence for a mixed docs plus code delta', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-docs-plus-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a mixed docs and code delta'
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

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 2;\nconst b = 3;\nconsole.log(a + b);\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Runtime code changed.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/app.ts', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 6 },
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

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence without historical REVIEW_RECORDED binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-record-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence without recorded review binding'
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

        const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
        const withoutHistoricalRecord = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => {
                if (!line.trim()) {
                    return false;
                }
                const event = JSON.parse(line) as Record<string, unknown>;
                return event.event_type !== 'REVIEW_RECORDED';
            })
            .join('\n') + '\n';
        fs.writeFileSync(timelinePath, withoutHistoricalRecord, 'utf8');

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

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence without historical reviewer tree-state binding', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-historical-tree-state-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence without reviewer tree-state binding'
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
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'code',
            'REVIEW PASSED',
            priorPreflightPath,
            reviewContextPath,
            'agent:code-reviewer',
            { omitInvocationTreeState: true }
        );

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
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);
        assert.ok(result.outputLines.some((line) => line.includes('prior review provenance does not bind to the historical review-tree-state hash')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse prior code-review evidence when receipt scope hashes diverge from historical REVIEW_RECORDED telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-tampered-scope-binding';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse historical review evidence with tampered receipt scope hashes'
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

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const changed = true;\nconsole.log(changed);\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 4 },
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

        buildReviewContext({
            reviewType: 'code',
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-code-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });

        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const currentReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const tamperedReceipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        tamperedReceipt.code_scope_sha256 = computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256;
        tamperedReceipt.review_scope_sha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
        tamperedReceipt.review_context_reuse_sha256 = computeReviewContextReuseHash(currentReviewContext);
        fs.writeFileSync(receiptPath, JSON.stringify(tamperedReceipt, null, 2) + '\n', 'utf8');

        const result = await runBuildReviewContextCommand({
            reviewType: 'code',
            depth: '2',
            preflightPath,
            outputPath: reviewContextPath,
            repoRoot
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when CLI-loaded receipt fields diverge from current reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-loads-reuse-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must validate CLI-loaded reused receipt fields'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reused_from_review_context_reuse_sha256 = '9'.repeat(64);
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes("Review 'code' is missing current-cycle REVIEW_RECORDED reuse telemetry")
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate does not report missing current-cycle reuse telemetry when a later valid event exists', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-skips-earlier-invalid-reuse-event';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate should use the latest valid strict reuse telemetry'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        insertTaskEventWithoutIntegrityBeforeLatest(
            repoRoot,
            taskId,
            'REVIEW_RECORDED',
            'PASS',
            'stale current-cycle reuse event without integrity',
            {
                review_type: 'code',
                reused_existing_review: true,
                receipt_path: path.normalize(receiptPath).replace(/\\/g, '/')
            },
            (event) => {
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : {};
                return (
                    event.event_type === 'REVIEW_RECORDED'
                    && details.reused_existing_review === true
                    && String(details.review_type || details.reviewType || '').toLowerCase() === 'code'
                );
            }
        );

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE, reviewResult.outputLines.join('\n'));
        assert.equal(
            reviewResult.outputLines.some((line) => line.includes("Review 'code' is missing current-cycle REVIEW_RECORDED reuse telemetry")),
            false
        );
        assert.equal(
            reviewResult.outputLines.some((line) => line.includes('Workspace changed after compile gate')),
            true
        );

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when the historical source receipt snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-rejects-tampered-source-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must verify historical source receipt snapshots for reused evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalReceiptSnapshot(repoRoot, taskId, 'code');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('review gate rejects reused receipts when the historical source artifact snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-review-gate-rejects-tampered-source-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Review gate must verify historical source artifact snapshots for reused evidence'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);

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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalArtifactSnapshot(repoRoot, taskId, 'code');

        const reviewResult = runRequiredReviewsCheckCommand({
            repoRoot,
            taskId,
            preflightPath,
            codeReviewVerdict: 'REVIEW PASSED',
            emitMetrics: false
        });
        assert.equal(reviewResult.exitCode, EXIT_GATE_FAILURE);
        assert.equal(reviewResult.outputLines[0], 'REVIEW_GATE_FAILED');
        assert.ok(reviewResult.outputLines.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the historical source receipt snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-tampered-source-receipt';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify historical source receipt snapshots for reused evidence'
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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalReceiptSnapshot(repoRoot, taskId, 'code');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the historical source artifact snapshot is tampered after reuse telemetry', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-tampered-source-artifact';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify historical source artifact snapshots for reused evidence'
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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);
        tamperLatestHistoricalArtifactSnapshot(repoRoot, taskId, 'code');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContext: JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('historical REVIEW_RECORDED telemetry')
            || line.includes('current-cycle REVIEW_RECORDED reuse telemetry')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('completion review-skill evidence rejects reused receipts when the current review context file drifts', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-completion-rejects-current-context-drift';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Completion validation must verify current reused review context files'
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
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const codeBuild = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });
        assert.equal(codeBuild.reusedReviewEvidence, true);

        const tamperedReviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        tamperedReviewContext.post_review_tamper = true;
        fs.writeFileSync(reviewContextPath, JSON.stringify(tamperedReviewContext, null, 2) + '\n', 'utf8');

        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const receiptPath = path.join(reviewsRoot, `${taskId}-code-receipt.json`);
        const timelinePath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
        const reviewSkillEvidence = validateReviewSkillEvidence(
            readTaskTimelineEvents(repoRoot, taskId) as any,
            { code: true },
            {
                code: {
                    path: artifactPath,
                    content: fs.readFileSync(artifactPath, 'utf8'),
                    reviewContextPath,
                    reviewContext: tamperedReviewContext,
                    receipt: JSON.parse(fs.readFileSync(receiptPath, 'utf8'))
                }
            },
            true,
            timelinePath,
            'Qwen',
            'Qwen',
            false,
            'provider_entrypoint',
            undefined,
            repoRoot
        );
        assert.ok(reviewSkillEvidence.violations.some((line) => (
            line.includes('review_context_sha256 does not match the current review-context file')
        )));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse failed review artifacts as current evidence', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-failed-review-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse failed security review evidence'
        });

        const priorPreflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['src/app.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: false,
                performance: false,
                infra: false,
                dependency: false
            }
        }, `${taskId}-prior-preflight.json`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-security-review-context.json`);
        seedReusableReviewEvidence(
            repoRoot,
            taskId,
            'security',
            'SECURITY REVIEW FAILED',
            priorPreflightPath,
            reviewContextPath,
            'agent:security-reviewer'
        );
        const artifactPath = path.join(reviewsRoot, `${taskId}-security.md`);
        const artifactWithStrayPass = fs.readFileSync(artifactPath, 'utf8')
            .replace(
                '## Findings by Severity\nnone',
                '## Findings by Severity\nA prior failed review mentioned this literal token in explanatory text.\nSECURITY REVIEW PASSED'
            );
        fs.writeFileSync(artifactPath, artifactWithStrayPass, 'utf8');
        const artifactHash = require('node:crypto').createHash('sha256').update(artifactWithStrayPass).digest('hex');
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_artifact_sha256 = artifactHash;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
        const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
        const timeline = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .map((line) => {
                if (!line.trim()) {
                    return line;
                }
                const event = JSON.parse(line) as Record<string, unknown>;
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                if (
                    event.event_type === 'REVIEW_RECORDED'
                    && details
                    && String(details.review_type || '').toLowerCase() === 'security'
                ) {
                    details.review_artifact_sha256 = artifactHash;
                }
                return JSON.stringify(event);
            })
            .join('\n');
        fs.writeFileSync(timelinePath, timeline.endsWith('\n') ? timeline : `${timeline}\n`, 'utf8');

        const preflightPath = writePreflight(repoRoot, taskId, {
            changed_files: ['tests/app.test.ts'],
            metrics: { changed_lines_total: 3 },
            required_reviews: {
                code: false,
                db: false,
                security: true,
                refactor: false,
                api: false,
                test: true,
                performance: false,
                infra: false,
                dependency: false
            }
        });
        writeCompilePassEvidence(repoRoot, taskId, preflightPath);

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'security',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not reuse review artifacts with a malformed verdict section and stray pass token', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-malformed-verdict-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Do not reuse malformed verdict review evidence'
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
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const malformedArtifact = fs.readFileSync(artifactPath, 'utf8')
            .replace('## Verdict\nREVIEW PASSED', '## Verdict\nNeeds follow-up before reuse.\n\n## Notes\nREVIEW PASSED');
        fs.writeFileSync(artifactPath, malformedArtifact, 'utf8');
        const artifactHash = require('node:crypto').createHash('sha256').update(malformedArtifact).digest('hex');
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_artifact_sha256 = artifactHash;
        fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + '\n', 'utf8');
        const timelinePath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events', `${taskId}.jsonl`);
        const timeline = fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .map((line) => {
                if (!line.trim()) {
                    return line;
                }
                const event = JSON.parse(line) as Record<string, unknown>;
                const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown>
                    : null;
                if (
                    event.event_type === 'REVIEW_RECORDED'
                    && details
                    && String(details.review_type || '').toLowerCase() === 'code'
                ) {
                    details.review_artifact_sha256 = artifactHash;
                }
                return JSON.stringify(event);
            })
            .join('\n');
        fs.writeFileSync(timelinePath, timeline.endsWith('\n') ? timeline : `${timeline}\n`, 'utf8');

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

        const result = await runBuildReviewContextCommand({
            repoRoot,
            reviewType: 'code',
            depth: 2,
            preflightPath,
            outputPath: reviewContextPath
        });

        assert.equal(result.reusedReviewEvidence, false);
        assert.equal(result.reusedReceiptPath, null);

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('does not treat doc-named runtime code paths as docs-only reuse deltas', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-doc-named-runtime-code-no-reuse';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Qwen');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'src', 'docs'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'src', 'docs', 'page.tsx'), 'export const Page = () => null;\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'CHANGELOG.md'), '# Changelog\n', 'utf8');
        runEnterTaskMode({
            repoRoot,
            taskId,
            taskSummary: 'Seed reusable code review evidence before a doc-named runtime code delta'
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

        fs.writeFileSync(path.join(repoRoot, 'src', 'docs', 'page.tsx'), 'export const Page = () => <main>docs app</main>;\n', 'utf8');
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '- Runtime docs page changed.\n', 'utf8');
        const preflightPath = writePreflight(repoRoot, taskId, {
            scope_category: 'mixed',
            changed_files: ['src/docs/page.tsx', 'CHANGELOG.md'],
            metrics: { changed_lines_total: 5 },
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

        const fingerprint = computeCodeReviewScopeFingerprint(JSON.parse(fs.readFileSync(preflightPath, 'utf8')), repoRoot);
        assert.deepEqual(fingerprint.non_test_changed_files, ['src/docs/page.tsx']);
        assert.deepEqual(fingerprint.docs_only_changed_files, ['CHANGELOG.md']);

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

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing as Record<string, unknown>;
        assert.equal(reviewerRouting.actual_execution_mode, null);
        assert.equal(reviewerRouting.reviewer_session_id, null);

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
        assert.equal(refreshedReceipt.reused_existing_review, true);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const currentCycleCodeEvents = events
            .map((event, index) => ({ event, index }))
            .filter(({ event, index }) => (
                index > latestCompileSequence
                && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED' || event.event_type === 'REVIEW_RECORDED')
                && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
            ));
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length,
            0
        );
        assert.equal(
            currentCycleCodeEvents.filter(({ event }) => event.event_type === 'REVIEWER_INVOCATION_ATTESTED').length,
            0
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
        const priorReceipt = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot, `${taskId}-code-receipt.json`), 'utf8')
        ) as Record<string, unknown>;
        const priorProvenance = priorReceipt.reviewer_provenance as Record<string, unknown>;

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
        assert.equal(refreshedReceipt.trust_level, 'INDEPENDENT_AUDITED');
        assert.equal(refreshedReceipt.reused_existing_review, true);
        const refreshedProvenance = refreshedReceipt.reviewer_provenance as Record<string, unknown> | null;
        assert.ok(refreshedProvenance);
        assert.deepEqual(refreshedProvenance, priorProvenance);
        assert.equal(refreshedReceipt.reused_from_review_context_sha256, priorReceipt.review_context_sha256);

        const refreshedContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const refreshedRouting = refreshedContext.reviewer_routing as Record<string, unknown>;
        assert.equal(refreshedRouting.actual_execution_mode, null);
        assert.equal(refreshedRouting.reviewer_session_id, null);

        const events = readTaskTimelineEvents(repoRoot, taskId);
        const latestCompileSequence = findLastTimelineEventIndex(events, (event) => event.event_type === 'COMPILE_GATE_PASSED');
        assert.ok(latestCompileSequence >= 0);
        const currentCycleLaunchEvents = events.filter((event, index) => (
            index > latestCompileSequence
            && (event.event_type === 'REVIEWER_DELEGATION_ROUTED' || event.event_type === 'REVIEWER_INVOCATION_ATTESTED')
            && String((event.details as Record<string, unknown> | undefined)?.review_type || '').toLowerCase() === 'code'
        ));
        assert.equal(currentCycleLaunchEvents.length, 0);

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

        assert.equal(observedExitCode, EXIT_GENERAL_FAILURE);
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
