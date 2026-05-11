import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import { buildReviewContext } from '../../../../src/gates/build-review-context';
import { buildReviewTreeState } from '../../../../src/gates/review-tree-state';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile-gate';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint
} from '../../../../src/gates/review-reuse';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance
} from '../../../../src/gate-runtime/review-context';
import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { resolveReviewerRoutingPolicy } from '../../../../src/gates/reviewer-routing';

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function createReviewerRoutingFixture(
    sourceOfTruth: string,
    executionProviderSource: 'provider_entrypoint' | 'provider_bridge' = 'provider_entrypoint',
    overrides: Record<string, unknown> = {}
): Record<string, unknown> {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const routingPolicy = resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource);
    return {
        source_of_truth: normalizedSourceOfTruth,
        canonical_source_of_truth: normalizedSourceOfTruth,
        execution_provider: normalizedSourceOfTruth,
        execution_provider_source: executionProviderSource,
        identity_status: 'resolved',
        capability_level: routingPolicy.capability_level,
        delegation_required: routingPolicy.delegation_required,
        expected_execution_mode: routingPolicy.expected_execution_mode,
        fallback_allowed: routingPolicy.fallback_allowed,
        fallback_reason_required: routingPolicy.fallback_reason_required,
        actual_execution_mode: null,
        reviewer_session_id: null,
        fallback_reason: null,
        ...overrides
    };
}

function resolveReviewerExecutionFixture(
    _taskId: string,
    sourceOfTruth = 'Codex',
    executionProviderSource: 'provider_entrypoint' | 'provider_bridge' = 'provider_entrypoint',
    delegatedIdentity = 'agent:test-reviewer'
) {
    const routingPolicy = resolveReviewerRoutingPolicy(sourceOfTruth, executionProviderSource);
    const reviewerExecutionMode = routingPolicy.expected_execution_mode;
    return {
        reviewerExecutionMode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'INDEPENDENT_AUDITED'
    } as const;
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
    seedProjectMemoryOffWorkflowConfig(root);
    return root;
}

function seedProjectMemoryOffWorkflowConfig(repoRoot: string): void {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'workflow-config.json'), JSON.stringify({
        full_suite_validation: {
            enabled: false,
            command: 'npm test',
            timeout_ms: 600000,
            green_summary_max_lines: 5,
            red_failure_chunk_lines: 50,
            out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
        },
        review_execution_policy: {
            mode: 'code_first_optional'
        },
        project_memory_maintenance: {
            enabled: false,
            mode: 'check',
            run_before_final_closeout: true,
            require_user_approval_for_writes: true,
            max_compact_summary_chars: 12000,
            read_strategy: 'index_first',
            impact_artifact_retention_days: 30
        }
    }, null, 2), 'utf8');
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

function loadTaskEventsIoModule(): { appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>; } {
    const taskEventsIoModule = require(path.join(__dirname, '../../../../src/gate-runtime/task-events-io.js')) as {
        appendMandatoryTaskEventAsync: (...args: unknown[]) => Promise<unknown>;
    };
    const lifecycleAppendProxy = {} as { appendTaskEventAsync: (...args: unknown[]) => Promise<unknown>; };
    Object.defineProperty(lifecycleAppendProxy, 'appendTaskEventAsync', {
        configurable: true,
        enumerable: true,
        get() {
            return taskEventsIoModule.appendMandatoryTaskEventAsync;
        },
        set(value: (...args: unknown[]) => Promise<unknown>) {
            taskEventsIoModule.appendMandatoryTaskEventAsync = value;
        }
    });
    return lifecycleAppendProxy;
}

function loadTimelineSummaryModule(): { reconcileTimelineSummaryForTask: (...args: unknown[]) => void; } {
    return require(path.join(__dirname, '../../../../src/gate-runtime/timeline-summary.js')) as {
        reconcileTimelineSummaryForTask: (...args: unknown[]) => void;
    };
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

function readReviewPreflightFixture(repoRoot: string, taskId: string): {
    preflightPath: string;
    preflightSha256: string | null;
    preflight: Record<string, unknown>;
} {
    const preflightPath = path.join(getReviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return {
            preflightPath,
            preflightSha256: null,
            preflight: {}
        };
    }

    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const crypto = require('node:crypto');
    return {
        preflightPath,
        preflightSha256: crypto.createHash('sha256').update(preflightText).digest('hex'),
        preflight: JSON.parse(preflightText) as Record<string, unknown>
    };
}

function buildReviewContextTaskScopeFixture(preflight: Record<string, unknown>): Record<string, unknown> {
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : ['src/app.ts'];
    return {
        changed_files: changedFiles,
        changed_file_count: changedFiles.length,
        diff: {
            available: changedFiles.length > 0,
            source: 'fixture_task_diff',
            char_count: changedFiles.length > 0 ? 120 : 0,
            truncated: false
        }
    };
}

function resolveReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || treeState?.treeStateSha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
}

function prepareReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : [];
    if (changedFiles.length === 0) {
        return;
    }

    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGit(repoRoot, ['init']);
    }
    runGit(repoRoot, ['config', 'user.name', 'Garda Tests']);
    runGit(repoRoot, ['config', 'user.email', 'garda-tests@example.com']);
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    if (head.status !== 0) {
        runGit(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
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
            fs.writeFileSync(absolutePath, `// review fixture for ${changedFile}\n`, 'utf8');
        }
    }
}

function writeReceiptBackedReviewArtifact(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    verdict: string,
    contentLines?: string[]
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const execution = resolveReviewerExecutionFixture(taskId, 'Codex');
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
    const preflightFixture = readReviewPreflightFixture(repoRoot, taskId);
    prepareReviewDiffFixture(repoRoot, preflightFixture.preflightPath);
    const crypto = require('node:crypto');
    const promptArtifactPath = reviewContextPath.replace(/\.json$/, '.md');
    const promptArtifactText = [
        `# ${reviewKey} review fixture`,
        '',
        `Fixture prompt artifact for ${taskId}/${reviewKey}.`
    ].join('\n');
    fs.writeFileSync(promptArtifactPath, promptArtifactText, 'utf8');
    const promptArtifactSha256 = crypto.createHash('sha256').update(promptArtifactText).digest('hex');
    const changedFiles = Array.isArray(preflightFixture.preflight.changed_files)
        ? preflightFixture.preflight.changed_files.map((entry) => String(entry || '').replace(/\\/g, '/').trim()).filter(Boolean)
        : [];
    const metrics = preflightFixture.preflight.metrics && typeof preflightFixture.preflight.metrics === 'object' && !Array.isArray(preflightFixture.preflight.metrics)
        ? preflightFixture.preflight.metrics as Record<string, unknown>
        : {};
    const reviewTreeState = buildReviewTreeState({
        repoRoot,
        detectionSource: preflightFixture.preflight.detection_source || 'explicit_changed_files',
        includeUntracked: preflightFixture.preflight.include_untracked !== false,
        changedFiles,
        metrics
    });
    const reviewContext = {
        task_id: taskId,
        review_type: reviewKey,
        preflight_path: preflightFixture.preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightFixture.preflightSha256,
        task_scope: buildReviewContextTaskScopeFixture(preflightFixture.preflight),
        scoped_diff: {
            expected: false,
            metadata_path: path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`).replace(/\\/g, '/'),
            metadata: null
        },
        tree_state: reviewTreeState,
        rule_context: {
            artifact_path: promptArtifactPath.replace(/\\/g, '/'),
            preferred_prompt_artifact: promptArtifactPath.replace(/\\/g, '/'),
            artifact_sha256: promptArtifactSha256,
            token_economy_active: false
        },
        reviewer_routing: createReviewerRoutingFixture('Codex', 'provider_entrypoint', {
            actual_execution_mode: execution.reviewerExecutionMode,
            reviewer_session_id: execution.reviewerIdentity,
            fallback_reason: execution.reviewerFallbackReason
        })
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const reviewTreeStateSha256 = resolveReviewTreeStateSha256(reviewContext);

    // Authenticity hardening: write a verifiable receipt.
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(artifactSnapshotPath, content, 'utf8');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    let reviewerProvenance: ReturnType<typeof buildReviewReceiptReviewerProvenance> | null = null;
    const writeReceipt = () => {
        const scopeSha256 = String((preflightFixture.preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null;
        const reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflightFixture.preflight, repoRoot).review_scope_sha256;
        const codeScopeSha256 = reviewKey === 'code' && preflightFixture.preflightSha256
            ? computeCodeReviewScopeFingerprint(preflightFixture.preflight, repoRoot).code_scope_sha256
            : null;
        const receipt = buildReviewReceipt({
            taskId,
            reviewType: reviewKey,
            preflightSha256: preflightFixture.preflightSha256,
            scopeSha256,
            reviewScopeSha256,
            codeScopeSha256,
            reviewContextSha256: reviewContextHash,
            reviewContextReuseSha256: computeReviewContextReuseHash(JSON.parse(reviewContextText) as Record<string, unknown>),
            reviewTreeStateSha256,
            reviewArtifactSha256: artifactHash,
            reviewerExecutionMode: execution.reviewerExecutionMode,
            reviewerIdentity: execution.reviewerIdentity,
            reviewerFallbackReason: execution.reviewerFallbackReason,
            reviewerProvenance,
            trustLevel: execution.trustLevel
        });
        const receiptText = `${JSON.stringify(receipt, null, 2)}\n`;
        const receiptSha256 = crypto.createHash('sha256').update(receiptText).digest('hex');
        const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptSha256}.json`);
        fs.writeFileSync(receiptPath, receiptText, 'utf8');
        fs.writeFileSync(receiptSnapshotPath, receiptText, 'utf8');
        return { receipt, receiptSha256, receiptSnapshotPath };
    };
    writeReceipt();

    // Emit mandatory telemetry for authenticity
    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    if (fs.existsSync(path.join(orchestratorRoot, 'runtime', 'task-events', `${taskId}.jsonl`))) {
        const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
            review_type: reviewKey
        });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', { skill_id: skillId });
        appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', { reference_path: `/live/skills/${skillId}/SKILL.md` });
        const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
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
            review_tree_state_sha256: reviewTreeStateSha256,
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
        const receiptRecord = writeReceipt();
        appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', {
            ...receiptRecord.receipt,
            receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
            receipt_sha256: receiptRecord.receiptSha256,
            receipt_snapshot_path: path.normalize(receiptRecord.receiptSnapshotPath).replace(/\\/g, '/'),
            receipt_snapshot_sha256: receiptRecord.receiptSha256,
            review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
            review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
            review_artifact_snapshot_sha256: artifactHash,
            review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
        });
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
        sourceOfTruth?: string;
        executionProviderSource?: 'provider_entrypoint' | 'provider_bridge';
        reviewerRoutingOverrides?: Record<string, unknown>;
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
    prepareReviewDiffFixture(repoRoot, preflightPath);
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
    if (options.reviewerRoutingOverrides && Object.keys(options.reviewerRoutingOverrides).length > 0) {
        const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const reviewerRouting = reviewContext.reviewer_routing
            && typeof reviewContext.reviewer_routing === 'object'
            && !Array.isArray(reviewContext.reviewer_routing)
            ? reviewContext.reviewer_routing as Record<string, unknown>
            : {};
        reviewContext.reviewer_routing = {
            ...reviewerRouting,
            ...options.reviewerRoutingOverrides
        };
        fs.writeFileSync(reviewContextPath, JSON.stringify(reviewContext, null, 2) + '\n', 'utf8');
    }
    const execution = resolveReviewerExecutionFixture(
        taskId,
        options.sourceOfTruth || 'Codex',
        options.executionProviderSource || 'provider_entrypoint',
        reviewerIdentity
    );
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
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const reviewTreeStateSha256 = resolveReviewTreeStateSha256(reviewContext);
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const artifactHash = crypto.createHash('sha256').update(artifactText).digest('hex');
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const preflightText = fs.readFileSync(preflightPath, 'utf8');
    const preflight = JSON.parse(preflightText) as Record<string, unknown>;
    const preflightHash = crypto.createHash('sha256').update(preflightText).digest('hex');
    const orchestratorRoot = getOrchestratorRoot(repoRoot);
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'historical review routing recorded', {
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
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routedEvent?.integrity?.event_sha256
    };
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
        codeScopeSha256: reviewKey === 'code'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: reviewContextHash,
        reviewContextReuseSha256: computeReviewContextReuseHash(reviewContext),
        reviewTreeStateSha256,
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

