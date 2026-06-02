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
import * as childProcess from 'node:child_process';
import {createHash} from 'node:crypto';

import {
    runClassifyChangeCommand,
    runEnterTaskModeCommand,
    runLoadRulePackCommand
} from '../../../../src/cli/commands/gates';
import {buildReviewContext} from '../../../../src/gates/review-context/build-review-context';
import {getWorkspaceSnapshot} from '../../../../src/gates/compile/compile-gate';
import {buildScopedDiff} from '../../../../src/gates/preflight/build-scoped-diff';
import {
    buildReviewContextPreflightDiffExpectations
} from '../../../../src/gates/review-context/review-context-contract';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint
} from '../../../../src/gates/review-reuse';
import {buildReviewTreeState} from '../../../../src/gates/review/review-tree-state';
import {resolveDefaultReviewScratchPath} from '../../../../src/gates/review/review-scratch-paths';
import {
    buildReviewerLaunchBindingSha256
} from '../../../../src/cli/commands/gate-review-handlers/launch/review-launch-input-attestation';
import {writeProtectedControlPlaneManifest} from '../../../../src/gates/shared/helpers';
import {getWorkflowConfigPreTaskBaselineState} from '../../../../src/gates/workflow-config/workflow-config-work';
import {resolveReviewerRoutingPolicy} from '../../../../src/gates/review/reviewer-routing';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance
} from '../../../../src/gate-runtime/review-context';
import {appendTaskEvent} from '../../../../src/gate-runtime/task-events';

import {getOrchestratorRoot, getReviewsRoot} from './gate-test-repo-bootstrap';


export {
    runClassifyChangeCommand
};

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

const TEST_REVIEW_LAUNCH_PREPARED_AT_UTC = '2026-04-28T00:00:00.000Z';
const TEST_REVIEW_LAUNCHED_AT_UTC = '2026-04-28T00:00:01.000Z';
const TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC = '2026-04-28T00:00:12.000Z';
const TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC = '2026-04-28T00:00:13.000Z';

function buildTestProviderInvocationId(taskId: string, reviewKey: string, reviewerIdentity: string): string {
    const normalizedIdentity = reviewerIdentity.replace(/^agent:/, '').replace(/[^a-zA-Z0-9._-]+/g, '-');
    return `test-${taskId}-${reviewKey}-${normalizedIdentity}`;
}

