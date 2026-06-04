import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { getProviderRuntimeEnvironmentKeys } from './next-step-test-support';
import {
    recordFullSuiteValidationDuration,
    type FullSuiteValidationConfig
} from './next-step-test-support';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { getWorkspaceSnapshotCached } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from './next-step-test-support';
import { assessProjectMemoryImpact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';
import { buildStrictDecompositionDecisionArtifact } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';
const EXPECTED_LOOP_LINE = 'Loop: run the Navigator first, rerun it after every suggested command, and follow only the single Commands entry it prints.';
const requireFromTest = createRequire(__filename);
const NEXT_STEP_FULL_SUITE_TEST_CONFIG: FullSuiteValidationConfig = Object.freeze({
    enabled: true,
    command: 'npm test',
    timeout_ms: 300_000,
    green_summary_max_lines: 5,
    red_failure_chunk_lines: 50,
    out_of_scope_failure_policy: 'AUDIT_AND_BLOCK',
    placement: 'before_test_review'
});

const ALL_REVIEW_FLAGS = Object.freeze({
    code: false,
    db: false,
    security: false,
    refactor: false,
    api: false,
    test: false,
    performance: false,
    infra: false,
    dependency: false
});

let tempRoots: string[] = [];
const PROVIDER_ENV_KEYS = getProviderRuntimeEnvironmentKeys();

function withProviderEnv<T>(updates: Record<string, string | undefined>, callback: () => T): T {
    const previousValues = new Map<string, string | undefined>();
    for (const key of PROVIDER_ENV_KEYS) {
        previousValues.set(key, process.env[key]);
        delete process.env[key];
    }
    for (const [key, value] of Object.entries(updates)) {
        if (value == null) {
            delete process.env[key];
        } else {
            process.env[key] = value;
        }
    }
    try {
        return callback();
    } finally {
        for (const [key, value] of previousValues) {
            if (value == null) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    }
}

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'template', 'docs', 'prompts'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | ux/test | Make next-step output executable in tests | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'init-answers.json'), {
        SourceOfTruth: 'Codex'
    });
    for (const ruleFile of [
        '00-core.md',
        '15-project-memory.md',
        '30-code-style.md',
        '35-strict-coding-rules.md',
        '40-commands.md',
        '50-structure-and-docs.md',
        '70-security.md',
        '80-task-workflow.md',
        '90-skill-catalog.md'
    ]) {
        fs.writeFileSync(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', ruleFile),
            `# ${ruleFile}\n`,
            'utf8'
        );
    }
    const workflowConfig = buildDefaultWorkflowConfig();
    workflowConfig.full_suite_validation.enabled = false;
    workflowConfig.full_suite_validation.command = 'npm test';
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
    fs.writeFileSync(
        path.join(repoRoot, 'template', 'docs', 'prompts', 'review-cycle-auto-split.md'),
        [
            '# Review Cycle Auto-Split Prompt for {{TASK_ID}}',
            '',
            'GuardReason: {{GUARD_REASON}}',
            'Counts: total_non_test_reviews={{TOTAL_NON_TEST_REVIEWS}}; failed_non_test_reviews={{FAILED_NON_TEST_REVIEWS}}; excluded_review_types={{EXCLUDED_REVIEW_TYPES}}',
            'LatestFailedReview: {{LATEST_FAILED_REVIEW}}',
            'SuggestedChildTaskIds: {{SUGGESTED_CHILD_TASK_IDS}}',
            'SuggestedReviewerFollowUpTaskId: {{SUGGESTED_FOLLOWUP_TASK_ID}}',
            '',
            '## Instructions',
            '1. Treat the parent as SPLIT_REQUIRED, create linked parent-derived suffix task IDs, then rerun next-step so the gate moves it to DECOMPOSED.',
            '2. Allocate child ids from {{SUGGESTED_CHILD_TASK_IDS}}.',
            '',
            '## Constraints',
            '- Do not mark the parent DONE merely because child tasks were created.',
            '- Do not hand-edit the parent status to bypass SPLIT_REQUIRED.',
            '- Reviewer follow-ups use {{SUGGESTED_FOLLOWUP_TASK_ID}} style ids.',
            ''
        ].join('\n'),
        'utf8'
    );
    return repoRoot;
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function writeJsonWithSha(filePath: string, payload: unknown): string {
    writeJson(filePath, payload);
    return fileSha256(filePath);
}

function writeProjectMemoryWorkflowConfig(
    repoRoot: string,
    options: { enabled?: boolean; mode?: 'off' | 'check' | 'update' | 'strict'; fullSuiteEnabled?: boolean } = {}
): void {
    const config = buildDefaultWorkflowConfig();
    config.full_suite_validation.enabled = options.fullSuiteEnabled ?? false;
    config.full_suite_validation.command = 'npm test';
    config.review_execution_policy = { mode: 'code_first_optional' };
    config.project_memory_maintenance.enabled = options.enabled ?? true;
    config.project_memory_maintenance.mode = options.mode ?? 'check';
    config.project_memory_maintenance.run_before_final_closeout = true;
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), config);
}

function seedProjectMemory(repoRoot: string): void {
    const memoryRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'project-memory');
    fs.mkdirSync(memoryRoot, { recursive: true });
    for (const fileName of PROJECT_MEMORY_REQUIRED_FILE_NAMES) {
        fs.writeFileSync(path.join(memoryRoot, fileName), `# ${fileName}\n\nConfirmed project memory content.\n`, 'utf8');
    }
}

