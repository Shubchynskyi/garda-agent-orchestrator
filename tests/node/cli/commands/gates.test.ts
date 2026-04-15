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
    runClassifyChangeCommand,
    runCompileGateCommand,
    runDocImpactGateCommand,
    runEnterTaskModeCommand,
    runHumanCommitCommand,
    runLoadRulePackCommand,
    runLogTaskEventCommand,
    runRecordNoOpCommand,
    runRequiredReviewsCheckCommand,
    splitCommandLine,
    executeCommand
} from '../../../../src/cli/commands/gates';
import { runCliMainWithHandling } from '../../../../src/cli/main';
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

function writeDriftedProtectedManifest(repoRoot: string, changedFiles: string[] = ['garda-agent-orchestrator/live/docs/agent-rules/00-core.md']): void {
    const manifestPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'protected-control-plane-manifest.json');
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    const protectedSnapshot: Record<string, string> = {};
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
    outputFileName = `${taskId}-preflight.json`
): string {
    const preflightPath = path.join(getReviewsRoot(repoRoot), outputFileName);
    const result = runClassifyChangeCommand({
        repoRoot,
        taskId,
        taskIntent,
        changedFiles,
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
        reviewer_routing: {
            source_of_truth: 'Codex',
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: 'agent:test-reviewer'
        }
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
    reviewerIdentity = 'agent:test-reviewer'
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
        tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
        scopedDiffMetadataPath,
        outputPath: reviewContextPath,
        repoRoot
    });
    const routingUpdate = applyReviewerRoutingMetadata(reviewContextPath, {
        actualExecutionMode: 'delegated_subagent',
        reviewerSessionId: reviewerIdentity,
        fallbackReason: null
    });
    const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const reviewContextHash = String(routingUpdate.contextSha256 || crypto.createHash('sha256').update(reviewContextText).digest('hex'));
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
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.writeFileSync(path.join(reviewsRoot, `${taskId}-handshake.json`), JSON.stringify({
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'handshake-diagnostics',
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        provider,
        canonical_entrypoint: 'AGENTS.md',
        canonical_entrypoint_exists: true,
        provider_bridge: null,
        provider_bridge_exists: false,
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

function loadTaskEntryRulePack(repoRoot: string, taskId: string) {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'TASK_ENTRY',
        loadedRuleFiles: [
            '00-core.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ],
        emitMetrics: false
    });
}

function loadPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string) {
    return runLoadRulePackCommand({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
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
    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(artifactContent).digest('hex');
    appendTaskEvent(
        orchestratorRoot,
        taskId,
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'PASS',
        `Handshake diagnostics passed: provider=${provider}, context=materialized-bundle.`,
        { provider, execution_context: 'materialized-bundle', cli_path: 'node garda-agent-orchestrator/bin/garda.js', passed: true, artifact_hash: artifactHash },
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
    it('splits quoted command lines', () => {
        assert.deepEqual(
            splitCommandLine('node -e "console.log(\'ok\')"'),
            ['node', '-e', "console.log('ok')"]
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
        runEnterTaskModeCommand({
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

    it('classifies explicit changed files and writes preflight artifact', () => {
        const repoRoot = createTempRepo();
        const outputPath = path.join(repoRoot, 'preflight.json');
        seedTaskQueue(repoRoot, 'T-900');
        seedInitAnswers(repoRoot);
        runEnterTaskModeCommand({
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
        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

    it('captures a dirty workspace baseline when entering task mode', { concurrency: false }, () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900dirty-baseline';
        fs.writeFileSync(path.join(repoRoot, '.gitignore'), 'TASK.md\ngarda-agent-orchestrator/runtime/\n', 'utf8');
        initializeGitRepo(repoRoot);
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot);

        fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'const a = 13;\nconst b = 21;\nconsole.log(a + b);\n', 'utf8');
        fs.writeFileSync(path.join(repoRoot, 'src', 'unrelated.ts'), 'export const unrelated = true;\n', 'utf8');

        const result = runEnterTaskModeCommand({
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
        runEnterTaskModeCommand({
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
        runEnterTaskModeCommand({
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
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskModeCommand({
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

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('uses explicit provider override for task-mode routing evidence', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-900c-provider';
        seedTaskQueue(repoRoot, taskId, 'TODO');
        seedInitAnswers(repoRoot, 'Qwen');

        const result = runEnterTaskModeCommand({
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
            () => runEnterTaskModeCommand({
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
            () => runEnterTaskModeCommand({
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

        const taskModeResult = runEnterTaskModeCommand({
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

        const taskModeResult = runEnterTaskModeCommand({
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

        const taskModeResult = runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Update app flow'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        // T-003: code-changing tasks must carry PREFLIGHT_CLASSIFIED evidence
        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Preflight completed with mode FULL_PATH.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

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
        assert.equal(reviewResult.exitCode, 0);

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Recover a later coherent completion cycle'
        });
        runHandshakeForTask(repoRoot, taskId);
        loadTaskEntryRulePack(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Preflight completed with mode FULL_PATH.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

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
        assert.equal(reviewResult.exitCode, 0);

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject cross-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Initial preflight completed with mode FULL_PATH.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject missing same-cycle compile backfill in completion gate'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Initial preflight completed with mode FULL_PATH.',
            { mode: 'FULL_PATH', changed_files_count: 1, changed_lines_total: 3, required_reviews: { code: true } }
        );

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Implement lifecycle hardening'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);

        appendTaskEvent(
            getOrchestratorRoot(repoRoot),
            taskId,
            'PREFLIGHT_CLASSIFIED',
            'INFO',
            'Preflight completed with mode FULL_PATH (zero-diff baseline only).',
            {
                mode: 'FULL_PATH',
                changed_files_count: 0,
                changed_lines_total: 0,
                required_reviews: { code: false },
                zero_diff_guard: { zero_diff_detected: true, status: 'BASELINE_ONLY' }
            }
        );

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

        runEnterTaskModeCommand({
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
        assert.equal(reviewResult.exitCode, 0);

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

    it('logs task events with terminal cleanup and command audit', () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904';
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const compileOutputPath = path.join(reviewsRoot, `${taskId}-compile-output.log`);
        fs.writeFileSync(compileOutputPath, 'temporary compile output\n', 'utf8');
        fs.writeFileSync(path.join(reviewsRoot, `${taskId}-compile-gate.json`), JSON.stringify({
            task_id: taskId,
            compile_output_path: `garda-agent-orchestrator/runtime/reviews/${taskId}-compile-output.log`
        }, null, 2), 'utf8');

        const result = runLogTaskEventCommand({
            repoRoot,
            taskId,
            eventType: 'TASK_DONE',
            outcome: 'PASS',
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
        assert.equal(fs.existsSync(compileOutputPath), false);

        fs.rmSync(repoRoot, { recursive: true, force: true });
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
        writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
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
        assert.ok(fs.readFileSync(artifactPath, 'utf8').includes('## Verdict\nREVIEW PASSED'));

        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8'));
        assert.equal(reviewContext.reviewer_routing.actual_execution_mode, 'delegated_subagent');
        assert.equal(reviewContext.reviewer_routing.reviewer_session_id, 'agent:code-reviewer');

        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
        assert.equal(receipt.reviewer_execution_mode, 'delegated_subagent');
        assert.equal(receipt.reviewer_identity, 'agent:code-reviewer');

        const events = readTaskTimelineEvents(repoRoot, taskId);
        assert.equal(events.filter((event) => event.event_type === 'REVIEWER_DELEGATION_ROUTED').length, 1);
        assert.equal(events.filter((event) => event.event_type === 'REVIEW_RECORDED').length, 1);
        assert.ok(capturedLogs.some((line) => line.includes('VerdictToken: REVIEW PASSED')));

        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    it('record-review-result materializes delegated reviewer output with a failed verdict token', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-result-failed';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const preflightPath = writePreflight(repoRoot, taskId);
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
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
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
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
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback',
                fallback_allowed: true,
                fallback_reason_required: true,
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
            'Validated fallback-mode ingestion through the combined result gate.',
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(reviewsRoot, { recursive: true });
        const artifactPath = path.join(reviewsRoot, `${taskId}-code.md`);
        const reviewContextPath = path.join(reviewsRoot, `${taskId}-code-review-context.json`);
        const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
        fs.writeFileSync(reviewContextPath, JSON.stringify({
            review_type: 'code',
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
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
            'Validated the receipt-lock failure path with realistic delegated reviewer output.',
            '',
            '## Findings by Severity',
            'none',
            '',
            '## Residual Risks',
            'none',
            '',
            '## Verdict',
            '- REVIEW PASSED'
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

        runEnterTaskModeCommand({
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

    it('does not reuse prior code-review evidence when the code scope fingerprint changed', async () => {
        const repoRoot = createTempRepo();
        const taskId = 'T-904a-no-reuse-code-review';
        seedTaskQueue(repoRoot, taskId);
        seedInitAnswers(repoRoot, 'Codex');
        const reviewsRoot = getReviewsRoot(repoRoot);
        fs.mkdirSync(path.join(repoRoot, 'tests'), { recursive: true });
        fs.writeFileSync(path.join(repoRoot, 'tests', 'app.test.ts'), 'it("works", () => {});\n', 'utf8');

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
        runEnterTaskModeCommand({
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                fallback_allowed: true,
                fallback_reason_required: true,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                fallback_allowed: true,
                fallback_reason_required: true,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: 'delegated_subagent',
                reviewer_session_id: 'agent:test-reviewer',
                fallback_reason: null
            }
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
            reviewer_routing: {
                source_of_truth: 'Qwen',
                capability_level: 'single_agent_only',
                expected_execution_mode: 'same_agent_fallback',
                fallback_allowed: true,
                fallback_reason_required: true,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Validate delegated test review flow',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 1,
            changed_lines_total: 3,
            required_reviews: { test: true }
        });

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
            reviewer_routing: {
                source_of_truth: 'Codex',
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Block downstream test review until code review is recorded',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 12,
            required_reviews: { code: true, test: true }
        });

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Keep downstream test review blocked until upstream code review is gate-eligible',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 12,
            required_reviews: { code: true, test: true }
        });

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
        assert.equal(codeReviewRecordExitCode, 0);
        assert.ok(blockedExitCode !== 0, `Expected non-zero exit code, got ${blockedExitCode}`);
        assert.equal(blockedAttemptTestPhaseCount, 0);
        assert.ok(
            blockedErrorOutput.includes("ReviewType 'test' is blocked until upstream reviews pass for the current cycle: code."),
            blockedErrorOutput
        );
        assert.ok(
            blockedErrorOutput.includes('trivial or obviously synthetic'),
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Block downstream test review materialization until upstream code review passes current cycle',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 12,
            required_reviews: { code: true, test: true }
        });

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
            reviewer_routing: {
                source_of_truth: 'Codex',
                capability_level: 'delegation_capable',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: false,
                fallback_reason_required: false,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
        }, null, 2) + '\n', 'utf8');
        fs.writeFileSync(testReviewOutputPath, [
            '# Review',
            '',
            'Validated the downstream test-review materialization path against current-cycle review sequencing evidence.',
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Allow downstream test review after code review was recorded from a custom context path',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 12,
            required_reviews: { code: true, test: true }
        });

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Prefer canonical review-context artifacts over stale legacy default files',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 1,
            changed_lines_total: 8,
            required_reviews: { code: true }
        });

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Keep downstream test review blocked when legacy custom upstream review contexts fail strict gate validation',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 12,
            required_reviews: { code: true, test: true }
        });

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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject foreign review-context materialization for delegated review evidence',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 2,
            changed_lines_total: 10,
            required_reviews: { code: true, test: true }
        });
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
                'Validated the current implementation and found no blocking code-level defects in the scoped change.',
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Reject legacy custom review-context artifacts without fresh-cycle binding metadata',
            provider: 'Codex'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId);
        runShellSmokeForTask(repoRoot, taskId);
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 1,
            changed_lines_total: 3,
            required_reviews: { code: true }
        });
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
                'Validated the scoped implementation and found no blocking issues.',
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

        runEnterTaskModeCommand({
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

        runEnterTaskModeCommand({
            repoRoot,
            taskId,
            taskSummary: 'Validate fallback review flow',
            provider: 'Antigravity'
        });
        loadTaskEntryRulePack(repoRoot, taskId);
        runHandshakeForTask(repoRoot, taskId, 'Antigravity');
        runShellSmokeForTask(repoRoot, taskId, 'Antigravity');
        loadPostPreflightRulePack(repoRoot, taskId, preflightPath);
        appendTaskEvent(getOrchestratorRoot(repoRoot), taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', 'Preflight completed with mode FULL_PATH.', {
            mode: 'FULL_PATH',
            changed_files_count: 1,
            changed_lines_total: 3,
            required_reviews: { code: true }
        });

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
            reviewer_routing: {
                source_of_truth: 'Antigravity',
                capability_level: 'delegation_conditional',
                expected_execution_mode: 'delegated_subagent',
                fallback_allowed: true,
                fallback_reason_required: true,
                actual_execution_mode: null,
                reviewer_session_id: null,
                fallback_reason: null
            }
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
});