function buildFixtureLaunchInputEvidence(taskId: string, reviewKey: string): {
    copy_paste_reviewer_launch_prompt: string;
    copy_paste_reviewer_launch_prompt_sha256: string;
    launch_input_mode: 'copy_paste_prompt';
    launch_input_sha256: string;
    launch_input_copy_paste_reviewer_launch_prompt_sha256: string;
    reviewer_prompt_sha256: string;
    role_prompt_sha256: string;
    prompt_template_sha256: string;
    output_template_sha256: string;
    evidence_manifest_sha256: string;
} {
    const copyPastePrompt = `Delegated ${reviewKey} reviewer launch prompt for ${taskId}.`;
    const copyPastePromptSha256 = createHash('sha256').update(copyPastePrompt, 'utf8').digest('hex');
    return {
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        reviewer_prompt_sha256: createHash('sha256').update(`reviewer-prompt:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        role_prompt_sha256: createHash('sha256').update(`role-prompt:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        prompt_template_sha256: createHash('sha256').update(`prompt-template:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        output_template_sha256: createHash('sha256').update(`output-template:${taskId}:${reviewKey}`, 'utf8').digest('hex'),
        evidence_manifest_sha256: createHash('sha256').update(`evidence-manifest:${taskId}:${reviewKey}`, 'utf8').digest('hex')
    };
}

function seedCompletedReviewerLaunchFixture(options: {
    repoRoot: string;
    taskId: string;
    reviewKey: string;
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
}): {
    launchArtifactPath: string;
    launchArtifactSha256: string;
    launchInputMode: 'copy_paste_prompt';
    launchInputSha256: string;
    copyPastePromptSha256: string;
    providerInvocationId: string;
    launchTool: string;
    attestationSource: string;
} {
    const launchInputEvidence = buildFixtureLaunchInputEvidence(options.taskId, options.reviewKey);
    const providerInvocationId = buildTestProviderInvocationId(options.taskId, options.reviewKey, options.reviewerIdentity);
    const launchTool = 'test-subagent-spawn';
    const attestationSource = 'test-subagent-spawn';
    const launchArtifactPath = resolveDefaultReviewScratchPath(
        options.repoRoot,
        options.taskId,
        options.reviewKey,
        'reviewer-launch.json'
    );
    fs.mkdirSync(path.dirname(launchArtifactPath), {recursive: true});
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId: options.taskId,
        reviewType: options.reviewKey,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: launchInputEvidence.reviewer_prompt_sha256
    });
    const preparedEvent = appendTaskEvent(
        getOrchestratorRoot(options.repoRoot),
        options.taskId,
        'REVIEWER_LAUNCH_PREPARED',
        'INFO',
        'reviewer launch prepared',
        {
            task_id: options.taskId,
            review_type: options.reviewKey,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: options.reviewerIdentity,
            reviewer_identity: options.reviewerIdentity,
            review_context_sha256: options.reviewContextSha256,
            routing_event_sha256: options.routingEventSha256,
            reviewer_prompt_sha256: launchInputEvidence.reviewer_prompt_sha256,
            role_prompt_sha256: launchInputEvidence.role_prompt_sha256,
            prompt_template_sha256: launchInputEvidence.prompt_template_sha256,
            output_template_sha256: launchInputEvidence.output_template_sha256,
            evidence_manifest_sha256: launchInputEvidence.evidence_manifest_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_artifact_path: path.normalize(launchArtifactPath).replace(/\\/g, '/')
        },
        {passThru: true}
    );
    const launchArtifact = {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        task_id: options.taskId,
        review_type: options.reviewKey,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: options.reviewerIdentity,
        reviewer_session_id: options.reviewerIdentity,
        review_context_sha256: options.reviewContextSha256,
        routing_event_sha256: options.routingEventSha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: String(preparedEvent?.integrity?.event_sha256 || '').trim(),
        launch_tool: launchTool,
        provider_invocation_id: providerInvocationId,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        ...launchInputEvidence,
        fork_context: false
    };
    const launchArtifactText = JSON.stringify(launchArtifact, null, 2);
    fs.writeFileSync(launchArtifactPath, launchArtifactText, 'utf8');
    return {
        launchArtifactPath,
        launchArtifactSha256: createHash('sha256').update(launchArtifactText, 'utf8').digest('hex'),
        launchInputMode: launchInputEvidence.launch_input_mode,
        launchInputSha256: launchInputEvidence.launch_input_sha256,
        copyPastePromptSha256: launchInputEvidence.copy_paste_reviewer_launch_prompt_sha256,
        providerInvocationId,
        launchTool,
        attestationSource
    };
}

function resolveAttestedTaskModeRoute(provider: string): string | null {
    const normalizedProvider = String(provider || '').trim();
    if (!normalizedProvider) {
        return null;
    }
    return PROVIDER_BRIDGE_BY_SOURCE[normalizedProvider] || PROVIDER_ENTRYPOINT_BY_SOURCE[normalizedProvider] || null;
}


export function writeReviewCapabilitiesConfig(
    repoRoot: string,
    overrides: Partial<Record<'code' | 'db' | 'security' | 'refactor' | 'api' | 'test' | 'performance' | 'infra' | 'dependency', boolean>> = {}
): string {
    const configDir = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config');
    const configPath = path.join(configDir, 'review-capabilities.json');
    fs.mkdirSync(configDir, {recursive: true});
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
    fs.mkdirSync(path.dirname(outputFiltersPath), {recursive: true});
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
    fs.mkdirSync(path.dirname(initAnswersPath), {recursive: true});
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        AssistantLanguage: 'English',
        AssistantBrevity: 'concise',
        SourceOfTruth: sourceOfTruth,
        EnforceNoAutoCommit: 'false',
        ClaudeOrchestratorFullAccess: 'false',
        TokenEconomyEnabled: 'true',
        CollectedVia: 'AGENT_INIT_PROMPT.md',
        ActiveAgentFiles: ''
    }, null, 2), 'utf8');
}


export function withDefaultTaskModeRouting<T extends {
    repoRoot?: string;
    provider?: unknown;
    routedTo?: unknown
}>(options: T): T {
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
        fs.mkdirSync(path.dirname(routedFilePath), {recursive: true});
        if (!fs.existsSync(routedFilePath)) {
            fs.writeFileSync(routedFilePath, '# routed workflow fixture\n', 'utf8');
        }
    }
    const manifestPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'protected-control-plane-manifest.json');
    if (!fs.existsSync(manifestPath)) {
        const hasGit = fs.existsSync(path.join(repoRoot, '.git'));
        const workflowConfigBaseline = hasGit
            ? getWorkflowConfigPreTaskBaselineState(repoRoot)
            : {changed_files: [], compatibility_baseline_files: []};
        if (
            !hasGit
            || (
                workflowConfigBaseline.changed_files.length === 0
                && workflowConfigBaseline.compatibility_baseline_files.length === 0
            )
        ) {
            writeProtectedControlPlaneManifest(repoRoot);
        }
    }
    return runEnterTaskModeCommand(resolvedOptions);
}


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

export function resolveReviewerExecutionFixture(
    _taskId: string,
    sourceOfTruth = 'Codex',
    delegatedIdentity = 'agent:test-reviewer'
): {
    reviewerExecutionMode: ReturnType<typeof resolveReviewerRoutingPolicy>['expected_execution_mode'];
    reviewerIdentity: string;
    reviewerFallbackReason: null;
    trustLevel: 'INDEPENDENT_AUDITED';
} {
    const normalizedSourceOfTruth = String(sourceOfTruth).trim() || 'Codex';
    const attestedRoute = resolveAttestedTaskModeRoute(normalizedSourceOfTruth);
    const executionProviderSource = (
        attestedRoute
        && PROVIDER_BRIDGE_BY_SOURCE[normalizedSourceOfTruth] === attestedRoute
    )
        ? 'provider_bridge'
        : 'provider_entrypoint';
    return {
        reviewerExecutionMode: resolveReviewerRoutingPolicy(normalizedSourceOfTruth, executionProviderSource).expected_execution_mode,
        reviewerIdentity: delegatedIdentity,
        reviewerFallbackReason: null,
        trustLevel: 'INDEPENDENT_AUDITED'
    };
}


export function writePreflight(
    repoRoot: string,
    taskId: string,
    overrides: Record<string, unknown> = {},
    outputFileName = `${taskId}-preflight.json`
): string {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
    const preflightPath = path.join(reviewsRoot, outputFileName);
    const payload = {
        task_id: taskId,
        detection_source: 'explicit_changed_files',
        mode: 'FULL_PATH',
        metrics: {changed_lines_total: 3},
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

const GIT_FIXTURE_MAX_SETUP_ATTEMPTS = 3;
const GIT_FIXTURE_SETUP_RETRY_DELAYS_MS = [25, 75];

function isGitFixtureSetupCommand(args: string[]): boolean {
    return args[0] === 'init' || args[0] === 'config';
}

export function isTransientGitFixtureSetupError(output: string): boolean {
    const normalized = output.replace(/\\/g, '/');
    return /permission denied/i.test(normalized)
        || /could not set ['"]?core\.ignorecase['"]?/i.test(normalized)
        || /\.git\/config/i.test(normalized)
        || /index\.lock/i.test(normalized);
}

function sleepGitFixtureRetryDelay(attempt: number): void {
    const delayMs = GIT_FIXTURE_SETUP_RETRY_DELAYS_MS[Math.min(attempt - 1, GIT_FIXTURE_SETUP_RETRY_DELAYS_MS.length - 1)] || 0;
    const deadline = Date.now() + delayMs;
    while (Date.now() < deadline) {
        // Bounded fixture-only backoff for transient Windows temp git config locks.
    }
}

function gitFixtureOutput(result: childProcess.SpawnSyncReturns<string>): string {
    return [
        result.error instanceof Error ? result.error.message : '',
        result.stdout || '',
        result.stderr || ''
    ].filter(Boolean).join('\n');
}

export function formatGitFixtureFailureMessage(
    repoRoot: string,
    args: string[],
    result: childProcess.SpawnSyncReturns<string>,
    attempts: number
): string {
    const output = gitFixtureOutput(result).trim() || '<no output>';
    return [
        `git fixture command failed in ${repoRoot}`,
        `Command: git ${args.join(' ')}`,
        `Attempts: ${attempts}`,
        `ExitStatus: ${String(result.status)}`,
        `Output: ${output}`
    ].join('\n');
}

export function runGit(
    repoRoot: string,
    args: string[],
    options: { retryFixtureSetup?: boolean } = {}
): childProcess.SpawnSyncReturns<string> {
    const maxAttempts = options.retryFixtureSetup && isGitFixtureSetupCommand(args)
        ? GIT_FIXTURE_MAX_SETUP_ATTEMPTS
        : 1;
    let result: childProcess.SpawnSyncReturns<string> | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        result = childProcess.spawnSync('git', args, {
            cwd: repoRoot,
            windowsHide: true,
            encoding: 'utf8'
        });
        if (result.status === 0 && !result.error) {
            return result;
        }
        if (
            attempt < maxAttempts
            && isTransientGitFixtureSetupError(gitFixtureOutput(result))
        ) {
            sleepGitFixtureRetryDelay(attempt);
            continue;
        }
        break;
    }

    assert.ok(result !== null);
    assert.equal(
        result.status,
        0,
        formatGitFixtureFailureMessage(repoRoot, args, result, maxAttempts)
    );
    return result;
}

export function initializeGitRepo(repoRoot: string): void {
    runGit(repoRoot, ['init'], {retryFixtureSetup: true});

    const configPath = path.join(repoRoot, '.git', 'config');
    if (fs.existsSync(configPath)) {
        const userConfig = '\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Garda Tests\n\temail = garda-tests@example.com\n';
        fs.appendFileSync(configPath, userConfig, 'utf8');
    }

    runGit(repoRoot, ['add', '.']);
    runGit(repoRoot, ['commit', '-m', 'test: baseline']);
}

function runGitBestEffort(repoRoot: string, args: string[], options: { retryFixtureSetup?: boolean } = {}): void {
    try {
        runGit(repoRoot, args, options);
    } catch {
        // Review fixtures can be pre-seeded by individual tests; this helper only best-effort fills gaps.
    }
}

function runGitBestEffortRaw(repoRoot: string, args: string[]): void {
    childProcess.spawnSync('git', args, {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
}

function readChangedFilesFromPreflight(preflightPath: string): string[] {
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return ['src/app.ts'];
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        return Array.isArray(preflight.changed_files)
            ? preflight.changed_files
                .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
                .filter(Boolean)
            : ['src/app.ts'];
    } catch {
        return ['src/app.ts'];
    }
}

export function prepareReviewDiffFixture(repoRoot: string, preflightPath: string): void {
    const changedFiles = readChangedFilesFromPreflight(preflightPath);
    if (changedFiles.length === 0) {
        return;
    }

    if (!fs.existsSync(path.join(repoRoot, '.git'))) {
        runGitBestEffort(repoRoot, ['init'], {retryFixtureSetup: true});
    }
    const configPath = path.join(repoRoot, '.git', 'config');
    if (fs.existsSync(configPath)) {
        const userConfig = '\n[commit]\n\tgpgsign = false\n[tag]\n\tgpgsign = false\n[user]\n\tname = Garda Tests\n\temail = garda-tests@example.com\n';
        fs.appendFileSync(configPath, userConfig, 'utf8');
    }
    const head = childProcess.spawnSync('git', ['rev-parse', '--verify', 'HEAD'], {
        cwd: repoRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true
    });
    if (head.status !== 0) {
        const workflowConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        if (fs.existsSync(workflowConfigPath)) {
            runGitBestEffortRaw(repoRoot, ['add', '--', 'garda-agent-orchestrator/live/config/workflow-config.json']);
        }
        runGitBestEffortRaw(repoRoot, ['commit', '--allow-empty', '-m', 'baseline']);
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
        fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
        if (!fs.existsSync(absolutePath)) {
            fs.writeFileSync(absolutePath, `// review fixture for ${changedFile}\n`, 'utf8');
        }
    }
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
    return {
        preflightPath,
        preflightSha256: createHash('sha256').update(preflightText).digest('hex'),
        preflight: JSON.parse(preflightText) as Record<string, unknown>
    };
}

function buildManualReviewContextTaskScopeFixture(preflight: Record<string, unknown>): Record<string, unknown> {
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : [];
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

function buildReceiptBackedReviewContextFixture(
    repoRoot: string,
    taskId: string,
    reviewKey: string,
    reviewerEvidence: ReturnType<typeof resolveDefaultReviewerEvidence>,
    options: { allowLegacyManualReviewContext?: boolean } = {}
): { reviewContext: Record<string, unknown>; reviewContextText: string } {
    const reviewsRoot = getReviewsRoot(repoRoot);
    const reviewContextPath = path.join(reviewsRoot, `${taskId}-${reviewKey}-review-context.json`);
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    if (
        fs.existsSync(preflightPath)
        && fs.statSync(preflightPath).isFile()
        && options.allowLegacyManualReviewContext !== true
    ) {
        prepareReviewDiffFixture(repoRoot, preflightPath);
        buildReviewContext({
            reviewType: reviewKey,
            depth: 2,
            preflightPath,
            tokenEconomyConfigPath: path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'),
            scopedDiffMetadataPath: path.join(reviewsRoot, `${taskId}-${reviewKey}-scoped.json`),
            outputPath: reviewContextPath,
            repoRoot
        });
        applyReviewerRoutingMetadata(reviewContextPath, {
            actualExecutionMode: reviewerEvidence.executionMode,
            reviewerSessionId: reviewerEvidence.reviewerIdentity,
            fallbackReason: reviewerEvidence.reviewerFallbackReason
        });
        const reviewContextText = fs.readFileSync(reviewContextPath, 'utf8');
        return {
            reviewContext: JSON.parse(reviewContextText) as Record<string, unknown>,
            reviewContextText
        };
    }

    if (options.allowLegacyManualReviewContext !== true) {
        throw new Error(
            'Manual review-context fixtures require explicit allowLegacyManualReviewContext opt-in. ' +
            `Missing or bypassed preflight artifact: ${preflightPath}`
        );
    }

    const preflightFixture = readReviewPreflightFixture(repoRoot, taskId);
    if (preflightFixture.preflightSha256) {
        prepareReviewDiffFixture(repoRoot, preflightFixture.preflightPath);
    }
    const promptArtifactPath = reviewContextPath.replace(/\.json$/, '.md');
    const promptArtifactText = [
        `# ${reviewKey} review fixture`,
        '',
        `Fixture prompt artifact for ${taskId}/${reviewKey}.`
    ].join('\n');
    fs.writeFileSync(promptArtifactPath, promptArtifactText, 'utf8');
    const promptArtifactSha256 = createHash('sha256').update(promptArtifactText).digest('hex');
    const changedFiles = Array.isArray(preflightFixture.preflight.changed_files)
        ? preflightFixture.preflight.changed_files
            .map((entry) => String(entry || '').replace(/\\/g, '/').trim())
            .filter(Boolean)
        : [];
    const metrics = preflightFixture.preflight.metrics
    && typeof preflightFixture.preflight.metrics === 'object'
    && !Array.isArray(preflightFixture.preflight.metrics)
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
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: preflightFixture.preflightSha256,
        task_scope: buildManualReviewContextTaskScopeFixture(preflightFixture.preflight),
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
        reviewer_routing: createReviewerRoutingFixture(reviewerEvidence.sourceOfTruth, {
            ...reviewerEvidence.routingOverrides
        })
    };
    return {
        reviewContext,
        reviewContextText: JSON.stringify(reviewContext, null, 2)
    };
}

function resolveFixtureReviewTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : null;
    const treeStateSha256 = String(treeState?.tree_state_sha256 || '').trim().toLowerCase();
    return treeStateSha256 || null;
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
            ? {zero_diff_detected: true, status: 'BASELINE_ONLY'}
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
    prepareReviewDiffFixture(repoRoot, preflightPath);
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

function prepareScopedDiffFixture(repoRoot: string, preflightPath: string, reviewType: string): void {
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const scopedDiffExpected = buildReviewContextPreflightDiffExpectations(preflight, reviewType).expectedScopedDiff;
    if (!scopedDiffExpected) {
        return;
    }
    const pathsConfigPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'paths.json');
    if (!fs.existsSync(pathsConfigPath) || !fs.statSync(pathsConfigPath).isFile()) {
        return;
    }
    prepareReviewDiffFixture(repoRoot, preflightPath);
    const reviewsRoot = getReviewsRoot(repoRoot);
    buildScopedDiff({
        reviewType,
        preflightPath,
        pathsConfigPath,
        outputPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.diff`),
        metadataPath: path.join(reviewsRoot, `${preflight.task_id}-${reviewType}-scoped.json`),
        repoRoot
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

function resolveDefaultReviewerEvidence(repoRoot: string, _taskId: string, reviewKey: string): {
    sourceOfTruth: string;
    executionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewerFallbackReason: null;
    routingOverrides: Record<string, unknown>;
} {
    const sourceOfTruth = readSeededSourceOfTruth(repoRoot);
    const policy = resolveReviewerRoutingPolicy(sourceOfTruth, 'provider_entrypoint');
    const executionMode = 'delegated_subagent';
    const delegatedReviewerIdentity = reviewKey === 'code'
        ? 'agent:code-reviewer'
        : reviewKey === 'test'
            ? 'agent:test-reviewer'
            : `agent:${reviewKey}-reviewer`;
    const reviewerIdentity = delegatedReviewerIdentity;
    const reviewerFallbackReason = null;
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
    contentLines?: string[],
    options: { allowLegacyManualReviewContext?: boolean } = {}
): void {
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
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
    const {
        reviewContext,
        reviewContextText
    } = buildReceiptBackedReviewContextFixture(repoRoot, taskId, reviewKey, reviewerEvidence, options);
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');

    const crypto = require('node:crypto');
    const artifactHash = crypto.createHash('sha256').update(content).digest('hex');
    const reviewContextHash = crypto.createHash('sha256').update(reviewContextText).digest('hex');
    const reviewTreeStateSha256 = resolveFixtureReviewTreeStateSha256(reviewContext);

    const orchestratorRoot = path.join(repoRoot, 'garda-agent-orchestrator');
    const skillId = reviewKey === 'test' ? 'testing-strategy' : 'code-review';
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', 'review started', {
        review_type: reviewKey
    });
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', {skill_id: skillId});
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {reference_path: `/live/skills/${skillId}/SKILL.md`});
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'delegated', {
        review_type: reviewKey,
        reviewer_execution_mode: reviewerEvidence.executionMode,
        reviewer_session_id: reviewerEvidence.reviewerIdentity,
        reviewer_fallback_reason: reviewerEvidence.reviewerFallbackReason,
        delegation_used: reviewerEvidence.executionMode === 'delegated_subagent'
    }, {passThru: true});
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewKey,
        reviewerIdentity: reviewerEvidence.reviewerIdentity,
        reviewContextSha256: reviewContextHash,
        routingEventSha256: String(routedEvent?.integrity?.event_sha256 || '').trim()
    });
    const preflightPath = path.join(reviewsRoot, `${taskId}-preflight.json`);
    let preflightSha256: string | null = null;
    let scopeSha256: string | null = null;
    let reviewScopeSha256: string | null = null;
    let codeScopeSha256: string | null = null;
    let reviewContextReuseSha256: string | null = null;
    if (fs.existsSync(preflightPath) && fs.statSync(preflightPath).isFile()) {
        const preflightText = fs.readFileSync(preflightPath, 'utf8');
        const preflight = JSON.parse(preflightText) as Record<string, unknown>;
        preflightSha256 = crypto.createHash('sha256').update(preflightText).digest('hex');
        scopeSha256 = String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null;
        reviewScopeSha256 = computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256;
        codeScopeSha256 = reviewKey !== 'test'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null;
        reviewContextReuseSha256 = computeReviewContextReuseHash(reviewContext);
    }
    const invocationDetails = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: reviewerEvidence.executionMode,
        reviewer_session_id: reviewerEvidence.reviewerIdentity,
        reviewer_identity: reviewerEvidence.reviewerIdentity,
        review_context_sha256: reviewContextHash,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routedEvent?.integrity?.event_sha256,
        reviewer_launch_artifact_path: path.normalize(launchEvidence.launchArtifactPath).replace(/\\/g, '/'),
        reviewer_launch_artifact_sha256: launchEvidence.launchArtifactSha256,
        reviewer_launch_attestation_source: launchEvidence.attestationSource,
        reviewer_launch_tool: launchEvidence.launchTool,
        provider_invocation_id: launchEvidence.providerInvocationId,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        launch_input_mode: launchEvidence.launchInputMode,
        launch_input_sha256: launchEvidence.launchInputSha256,
        copy_paste_reviewer_launch_prompt_sha256: launchEvidence.copyPastePromptSha256,
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
    };
    const invocationEvent = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'reviewer invocation attested',
        invocationDetails,
        {passThru: true}
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        invocationEvent?.integrity,
        invocationDetails
    );

    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256,
        codeScopeSha256,
        reviewContextSha256: reviewContextHash,
        reviewTreeStateSha256,
        reviewContextReuseSha256,
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: reviewerEvidence.executionMode,
        reviewerIdentity: reviewerEvidence.reviewerIdentity,
        reviewerFallbackReason: reviewerEvidence.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED'
    });
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
    receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPayloadSha256 = crypto.createHash('sha256').update(receiptPayload).digest('hex');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(receiptPath, receiptPayload, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptPayload, 'utf8');
    fs.writeFileSync(artifactSnapshotPath, content, 'utf8');

    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptPayloadSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptPayloadSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
    });
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
        omitInvocationTreeState?: boolean;
    } = {}
): string {
    const crypto = require('node:crypto');
    const reviewsRoot = getReviewsRoot(repoRoot);
    fs.mkdirSync(reviewsRoot, {recursive: true});
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
    prepareReviewDiffFixture(repoRoot, preflightPath);
    prepareScopedDiffFixture(repoRoot, preflightPath, reviewKey);
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
    const executionMode = execution.reviewerExecutionMode;
    const resolvedReviewerIdentity = execution.reviewerIdentity;
    const reviewerFallbackReason = execution.reviewerFallbackReason;
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
    const reviewContext = JSON.parse(reviewContextText) as Record<string, unknown>;
    const reviewTreeStateSha256 = resolveFixtureReviewTreeStateSha256(reviewContext);
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
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_SELECTED', 'INFO', 'selected', {skill_id: skillId});
    appendTaskEvent(orchestratorRoot, taskId, 'SKILL_REFERENCE_LOADED', 'INFO', 'loaded', {reference_path: `/live/skills/${skillId}/SKILL.md`});
    const routedEvent = appendTaskEvent(orchestratorRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', 'reusable review routing recorded', {
        review_type: reviewKey,
        reviewer_execution_mode: executionMode,
        reviewer_session_id: resolvedReviewerIdentity,
        reviewer_fallback_reason: reviewerFallbackReason,
        delegation_used: true
    }, {passThru: true});
    const launchEvidence = seedCompletedReviewerLaunchFixture({
        repoRoot,
        taskId,
        reviewKey,
        reviewerIdentity: resolvedReviewerIdentity,
        reviewContextSha256: reviewContextHash,
        routingEventSha256: String(routedEvent?.integrity?.event_sha256 || '').trim()
    });
    const invocationDetails: Record<string, unknown> = {
        task_id: taskId,
        review_type: reviewKey,
        reviewer_execution_mode: executionMode,
        reviewer_session_id: resolvedReviewerIdentity,
        reviewer_identity: resolvedReviewerIdentity,
        review_context_sha256: reviewContextHash,
        routing_event_sha256: routedEvent?.integrity?.event_sha256,
        reviewer_launch_artifact_path: path.normalize(launchEvidence.launchArtifactPath).replace(/\\/g, '/'),
        reviewer_launch_artifact_sha256: launchEvidence.launchArtifactSha256,
        reviewer_launch_attestation_source: launchEvidence.attestationSource,
        reviewer_launch_tool: launchEvidence.launchTool,
        provider_invocation_id: launchEvidence.providerInvocationId,
        launch_prepared_at_utc: TEST_REVIEW_LAUNCH_PREPARED_AT_UTC,
        delegation_started_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launched_at_utc: TEST_REVIEW_LAUNCHED_AT_UTC,
        launch_completed_at_utc: TEST_REVIEW_LAUNCH_COMPLETED_AT_UTC,
        launch_input_mode: launchEvidence.launchInputMode,
        launch_input_sha256: launchEvidence.launchInputSha256,
        copy_paste_reviewer_launch_prompt_sha256: launchEvidence.copyPastePromptSha256,
        invocation_attested_at_utc: TEST_REVIEW_INVOCATION_ATTESTED_AT_UTC
    };
    if (!options.omitInvocationTreeState) {
        invocationDetails.review_tree_state_sha256 = reviewTreeStateSha256;
    }
    const invocationEvent = appendTaskEvent(
        orchestratorRoot,
        taskId,
        'REVIEWER_INVOCATION_ATTESTED',
        'INFO',
        'reusable reviewer invocation attested',
        invocationDetails,
        {passThru: true}
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        'REVIEWER_INVOCATION_ATTESTED',
        invocationEvent?.integrity,
        invocationDetails
    );
    const receipt = buildReviewReceipt({
        taskId,
        reviewType: reviewKey,
        preflightSha256: preflightHash,
        scopeSha256: String((preflight.metrics as Record<string, unknown> | undefined)?.changed_files_sha256 || '').trim() || null,
        reviewScopeSha256: computeReviewRelevantScopeFingerprint(preflight, repoRoot).review_scope_sha256,
        codeScopeSha256: reviewKey !== 'test'
            ? computeCodeReviewScopeFingerprint(preflight, repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: reviewContextHash,
        reviewTreeStateSha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(reviewContext),
        reviewArtifactSha256: artifactHash,
        reviewerExecutionMode: executionMode,
        reviewerIdentity: resolvedReviewerIdentity,
        reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: execution.trustLevel
    });
    const receiptRecord = receipt as unknown as Record<string, unknown>;
    receiptRecord.review_result_recorded_at_utc = receipt.recorded_at_utc;
    receiptRecord.review_output_source_mtime_utc = fs.statSync(artifactPath).mtime.toISOString();
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptPayload = `${JSON.stringify(receipt, null, 2)}\n`;
    const receiptPayloadSha256 = crypto.createHash('sha256').update(receiptPayload).digest('hex');
    const receiptSnapshotPath = artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/, `-artifact-${artifactHash}.md`);
    fs.writeFileSync(receiptPath, receiptPayload, 'utf8');
    fs.writeFileSync(receiptSnapshotPath, receiptPayload, 'utf8');
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    appendTaskEvent(orchestratorRoot, taskId, 'REVIEW_RECORDED', 'PASS', 'reusable review recorded', {
        ...receipt,
        receipt_path: path.normalize(receiptPath).replace(/\\/g, '/'),
        receipt_sha256: receiptPayloadSha256,
        receipt_snapshot_path: path.normalize(receiptSnapshotPath).replace(/\\/g, '/'),
        receipt_snapshot_sha256: receiptPayloadSha256,
        review_artifact_path: path.normalize(artifactPath).replace(/\\/g, '/'),
        review_artifact_snapshot_path: path.normalize(artifactSnapshotPath).replace(/\\/g, '/'),
        review_artifact_snapshot_sha256: artifactHash,
        review_context_path: path.normalize(reviewContextPath).replace(/\\/g, '/')
    });
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
    const canonicalEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[canonicalSourceOfTruth] || null;
    const providerBridgeCandidate = PROVIDER_BRIDGE_BY_SOURCE[provider] || null;
    const providerBridgePath = providerBridgeCandidate && fs.existsSync(path.join(repoRoot, providerBridgeCandidate))
        ? providerBridgeCandidate
        : null;
    const providerEntrypoint = PROVIDER_ENTRYPOINT_BY_SOURCE[provider] || null;
    const routedTo = providerBridgePath || providerEntrypoint || null;
    const executionProviderSource = providerBridgePath ? 'provider_bridge' : 'provider_entrypoint';

    fs.mkdirSync(reviewsRoot, {recursive: true});
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
        canonical_entrypoint_exists: canonicalEntrypoint !== null && fs.existsSync(path.join(repoRoot, canonicalEntrypoint)),
        provider_bridge: providerBridgePath,
        provider_bridge_exists: providerBridgePath !== null && fs.existsSync(path.join(repoRoot, providerBridgePath)),
        routed_to: routedTo,
        execution_provider_source: executionProviderSource,
        runtime_identity_status: 'resolved',
        reviewer_subagent_launch_status: 'launchable',
        reviewer_subagent_launch_route: routedTo,
        start_task_router_path: '.agents/workflows/start-task.md',
        start_task_router_exists: fs.existsSync(path.join(repoRoot, '.agents/workflows/start-task.md')),
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
    fs.mkdirSync(reviewsRoot, {recursive: true});
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


export function loadTaskEntryRulePack(repoRoot: string, taskId: string, taskModePath = '') {
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
            '15-project-memory.md',
            '30-code-style.md',
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
        {actor: 'gate', passThru: true}
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
        {provider, execution_context: 'materialized-bundle', passed: true, artifact_hash: artifactHash},
        {actor: 'gate', passThru: true}
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
            ? {provider, routedTo: resolveAttestedTaskModeRoute(provider)}
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