function seedProjectMemoryImpact(repoRoot: string, taskId: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const result = assessProjectMemoryImpact({ repoRoot, taskId, preflightPath });
    writeJson(result.artifactPath, result.artifact);
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeNoOpEvidence(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    options: { preflightSha256?: string | null; evidenceTaskId?: string } = {}
): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-no-op.json`), {
        timestamp_utc: new Date().toISOString(),
        event_source: 'record-no-op',
        task_id: options.evidenceTaskId || taskId,
        status: 'PASSED',
        outcome: 'PASS',
        classification: 'AUDIT_ONLY',
        reason: 'Current baseline is intentionally validated without an additional workspace diff.',
        actor: 'test',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_sha256: options.preflightSha256 === undefined
            ? fileSha256(preflightPath)
            : options.preflightSha256
    });
}

function writeStrictDecompositionDecision(
    repoRoot: string,
    taskId: string,
    options: {
        decision?: 'atomic' | 'single-cycle' | 'split-required';
        taskSummary?: string;
        expectedReviewTypes?: string[];
        proposedChildTaskIds?: string[];
    } = {}
): void {
    const decision = options.decision || 'single-cycle';
    writeJson(
        path.join(reviewsRoot(repoRoot), `${taskId}-strict-decomposition-decision.json`),
        buildStrictDecompositionDecisionArtifact({
            taskId,
            decision,
            taskSummary: options.taskSummary || 'Seeded next-step task',
            reason: 'This strict task is intentionally bounded for the current lifecycle cycle.',
            scopeRisk: 'The scope is constrained by the test fixture and must keep normal review gates.',
            expectedReviewTypes: options.expectedReviewTypes || ['code'],
            atomicityConstraints: ['The navigator decision and its regression expectations must land together.'],
            proposedChildTaskIds: decision === 'split-required'
                ? (options.proposedChildTaskIds || [`${taskId}-1`])
                : options.proposedChildTaskIds
        })
    );
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {},
    timestampUtc?: string
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEvent = taskSequence > 1
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    const previousEventSha256 = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome,
        actor: 'gate',
        message: eventType,
        timestamp_utc: timestampUtc || new Date().toISOString(),
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: null
        }
    };
    const integrity = line.integrity as Record<string, unknown>;
    integrity.event_sha256 = buildEventIntegrityHash(line);
    const eventSha256 = String(integrity.event_sha256 || '');
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
    return {
        task_sequence: taskSequence,
        prev_event_sha256: previousEventSha256,
        event_sha256: eventSha256
    };
}

function seedStartedTask(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY');
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}

function seedCustomStartedTask(repoRoot: string, taskId: string): string {
    const taskModePath = path.join(reviewsRoot(repoRoot), `${taskId}-custom-task-mode.json`);
    writeJson(taskModePath, buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded custom next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED', 'PASS', {
        artifact_path: normalizeForTimeline(taskModePath)
    });
    seedRulePack(repoRoot, taskId, 'TASK_ENTRY', taskModePath);
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
    return taskModePath;
}

function seedTaskModeOnly(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-task-mode.json`), buildTaskModeArtifact({
        taskId,
        entryMode: 'EXPLICIT_TASK_EXECUTION',
        requestedDepth: 2,
        effectiveDepth: 2,
        taskSummary: 'Seeded next-step task',
        startBanner: 'Garda captures my mind',
        provider: 'Codex',
        canonicalSourceOfTruth: 'Codex',
        executionProviderSource: 'explicit_provider',
        runtimeIdentityStatus: 'resolved'
    }));
    appendEvent(repoRoot, taskId, 'TASK_MODE_ENTERED');
}

function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        taskModePath,
        loadedRuleFiles: [
            '00-core.md',
            '15-project-memory.md',
            '40-commands.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function seedHandshake(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-handshake.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
}

function seedShellSmoke(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-shell-smoke.json`), { task_id: taskId, status: 'PASS' });
    appendEvent(repoRoot, taskId, 'SHELL_SMOKE_PREFLIGHT_RECORDED');
}

function seedPostPreflightRulePack(repoRoot: string, taskId: string, preflightPath: string, taskModePath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage: 'POST_PREFLIGHT',
        preflightPath,
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
        ]
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage: 'POST_PREFLIGHT',
        preflight_path: normalizeForTimeline(preflightPath),
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function seedSplitRequiredLatchEvidence(
    repoRoot: string,
    taskId: string,
    guardKind: 'scope_budget' | 'review_cycle' = 'scope_budget'
): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath)) {
        writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
    }
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-split-required.json`);
    const artifactSha256 = writeJsonWithSha(artifactPath, {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        status: 'SPLIT_REQUIRED',
        guard_kind: guardKind,
        guard_reason: `${guardKind} guard latched in test`,
        raw_guard_summary: `${guardKind} guard summary`,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        materialization_phase: 'complete',
        status_sync: {
            outcome: 'already_synced',
            previous_status: 'SPLIT_REQUIRED',
            next_status: 'SPLIT_REQUIRED',
            error_message: null
        },
        next_actions: [
            'create_and_link_child_tasks',
            'rerun_next_step_on_parent_to_transition_to_decomposed',
            'or_use_explicit_operator_task_reset_or_discard'
        ],
        guard_details: {
            action: 'test'
        }
    });
    appendEvent(repoRoot, taskId, 'SPLIT_REQUIRED_LATCHED', 'BLOCKED', {
        status: 'SPLIT_REQUIRED',
        guard_kind: guardKind,
        guard_reason: `${guardKind} guard latched in test`,
        artifact_path: normalizeForTimeline(artifactPath),
        artifact_sha256: artifactSha256,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        status_sync_outcome: 'already_synced'
    });
}

function getLoadedRuleFileBasenames(command: string): string[] {
    return [...command.matchAll(/--loaded-rule-file "([^"]+)"/g)]
        .map((match) => path.basename(match[1]))
        .sort();
}

function writePreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>,
    options: {
        seedPostPreflight?: boolean;
        reviewPolicyMode?: string;
        changedFiles?: string[];
        includeDomainScopeFingerprints?: boolean;
    } = {}
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = options.changedFiles || ['src/app.ts'];
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    const domainScopeFingerprints = options.includeDomainScopeFingerprints
        ? buildDomainScopeFingerprints({
            repoRoot,
            detectionSource: snapshot.detection_source,
            includeUntracked: snapshot.include_untracked,
            changedFiles
        })
        : null;
    const reviewPolicyMode = options.reviewPolicyMode || 'code_first_optional';
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256,
            ...(domainScopeFingerprints ? { domain_scope_fingerprints: domainScopeFingerprints } : {})
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        review_execution_policy: {
            mode: reviewPolicyMode,
            visible_summary_line: `Review execution policy: ${reviewPolicyMode}`
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    if (options.seedPostPreflight !== false) {
        seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    }
    return preflightPath;
}

function seedCompilePass(repoRoot: string, taskId: string, timestampUtc?: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, ['src/app.ts']);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-compile-gate.json`), {
        timestamp_utc: timestampUtc || new Date().toISOString(),
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: fileSha256(preflightPath),
        scope_detection_source: snapshot.detection_source,
        scope_include_untracked: snapshot.include_untracked,
        scope_changed_files: snapshot.changed_files,
        scope_changed_files_count: snapshot.changed_files_count,
        scope_changed_lines_total: snapshot.changed_lines_total,
        scope_changed_files_sha256: snapshot.changed_files_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        scope_sha256: snapshot.scope_sha256
    });
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED', 'PASS', {}, timestampUtc);
}

function writeGitAutoPreflight(
    repoRoot: string,
    taskId: string,
    requiredReviews: Record<string, boolean>
): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    const domainScopeFingerprints = buildDomainScopeFingerprints({
        repoRoot,
        detectionSource: snapshot.detection_source,
        includeUntracked: snapshot.include_untracked,
        changedFiles: snapshot.changed_files
    });
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256,
            domain_scope_fingerprints: domainScopeFingerprints
        },
        required_reviews: requiredReviews,
        changed_files: snapshot.changed_files,
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional'
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    seedPostPreflightRulePack(repoRoot, taskId, preflightPath);
    return preflightPath;
}

function seedGitAutoCompilePass(repoRoot: string, taskId: string): void {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const snapshot = getWorkspaceSnapshot(repoRoot, 'git_auto', true, []);
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-compile-gate.json`), {
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        event_source: 'compile-gate',
        status: 'PASSED',
        outcome: 'PASS',
        preflight_path: preflightPath.replace(/\\/g, '/'),
        preflight_hash_sha256: fileSha256(preflightPath),
        scope_detection_source: snapshot.detection_source,
        scope_include_untracked: snapshot.include_untracked,
        scope_changed_files: snapshot.changed_files,
        scope_changed_files_count: snapshot.changed_files_count,
        scope_changed_lines_total: snapshot.changed_lines_total,
        scope_changed_files_sha256: snapshot.changed_files_sha256,
        scope_content_sha256: snapshot.scope_content_sha256,
        scope_sha256: snapshot.scope_sha256
    });
    appendEvent(repoRoot, taskId, 'COMPILE_GATE_PASSED');
}