function readTaskQueueStatusFromTaskFile(repoRoot: string, taskId: string): string | null {
    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED|DECOMPOSED)\b/i;
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

export {
    PROVIDER_ENTRYPOINT_BY_SOURCE,
    PROVIDER_BRIDGE_BY_SOURCE,
    escapeRegExp,
    createReviewerRoutingFixture,
    resolveReviewerExecutionFixture,
    captureExpectedAsyncError,
    createTempRepo,
    withDefaultTaskModeRouting,
    runEnterTaskMode,
    seedRuleFiles,
    getReviewsRoot,
    getOrchestratorRoot,
    loadTaskEventsIoModule,
    loadTimelineSummaryModule,
    writePreflight,
    appendPreflightClassifiedEvent,
    writeCompilePassEvidence,
    prepareReviewDiffFixture,
    writeReceiptBackedReviewArtifact,
    writeCleanReviewArtifact,
    seedReusableReviewEvidence,
    seedTaskQueue,
    readTaskQueueStatusFromTaskFile,
    seedInitAnswers,
    writeHandshakeArtifact,
    runGit,
    initializeGitRepo,
    readTaskTimelineEvents,
    loadTaskEntryRulePack,
    loadPostPreflightRulePack,
    runHandshakeForTask,
    writeShellSmokeArtifact,
    runShellSmokeForTask
};