function buildReviewContextScopeFixture(repoRoot: string, taskId: string, reviewType: string): Record<string, unknown> {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflight = fs.existsSync(preflightPath)
        ? JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>
        : {};
    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    return {
        tree_state: {
            schema_version: 1,
            detection_source: String(preflight.detection_source || 'explicit_changed_files'),
            changed_files: changedFiles,
            domain_scope_fingerprints: (preflight.metrics as Record<string, unknown> | undefined)?.domain_scope_fingerprints,
            tree_state_sha256: sha256Text(JSON.stringify({
                task_id: taskId,
                review_type: reviewType,
                changed_files: changedFiles
            }))
        },
        task_scope: {
            changed_files: changedFiles,
            diff: {
                available: changedFiles.length > 0,
                source: 'test_fixture',
                char_count: changedFiles.length > 0 ? 120 : 0,
                truncated: false,
                error: null
            }
        },
        scoped_diff: {
            expected: false,
            metadata_path: path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-scoped.json`),
            metadata: null
        }
    };
}

function writeReviewEvidence(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    options: {
        verdict?: 'pass' | 'fail';
        body?: string;
        includeLaunchArtifact?: boolean;
    } = {}
): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const passToken = reviewType === 'code' ? 'REVIEW PASSED' : `${reviewType.toUpperCase()} REVIEW PASSED`;
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const verdictToken = options.verdict === 'fail' ? failToken : passToken;
    const reviewContextScope = buildReviewContextScopeFixture(repoRoot, taskId, reviewType);
    const reviewTreeState = reviewContextScope.tree_state as Record<string, unknown> | undefined;
    const reviewTreeStateSha256 = String(reviewTreeState?.tree_state_sha256 || '').trim();
    const domainScopeFingerprints = reviewTreeState?.domain_scope_fingerprints;
    const reviewContext = {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...reviewContextScope,
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`
        }
    };
    const reviewContextText = `${JSON.stringify(reviewContext, null, 2)}\n`;
    fs.writeFileSync(reviewContextPath, reviewContextText, 'utf8');
    const artifactText = `# ${reviewType} review\n\n${options.body || ''}## Verdict\n${verdictToken}\n`;
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`
    });
    const launchPreparedAtUtc = '2026-04-28T00:00:00.000Z';
    const launchedAtUtc = '2026-04-28T00:00:01.000Z';
    const launchCompletedAtUtc = '2026-04-28T00:00:12.000Z';
    const invocationAttestedAtUtc = '2026-04-28T00:00:13.000Z';
    const reviewResultRecordedAtUtc = '2026-04-28T00:00:30.000Z';
    let reviewerLaunchArtifactSha256 = '';
    if (options.includeLaunchArtifact !== false) {
        const launchBindingSha256 = 'c'.repeat(64);
        const reviewerLaunchArtifactPath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'tmp',
            'reviews',
            taskId,
            reviewType,
            'reviewer-launch.json'
        );
        const preparedIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: `agent:${reviewType}-reviewer`,
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_artifact_path: reviewerLaunchArtifactPath
        });
        writeJson(reviewerLaunchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: `test-${reviewType}-invocation`,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: launchedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            ...launchInputEvidenceFixture(taskId, reviewType),
            fork_context: false
        });
        reviewerLaunchArtifactSha256 = fileSha256(reviewerLaunchArtifactPath);
    }
    const invocationIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: `agent:${reviewType}-reviewer`,
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_context_sha256: sha256Text(reviewContextText),
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routeIntegrity.event_sha256,
        ...(reviewerLaunchArtifactSha256
            ? {
                reviewer_launch_artifact_path: path.join(
                    repoRoot,
                    'garda-agent-orchestrator',
                    'runtime',
                    'tmp',
                    'reviews',
                    taskId,
                    reviewType,
                    'reviewer-launch.json'
                ),
                reviewer_launch_artifact_sha256: reviewerLaunchArtifactSha256,
                reviewer_launch_attestation_source: 'test-subagent-spawn',
                reviewer_launch_tool: 'test-subagent-spawn',
                provider_invocation_id: `test-${reviewType}-invocation`,
                launch_prepared_at_utc: launchPreparedAtUtc,
                delegation_started_at_utc: launchedAtUtc,
                launched_at_utc: launchedAtUtc,
                launch_completed_at_utc: launchCompletedAtUtc,
                launch_input_mode: launchInputEvidenceFixture(taskId, reviewType).launch_input_mode,
                launch_input_sha256: launchInputEvidenceFixture(taskId, reviewType).launch_input_sha256,
                copy_paste_reviewer_launch_prompt_sha256: launchInputEvidenceFixture(taskId, reviewType).copy_paste_reviewer_launch_prompt_sha256,
                invocation_attested_at_utc: invocationAttestedAtUtc
            }
            : {})
    });
    writeJson(receiptPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_sha256: fileSha256(preflightPath),
        trust_level: 'INDEPENDENT_AUDITED',
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: `agent:${reviewType}-reviewer`,
        review_artifact_sha256: sha256Text(artifactText),
        review_context_sha256: sha256Text(reviewContextText),
        review_tree_state_sha256: reviewTreeStateSha256,
        domain_scope_fingerprints: domainScopeFingerprints,
        reviewer_provenance: {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: invocationIntegrity.task_sequence,
            prev_event_sha256: invocationIntegrity.prev_event_sha256,
            event_sha256: invocationIntegrity.event_sha256,
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: `agent:${reviewType}-reviewer`,
            review_context_sha256: sha256Text(reviewContextText),
            review_tree_state_sha256: reviewTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: launchedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            invocation_attested_at_utc: invocationAttestedAtUtc
        },
        recorded_at_utc: reviewResultRecordedAtUtc,
        review_result_recorded_at_utc: reviewResultRecordedAtUtc,
        review_output_source_mtime_utc: reviewResultRecordedAtUtc
    });
}

function markReviewEvidenceAsStrictReuse(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    reviewContextReuseSha256 = sha256Text(`${taskId}:${reviewType}:strict-reuse`)
): void {
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const contextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightMetrics = preflight.metrics as Record<string, unknown>;
    const legacyScopes = ((preflightMetrics.domain_scope_fingerprints as Record<string, unknown>)
        .legacy || {}) as Record<string, unknown>;
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    receipt.review_scope_sha256 = legacyScopes.review_scope_sha256;
    receipt.code_scope_sha256 = legacyScopes.code_scope_sha256;
    writeJson(receiptPath, receipt);

    const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
    const historicalReceiptSha256 = fileSha256(receiptPath);
    const historicalReceiptSnapshotPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-${reviewType}-receipt-${historicalReceiptSha256}.json`
    );
    fs.copyFileSync(receiptPath, historicalReceiptSnapshotPath);
    const historicalContextSha256 = fileSha256(contextPath);
    const reviewArtifactSha256 = fileSha256(artifactPath);
    const reviewArtifactSnapshotPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-${reviewType}-artifact-${reviewArtifactSha256}.md`
    );
    fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: historicalReceiptSha256,
        receipt_snapshot_path: historicalReceiptSnapshotPath,
        receipt_snapshot_sha256: historicalReceiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: reviewArtifactSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256,
        review_context_path: contextPath,
        review_context_sha256: historicalContextSha256,
        review_context_reuse_sha256: reviewContextReuseSha256,
        review_tree_state_sha256: receipt.review_tree_state_sha256
    });

    receipt.reused_existing_review = true;
    receipt.reused_from_receipt_path = receiptPath;
    receipt.reused_from_receipt_sha256 = historicalReceiptSha256;
    receipt.review_context_reuse_sha256 = reviewContextReuseSha256;
    receipt.reused_from_review_context_sha256 = historicalContextSha256;
    receipt.reused_from_review_context_reuse_sha256 = reviewContextReuseSha256;
    receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
    receipt.reused_from_review_scope_sha256 = receipt.review_scope_sha256;
    receipt.reused_from_code_scope_sha256 = receipt.code_scope_sha256;
    writeJson(receiptPath, receipt);

    const currentReceiptSha256 = fileSha256(receiptPath);
    const currentReceiptSnapshotPath = path.join(
        reviewsRoot(repoRoot),
        `${taskId}-${reviewType}-receipt-${currentReceiptSha256}.json`
    );
    fs.copyFileSync(receiptPath, currentReceiptSnapshotPath);
    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: currentReceiptSha256,
        receipt_snapshot_path: currentReceiptSnapshotPath,
        receipt_snapshot_sha256: currentReceiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: reviewArtifactSha256,
        review_artifact_snapshot_path: reviewArtifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256,
        review_context_path: contextPath,
        review_context_sha256: historicalContextSha256,
        review_context_reuse_sha256: reviewContextReuseSha256,
        review_tree_state_sha256: receipt.review_tree_state_sha256
    });
}

function writeStrictIndependentCodeReviewEvidence(repoRoot: string, taskId: string): void {
    const reviewType = 'code';
    const reviewerIdentity = 'agent:code-reviewer';
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const preflightSha256 = fileSha256(preflightPath);
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}.md`);
    const receiptPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-receipt.json`);
    const reviewContextScope = buildReviewContextScopeFixture(repoRoot, taskId, reviewType);
    const reviewTreeState = reviewContextScope.tree_state as Record<string, unknown> | undefined;
    const reviewTreeStateSha256 = String(reviewTreeState?.tree_state_sha256 || '').trim();
    const reviewContext = {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: preflightSha256,
        ...reviewContextScope,
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            delegation_required: true,
            expected_execution_mode: 'delegated_subagent',
            fallback_allowed: false,
            fallback_reason_required: false
        }
    };
    writeJson(reviewContextPath, reviewContext);
    const reviewContextSha256 = fileSha256(reviewContextPath);
    const artifactText = '# code review\n\n## Verdict\nREVIEW PASSED\n';
    fs.writeFileSync(artifactPath, artifactText, 'utf8');
    const reviewArtifactSha256 = fileSha256(artifactPath);

    appendEvent(repoRoot, taskId, 'REVIEW_PHASE_STARTED', 'INFO', {
        review_type: reviewType,
        output_path: reviewContextPath
    });
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity
    });
    const invocationIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routeIntegrity.event_sha256
    });
    const reviewerProvenance = {
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: invocationIntegrity.task_sequence,
        prev_event_sha256: invocationIntegrity.prev_event_sha256,
        event_sha256: invocationIntegrity.event_sha256,
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        routing_event_sha256: routeIntegrity.event_sha256
    };
    const receipt = {
        task_id: taskId,
        review_type: reviewType,
        trust_level: 'INDEPENDENT_AUDITED',
        preflight_sha256: preflightSha256,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_artifact_sha256: reviewArtifactSha256,
        review_context_sha256: reviewContextSha256,
        review_tree_state_sha256: reviewTreeStateSha256,
        reviewer_provenance: reviewerProvenance
    };
    writeJson(receiptPath, receipt);
    const receiptSha256 = fileSha256(receiptPath);
    const receiptSnapshotPath = artifactPath.replace(/\.md$/u, `-receipt-${receiptSha256}.json`);
    const artifactSnapshotPath = artifactPath.replace(/\.md$/u, `-artifact-${reviewArtifactSha256}.md`);
    writeJson(receiptSnapshotPath, receipt);
    fs.writeFileSync(artifactSnapshotPath, artifactText, 'utf8');
    appendEvent(repoRoot, taskId, 'REVIEW_RECORDED', 'PASS', {
        ...receipt,
        receipt_path: receiptPath,
        receipt_sha256: receiptSha256,
        receipt_snapshot_path: receiptSnapshotPath,
        receipt_snapshot_sha256: receiptSha256,
        review_artifact_path: artifactPath,
        review_artifact_sha256: reviewArtifactSha256,
        review_artifact_snapshot_path: artifactSnapshotPath,
        review_artifact_snapshot_sha256: reviewArtifactSha256,
        review_context_path: reviewContextPath,
        review_context_sha256: reviewContextSha256
    });
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS',
        preflight_hash_sha256: preflightSha256,
        required_reviews: { code: true },
        verdicts: { code: 'REVIEW PASSED' },
        review_checks: {
            code: {
                required: true,
                skipped_by_override: false,
                receipt_valid: true,
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_identity: reviewerIdentity,
                reviewer_fallback_reason: null,
                trust_level: 'INDEPENDENT_AUDITED',
                verdict: 'REVIEW PASSED',
                reviewer_routing_policy: {
                    delegation_required: true,
                    expected_execution_mode: 'delegated_subagent',
                    fallback_allowed: false,
                    fallback_reason_required: false
                }
            }
        }
    });
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED');
}

function writeReviewContextOnly(repoRoot: string, taskId: string, reviewType: string, reviewerIdentity: string): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...buildReviewContextScopeFixture(repoRoot, taskId, reviewType),
        reviewer_routing: {
            actual_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        }
    });
}

function launchInputEvidenceFixture(taskId: string, reviewType: string): Record<string, unknown> {
    const copyPastePrompt = `Delegated ${reviewType} reviewer launch prompt for ${taskId}.`;
    const copyPastePromptSha256 = sha256Text(copyPastePrompt);
    return {
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
    };
}

function seedCompletedReviewerLaunchAndInvocation(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    options: { includeInvocation?: boolean } = {}
): void {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const routeIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity
    });
    const launchBindingSha256 = 'c'.repeat(64);
    const preparedIntegrity = appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        launch_binding_sha256: launchBindingSha256
    });
    const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, reviewType, 'reviewer-launch.json');
    writeJson(launchArtifactPath, {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedIntegrity.event_sha256,
        launch_tool: 'test-subagent-spawn',
        provider_invocation_id: `test-${reviewType}-invocation`,
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        ...launchInputEvidenceFixture(taskId, reviewType),
        fork_context: false
    });
    if (options.includeInvocation === false) {
        return;
    }
    const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
    appendEvent(repoRoot, taskId, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, taskId, reviewType),
        routing_event_sha256: routeIntegrity.event_sha256,
        reviewer_launch_artifact_path: launchArtifactPath,
        reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
        reviewer_launch_attestation_source: 'test-subagent-spawn',
        reviewer_launch_tool: 'test-subagent-spawn',
        provider_invocation_id: `test-${reviewType}-invocation`,
        launched_at_utc: '2026-04-28T00:00:00.000Z',
        launch_input_mode: launchArtifact.launch_input_mode,
        launch_input_sha256: launchArtifact.launch_input_sha256,
        copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
    });
}

function readReviewContextTreeStateSha256(repoRoot: string, taskId: string, reviewType: string): string {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const reviewContext = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
    const treeState = reviewContext.tree_state && typeof reviewContext.tree_state === 'object' && !Array.isArray(reviewContext.tree_state)
        ? reviewContext.tree_state as Record<string, unknown>
        : {};
    return String(treeState.tree_state_sha256 || '').trim();
}

function writeFreshReviewContextWithoutRouting(repoRoot: string, taskId: string, reviewType: string): string {
    const reviewContextPath = path.join(reviewsRoot(repoRoot), `${taskId}-${reviewType}-review-context.json`);
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    writeJson(reviewContextPath, {
        task_id: taskId,
        review_type: reviewType,
        preflight_path: preflightPath,
        preflight_sha256: fileSha256(preflightPath),
        ...buildReviewContextScopeFixture(repoRoot, taskId, reviewType),
        reviewer_routing: {
            actual_execution_mode: null,
            reviewer_session_id: null
        }
    });
    return reviewContextPath;
}

function seedReviewGatePass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-review-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'REVIEW_GATE_PASSED');
}

function seedDocImpactPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-doc-impact.json`), {
        task_id: taskId,
        decision: 'NO_DOC_UPDATES',
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'DOC_IMPACT_ASSESSED');
}

function seedCompletionPass(repoRoot: string, taskId: string): void {
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-completion-gate.json`), {
        task_id: taskId,
        status: 'PASSED',
        outcome: 'PASS'
    });
    appendEvent(repoRoot, taskId, 'COMPLETION_GATE_PASSED');
}

function seedFullSuiteValidation(
    repoRoot: string,
    taskId: string,
    status: 'PASSED' | 'FAILED' | 'SKIPPED' = 'PASSED',
    timestampUtc?: string
): void {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const timelineEvents = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => JSON.parse(line) as Record<string, unknown>);
    const latestCompile = [...timelineEvents]
        .reverse()
        .find((event) => event.event_type === 'COMPILE_GATE_PASSED');
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const cycleBinding = {
        task_id: taskId,
        preflight_path: normalizeForTimeline(preflightPath),
        preflight_sha256: fileSha256(preflightPath),
        compile_gate_timestamp: String(latestCompile?.timestamp_utc || '')
    };
    writeJson(path.join(reviewsRoot(repoRoot), `${taskId}-full-suite-validation.json`), {
        task_id: taskId,
        status,
        enabled: true,
        command: 'npm test',
        required: status === 'SKIPPED' ? false : undefined,
        skip_reason: status === 'SKIPPED' ? 'DOCS_ONLY_SCOPE_NOT_REQUIRED' : undefined,
        exit_code: status === 'PASSED' ? 0 : status === 'SKIPPED' ? null : 1,
        cycle_binding: cycleBinding,
        output_artifact_path: status === 'SKIPPED'
            ? null
            : path.join(reviewsRoot(repoRoot), `${taskId}-full-suite-output.log`)
    });
    appendEvent(
        repoRoot,
        taskId,
        status === 'PASSED'
            ? 'FULL_SUITE_VALIDATION_PASSED'
            : status === 'SKIPPED'
                ? 'FULL_SUITE_VALIDATION_SKIPPED'
                : 'FULL_SUITE_VALIDATION_FAILED',
        status === 'FAILED' ? 'FAIL' : 'PASS',
        { cycle_binding: cycleBinding },
        timestampUtc
    );
}

function materializeFinalCloseout(repoRoot: string, taskId: string): void {
    const summary = buildTaskAuditSummary({ taskId, repoRoot });
    synchronizeFinalCloseoutArtifacts(summary);
}

function seedCompletedTaskWithIndependentCodeReview(repoRoot: string, taskId: string): void {
    seedStartedTask(repoRoot, taskId);
    writePreflight(repoRoot, taskId, { ...ALL_REVIEW_FLAGS, code: true });
    seedCompilePass(repoRoot, taskId);
    writeStrictIndependentCodeReviewEvidence(repoRoot, taskId);
    seedDocImpactPass(repoRoot, taskId);
    seedCompletionPass(repoRoot, taskId);
}

function seedSourceCheckoutRuntime(repoRoot: string, stale: boolean): void {
    fs.writeFileSync(path.join(repoRoot, 'package.json'), '{"name":"garda-test"}\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'index.ts'), 'export {};\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 2;\n', 'utf8');
    fs.mkdirSync(path.join(repoRoot, 'dist', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'dist', 'src', 'index.js'), 'module.exports = {};\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'dist', 'src', 'app.js'), 'exports.value = 1;\n', 'utf8');
    const generatedTime = stale
        ? new Date(Date.now() - 5000)
        : new Date(Date.now() + 5000);
    fs.utimesSync(path.join(repoRoot, 'dist', 'src', 'app.js'), generatedTime, generatedTime);
}

afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});


describe('gates/next-step', () => {
    it('exposes parallel_all launch batches without collapsing JSON or human output to one lane', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            { reviewPolicyMode: 'parallel_all' }
        );
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(result.review.blocked_review_lanes, []);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code, security, refactor, test/);
    });

    it('exposes blocked review lanes with dependency reasons while preserving single next review compatibility', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, security: true, api: true, test: true },
            { reviewPolicyMode: 'code_first_optional' }
        );
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code', 'security']);
        assert.deepEqual(result.review.blocked_review_lanes, [
            {
                review_type: 'api',
                blocked_by: ['code'],
                reason: 'Waiting for current-cycle code review artifacts and receipts to pass.'
            },
            {
                review_type: 'test',
                blocked_by: ['code', 'security', 'api'],
                reason: 'Waiting for current-cycle code, security, api review artifacts and receipts to pass.'
            }
        ]);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code, security/);
        assert.match(text, /BlockedReviewLanes: api blocked by code; test blocked by code, security, api/);
    });

    it('keeps a single-review launch batch compatible with legacy NextReview consumers', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.review.next_review_type, 'code');
        assert.deepEqual(result.review.launchable_review_types, ['code']);
        assert.deepEqual(result.review.blocked_review_lanes, []);
        assert.match(text, /NextReview: code/);
        assert.match(text, /ReviewLaunchableBatch: code/);
    });

    it('routes to fresh reviewer routing after stale failed review context has been rebuilt', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);
        const rebuiltContextPath = writeFreshReviewContextWithoutRouting(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code',
            output_path: normalizeForTimeline(rebuiltContextPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Record 'code' delegated reviewer routing/);
        assert.ok(result.commands[0].command.includes('record-review-routing'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('uses the prepared review context identity when suggesting prepare-reviewer-launch', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.reason.includes('task-owned reviewer launch metadata'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-routing-to-launch-prepared',
            status: 'pass'
        });
        assert.ok(result.reason.includes('Reviewer readiness chain: preflight scope=current -> review context=current'));
        assert.ok(result.reason.includes('routing=current'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
        assert.ok(result.reason.includes('ProviderLaunchTarget:'));
        assert.ok(result.reason.includes('launch clean-context reviewers'));
        assert.equal(result.commands[0].label, 'Prepare delegated reviewer launch metadata');
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
    });

    it('routes to record-reviewer-delegation-started after current launch metadata is prepared', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        const launchInputArtifactPath = path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json');
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            prepared_launch_event_sha256: preparedIntegrity.event_sha256
        });
        fs.copyFileSync(launchArtifactPath, launchInputArtifactPath);
        const pinnedInputArtifactSha256 = fileSha256(launchInputArtifactPath);
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-reviewer-delegation-started');
        assert.ok(result.reason.includes('launch metadata'));
        assert.ok(result.reason.includes('Launch the delegated reviewer with the exact generated CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath as an opaque handoff'));
        assert.ok(result.reason.includes('pass the ReviewerLaunchInputArtifactSha256 value to the CLI flag --launch-input-sha256'));
        assert.ok(result.reason.includes('do not invent a --launch-input-artifact-sha256 flag'));
        assert.ok(result.reason.includes('Do not reconstruct reviewer prompts from memory'));
        assert.ok(result.reason.includes('Do not open or summarize'));
        assert.ok(result.reason.includes('Launch a real subagent using built-in tools'));
        assert.ok(result.reason.includes('if for some reason that is impossible right now, you must stop and report this to the user'));
        assert.ok(result.reason.includes('this is expected behavior in this repository'));
        assert.ok(result.reason.includes('record-reviewer-delegation-started'));
        assert.ok(result.reason.includes('ProviderLaunchTarget:'));
        assert.ok(result.reason.includes('launch clean-context reviewers'));
        assert.ok(result.reason.includes('launch artifact=prepared'));
        assert.ok(result.reason.includes('invocation=blocked until launch completion'));
        assert.equal(result.commands[0].label, 'Record delegated reviewer start');
        assert.ok(result.commands[0].command.includes('gate record-reviewer-delegation-started'));
        assert.ok(result.commands[0].command.includes('--launch-input-mode "launch_artifact_path"'));
        const normalizedCommand = result.commands[0].command.replace(/\\/g, '/');
        assert.ok(normalizedCommand.includes(`--launch-input-artifact-path "${launchInputArtifactPath.replace(/\\/g, '/')}"`));
        assert.ok(result.commands[0].command.includes(`--launch-input-sha256 "${fileSha256(launchInputArtifactPath)}"`));
        assert.ok(!result.commands[0].command.includes('--launch-input-artifact-sha256'));
        assert.ok(!result.commands[0].command.includes('--launched-at-utc'));
    });

    it('routes to complete-reviewer-launch with immutable launch input artifact evidence after delegation starts', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        const launchInputArtifactPath = path.join(path.dirname(launchArtifactPath), 'reviewer-launch-input.json');
        const copyPastePrompt = 'Delegated code reviewer launch prompt.';
        const copyPastePromptSha256 = sha256Text(copyPastePrompt);
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch_preparation',
            attestation_state: 'prepared',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            reviewer_launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            copy_paste_reviewer_launch_prompt: copyPastePrompt,
            copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256
        });
        fs.copyFileSync(launchArtifactPath, launchInputArtifactPath);
        const pinnedInputArtifactSha256 = fileSha256(launchInputArtifactPath);
        writeJson(launchArtifactPath, {
            ...JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')),
            attestation_state: 'delegation_started',
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            delegation_started_at_utc: '2026-04-28T00:00:00.000Z',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: 'launch_artifact_path',
            launch_input_sha256: pinnedInputArtifactSha256,
            launch_input_artifact_path: launchInputArtifactPath.replace(/\\/g, '/'),
            launch_input_artifact_sha256: pinnedInputArtifactSha256,
            prepared_reviewer_launch_artifact_sha256: pinnedInputArtifactSha256,
            reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256,
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'complete-reviewer-launch', result.reason);
        assert.equal(result.commands[0].label, 'Complete delegated reviewer launch metadata');
        assert.ok(result.commands[0].command.includes('gate complete-reviewer-launch'));
        const normalizedCommand = result.commands[0].command.replace(/\\/g, '/');
        assert.ok(normalizedCommand.includes(`--launch-input-artifact-path "${launchInputArtifactPath.replace(/\\/g, '/')}"`));
        assert.ok(result.commands[0].command.includes(`--launch-input-sha256 "${pinnedInputArtifactSha256}"`));
        assert.ok(!result.commands[0].command.includes('--launch-input-artifact-sha256'));
    });

    it('routes to record-review-invocation after current completed launch metadata is present', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-invocation', result.reason);
        assert.ok(result.reason.includes('launch metadata'));
        assert.ok(result.reason.includes('already contains completed launch evidence'));
        assert.ok(!result.reason.includes('Launch the delegated reviewer with the prepared prompt'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-launch-completed-to-invocation',
            status: 'pass'
        });
        assert.ok(result.reason.includes('launch artifact=launched'));
        assert.ok(result.reason.includes('invocation=missing current-cycle attestation'));
        assert.equal(result.commands[0].label, 'Record delegated reviewer launch attestation');
        assert.ok(result.commands[0].command.includes('gate record-review-invocation'));
    });

    it('does not route stripped completed launch metadata to record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        seedCompletedReviewerLaunchAndInvocation(repoRoot, TASK_ID, 'code', reviewerIdentity, {
            includeInvocation: false
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        const strippedArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        for (const key of [
            'copy_paste_reviewer_launch_prompt',
            'copy_paste_reviewer_launch_prompt_sha256',
            'launch_input_mode',
            'launch_input_sha256',
            'launch_input_copy_paste_reviewer_launch_prompt_sha256'
        ]) {
            delete strippedArtifact[key];
        }
        writeJson(launchArtifactPath, strippedArtifact);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
    });

    it('does not route stale completed launch metadata to record-review-invocation', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: 'a'.repeat(64),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
    });

    it('routes to record-review-result after current context invocation is attested even when an old receipt exists', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchBindingSha256 = 'c'.repeat(64);
        const preparedIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256
        });
        const launchArtifactPath = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', TASK_ID, 'code', 'reviewer-launch.json');
        writeJson(launchArtifactPath, {
            schema_version: 1,
            evidence_type: 'delegated_reviewer_launch',
            attestation_state: 'launched',
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            routing_event_sha256: routeIntegrity.event_sha256,
            launch_binding_sha256: launchBindingSha256,
            prepared_launch_event_sha256: preparedIntegrity.event_sha256,
            launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            ...launchInputEvidenceFixture(TASK_ID, 'code'),
            fork_context: false
        });
        const launchArtifact = JSON.parse(fs.readFileSync(launchArtifactPath, 'utf8')) as Record<string, unknown>;
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: fileSha256(reviewContextPath),
            review_tree_state_sha256: readReviewContextTreeStateSha256(repoRoot, TASK_ID, 'code'),
            routing_event_sha256: routeIntegrity.event_sha256,
            reviewer_launch_artifact_path: launchArtifactPath,
            reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
            reviewer_launch_attestation_source: 'test-subagent-spawn',
            reviewer_launch_tool: 'test-subagent-spawn',
            provider_invocation_id: 'test-invocation-123',
            launched_at_utc: '2026-04-28T00:00:00.000Z',
            launch_input_mode: launchArtifact.launch_input_mode,
            launch_input_sha256: launchArtifact.launch_input_sha256,
            copy_paste_reviewer_launch_prompt_sha256: launchArtifact.copy_paste_reviewer_launch_prompt_sha256
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.ok(result.commands[0].command.includes(`--reviewer-identity "${reviewerIdentity}"`));
        assert.ok(result.commands[0].command.includes('--review-output-stdin'));
        assert.ok(!result.commands[0].command.includes('--review-output-path'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-invocation-to-result',
            status: 'pass'
        });
        assert.ok(result.reason.includes('invocation=attested'));
        assert.ok(result.reason.includes('review output/receipt=receipt invalid or stale'));
    });

    it('does not route to record-review-result when invocation telemetry exists without current completed launch metadata', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { includeLaunchArtifact: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch');
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
    });

    it('routes failed old review receipts through launch preparation after current context rebuild', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:code-reviewer';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID, '2026-04-28T00:00:00.000Z');
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        seedCompilePass(repoRoot, TASK_ID, '2026-04-28T00:01:00.000Z');
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', {
            review_type: 'code',
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`)
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'prepare-reviewer-launch', result.reason);
        assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
        assert.ok(result.reason.includes('launch artifact=missing or stale'));
        assert.ok(result.reason.includes('invocation=blocked until launch artifact'));
    });

    it('does not treat current context invocation telemetry without matching tree-state binding as attested', () => {
        for (const reviewTreeStateSha256 of [undefined, 'f'.repeat(64)] as const) {
            const repoRoot = makeTempRepo();
            const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
            seedStartedTask(repoRoot, TASK_ID);
            writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
            seedCompilePass(repoRoot, TASK_ID);
            writeReviewEvidence(repoRoot, TASK_ID, 'code');
            writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
            const reviewContextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
            const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity
            });
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                task_id: TASK_ID,
                review_type: 'code',
                reviewer_execution_mode: 'delegated_subagent',
                reviewer_session_id: reviewerIdentity,
                reviewer_identity: reviewerIdentity,
                review_context_sha256: fileSha256(reviewContextPath),
                ...(reviewTreeStateSha256 ? { review_tree_state_sha256: reviewTreeStateSha256 } : {}),
                routing_event_sha256: routeIntegrity.event_sha256
            });

            const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

            assert.equal(result.next_gate, 'prepare-reviewer-launch');
            assert.ok(result.commands[0].command.includes('gate prepare-reviewer-launch'));
        }
    });

    it('routes fresh review contexts without routing telemetry to record-review-routing first', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', 'agent:code-reviewer');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.ok(result.commands[0].command.includes('gate record-review-routing'));
        assert.ok(result.commands[0].command.includes('--reviewer-identity "agent:code-reviewer"'));
    });

    it('routes stale review context bindings back to build-review-context after preflight refresh', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const refreshed = 3;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.ok(result.reason.includes('stale for the current preflight'));
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
    });

    it('blocks downstream review when receipt provenance hash does not match routing telemetry', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            event_sha256: 'b'.repeat(64)
        };
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('fresh delegated-review launch evidence is missing, stale, or spoof-like'));
    });
});
