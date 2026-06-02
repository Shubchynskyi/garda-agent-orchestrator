import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import { formatNextStepText, resolveNextStep } from '../../../../src/gates/next-step';
import { getProviderRuntimeEnvironmentKeys } from '../../../../src/core/provider-registry';
import {
    recordFullSuiteValidationDuration,
    type FullSuiteValidationConfig
} from '../../../../src/gates/full-suite/full-suite-validation';
import { assertGateChainDecision } from '../../cli/commands/gate-test-gatechain';
import { getWorkspaceSnapshot } from '../../../../src/gates/compile/compile-gate';
import { getWorkspaceSnapshotCached } from '../../../../src/gates/workspace/workspace-snapshot-cache';
import { buildRulePackArtifact } from '../../../../src/gates/rule-pack';
import { buildTaskModeArtifact } from '../../../../src/gates/task-mode';
import { buildTaskAuditSummary, synchronizeFinalCloseoutArtifacts } from '../../../../src/gates/task-audit/task-audit-summary';
import { assessProjectMemoryImpact } from '../../../../src/gates/project-memory-impact';
import { buildEventIntegrityHash } from '../../../../src/gate-runtime/task-events-helpers';
import { buildDefaultWorkflowConfig } from '../../../../src/core/workflow-config';
import { PROJECT_MEMORY_REQUIRED_FILE_NAMES } from '../../../../src/core/project-memory';
import { buildDomainScopeFingerprints } from '../../../../src/gates/scope/domain-scope-fingerprints';
import { buildStrictDecompositionDecisionArtifact } from '../../../../src/gates/task-mode/strict-decomposition-decision';

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
    it('stops after a failed upstream code review instead of launching downstream test review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /REVIEW FAILED/);
        assert.match(result.reason, /Do not launch downstream reviewers/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: test/);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('record-review-result'));
    });

    it('returns to failed code remediation after independent reviews complete before downstream test', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, refactor: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Fix failed 'code' review findings/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: test/);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('wires review launch planning through next-step for failed current review plus blocked downstream lane', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'security');
        assert.equal(result.review.failed_review_type, 'security');
        assert.match(result.title, /Fix failed 'security' review findings/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: test/);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));

        const text = formatNextStepText(result);
        assert.match(text, /ReviewFailedCurrent: security/);
    });

    it('routes blocked failed downstream reviews back to stale upstream review lanes', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, { reviewPolicyMode: 'strict_sequential' });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'code');
        assert.equal(result.review.failed_review_type, null);
        assert.deepEqual(result.review.launchable_review_types, ['code']);
        assert.deepEqual(result.review.blocked_review_lanes, [
            {
                review_type: 'security',
                blocked_by: ['code'],
                reason: 'Waiting for current-cycle code review artifacts and receipts to pass.'
            },
            {
                review_type: 'refactor',
                blocked_by: ['code', 'security'],
                reason: 'Waiting for current-cycle code, security review artifacts and receipts to pass.'
            },
            {
                review_type: 'test',
                blocked_by: ['code', 'security', 'refactor'],
                reason: 'Waiting for current-cycle code, security, refactor review artifacts and receipts to pass.'
            }
        ]);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));
        assert.match(text, /ReviewLaunchableBatch: code/);
        assert.doesNotMatch(text, /ReviewFailedCurrent: refactor/);
    });

    it('reports strict_sequential downstream blockers after a failed code review', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(
            repoRoot,
            TASK_ID,
            { ...ALL_REVIEW_FLAGS, code: true, db: true, api: true, test: true },
            { reviewPolicyMode: 'strict_sequential' }
        );
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'implementation');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.reason, /REVIEW FAILED/);
        assert.match(result.reason, /Do not launch downstream reviewers/);
        assert.match(result.reason, /Dependent reviews currently blocked by this failure: db, api, test/);
        assert.ok(!result.commands[0].command.includes('--review-type "db"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('refreshes review context after a failed upstream review becomes stale behind a new compile cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context');
        assert.equal(result.review.next_review_type, 'code');
        assert.match(result.title, /Refresh 'code' review context/);
        assert.match(result.reason, /no longer current after the latest compile cycle/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('refreshes scoped diff before rebuilding a stale failed specialist review context', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, security: true });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.budget_forecast = {
            requested_depth: 2,
            effective_depth: 2,
            total_forecast_tokens: 1600,
            effective_forecast_tokens: 1200,
            token_economy_active_for_depth: true
        };
        preflight.risk_aware_depth = {
            compression: {
                scoped_diffs: true
            }
        };
        writeJson(preflightPath, preflight);
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'security', { verdict: 'fail' });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-scoped-diff');
        assert.equal(result.review.next_review_type, 'security');
        assert.match(result.title, /Prepare 'security' scoped diff metadata/);
        assert.ok(result.commands[0].command.includes('gate build-scoped-diff'));
        assert.ok(result.commands[0].command.includes('--review-type "security"'));
    });

    it('does not treat stale pre-compile review routing as upstream pass evidence', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-routing');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current REVIEWER_DELEGATION_ROUTED telemetry'));
        assertGateChainDecision(result.reason, {
            edgeId: 'review-context-to-routing',
            status: 'pass'
        });
        assert.ok(result.reason.includes('LaneScope=review_type'));
        assert.ok(result.reason.includes('opaque handoff artifact'));
        assert.ok(result.reason.includes('Do not open or summarize'));
        assert.ok(result.reason.includes('new clean-context delegated reviewer'));
        assert.ok(result.reason.includes('provider-native/internal agent or subagent tool'));
        assert.ok(result.reason.includes('not a shell command or hand-written artifact'));
        assert.ok(result.reason.includes('do not reuse an existing reviewer session'));
        assert.ok(result.reason.includes('fork_context=false'));
        assert.ok(result.reason.includes('If the current provider session cannot launch a fresh delegated reviewer, stop and report that blocker'));
        assert.ok(result.reason.includes('instead of fabricating routing, launch, review, receipt, or telemetry evidence'));
        assert.ok(result.reason.includes('Reviewer readiness chain: preflight scope=current -> review context=current'));
        assert.ok(result.reason.includes('routing=missing current-cycle telemetry'));
        assert.ok(result.reason.includes('launch artifact=blocked until routing'));
        assert.equal(result.commands[0].label, 'Record fresh delegated review routing');
    });

    it('rebinds downstream strict-sequential review when upstream reuse is recorded after downstream phase', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.ok(result.reason.includes("latest review phase predates the upstream review record"), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('advances to review gate when downstream current PASS context reuse is accepted after upstream remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'REVIEW_CONTEXT_REUSE_ACCEPTED', 'PASS', {
            review_type: 'test',
            current_pass_review_evidence: true,
            output_path: path.join(reviewsRoot(repoRoot), `${TASK_ID}-test-review-context.json`)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'required-reviews-check', result.reason);
        assert.ok(result.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('routes restarted downstream rebind through upstream reuse materialization first', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        appendEvent(repoRoot, TASK_ID, 'COMPLETION_GATE_FAILED', 'FAIL');
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { restarted: true });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        appendEvent(repoRoot, TASK_ID, 'HANDSHAKE_DIAGNOSTICS_RECORDED');
        appendEvent(repoRoot, TASK_ID, 'SHELL_SMOKE_PREFLIGHT_RECORDED');

        const testFile = path.join(repoRoot, 'tests', 'restart-cycle.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("restart cycle", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/restart-cycle.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'test'/);
        assert.match(result.reason, /instead of launching a fresh 'code' reviewer/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('does not rebind downstream strict-sequential review after the review gate passed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'test' });
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_PHASE_STARTED', 'INFO', { review_type: 'code' });
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });
        seedReviewGatePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'doc-impact-gate', result.reason);
        assert.ok(!result.commands[0].command.includes('build-review-context'));
        assert.ok(!result.reason.includes('latest review phase predates the upstream review record'));
    });

    it('materializes upstream code reuse before downstream test after test-only remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'test', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'test'/);
        assert.match(result.reason, /instead of launching a fresh 'code' reviewer/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('materializes upstream code reuse before downstream refactor after test-only remediation', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');

        fs.writeFileSync(
            testFile,
            'test("strict reuse remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'refactor', result.reason);
        assert.match(result.title, /Materialize 'code' review reuse before downstream 'refactor'/);
        assert.match(result.reason, /instead of launching a fresh 'code' reviewer/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));

        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', { review_type: 'code' });

        const securityResult = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(securityResult.next_gate, 'build-review-context', securityResult.reason);
        assert.equal(securityResult.review.next_review_type, 'refactor', securityResult.reason);
        assert.match(securityResult.title, /Materialize 'security' review reuse before downstream 'refactor'/);
        assert.match(securityResult.reason, /instead of launching a fresh 'security' reviewer/);
        assert.ok(!securityResult.commands[0].command.includes('--review-type "code"'));
        assert.ok(securityResult.commands[0].command.includes('--review-type "security"'));
        assert.ok(!securityResult.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(securityResult.invalidation_impact?.affected_review_lanes, ['security', 'refactor', 'test']);
        assert.deepEqual(securityResult.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(securityResult.invalidation_impact?.reuse_candidates, [
            'security (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'refactor (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
    });

    it('re-materializes stale upstream reuse after a later compile before downstream refactor', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'strict-reuse-repeat-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("strict reuse repeat remediation", () => {});\n', 'utf8');
        const changedFiles = ['src/app.ts', 'tests/strict-reuse-repeat-remediation.test.ts'];
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'code');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'security');
        markReviewEvidenceAsStrictReuse(repoRoot, TASK_ID, 'refactor');

        fs.writeFileSync(
            testFile,
            'test("strict reuse repeat remediation", () => { assert.equal(1, 1); });\n',
            'utf8'
        );
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles,
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Prepare 'code' review context/);
        assert.match(result.reason, /review-context artifact is stale for the current preflight/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "security"'));
        assert.ok(!result.commands[0].command.includes('--review-type "refactor"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, ['none indicated']);

        const text = formatNextStepText(result);
        assert.match(text, /InvalidationImpact:/);
        assert.match(text, /AffectedReviewLanes: code, security, refactor, test/);
        assert.match(text, /ReuseCandidates: none indicated/);
    });

    it('rebuilds stale failed downstream review after test-only remediation despite lane-domain match', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const testFile = path.join(repoRoot, 'tests', 'api-remediation.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("api remediation", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            refactor: true,
            api: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['tests/api-remediation.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'api', {
            verdict: 'fail',
            body: 'P1: API reviewer finding was fixed by a test-only remediation.\n\n'
        });

        fs.writeFileSync(testFile, 'test("api remediation", () => { assert.equal(1, 1); });\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            refactor: true,
            api: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['tests/api-remediation.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.equal(result.review.next_review_type, 'api');
        assert.match(result.title, /Refresh 'api' review context/);
        assert.match(result.reason, /no longer current after the latest compile cycle/);
        assert.ok(result.commands[0].command.includes('--review-type "api"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
        assert.ok(!result.title.includes('Fix failed'));
    });

    it('routes review-gate stale upstream failures to upstream rebind instead of retrying the review gate', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');

        const testFile = path.join(repoRoot, 'tests', 'review-gate-stale-upstream.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review gate stale upstream", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-stale-upstream.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Recover stale upstream 'code' review evidence/);
        assert.ok(result.reason.includes('required-reviews-check failed after compile'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.deepEqual(result.invalidation_impact?.stale_artifact_classes, [
            'preflight/scope',
            'compile evidence',
            'review context',
            'reviewer routing',
            'reviewer launch/invocation',
            'review artifact/receipt',
            'review gate evidence'
        ]);
        assert.deepEqual(result.invalidation_impact?.affected_review_lanes, ['code', 'test']);
        assert.deepEqual(result.invalidation_impact?.minimal_recovery_chain, [
            'build-review-context',
            'materialize current-cycle review reuse',
            'rerun navigator before downstream review/check gates'
        ]);
        assert.deepEqual(result.invalidation_impact?.reuse_candidates, [
            'code (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)',
            'test (current PASS evidence may be rebound; do not launch a fresh reviewer unless the navigator asks)'
        ]);
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('routes review-gate stale upstream failures even when upstream context is current after a later compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            security: true,
            refactor: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-gate-later-compile.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        writeReviewEvidence(repoRoot, TASK_ID, 'refactor');
        writeReviewEvidence(repoRoot, TASK_ID, 'test');
        seedCompilePass(repoRoot, TASK_ID);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_GATE_FAILED', 'FAIL', {
            violations: [
                "Review 'code' is missing matching REVIEWER_DELEGATION_ROUTED telemetry in the current cycle."
            ]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context', result.reason);
        assert.match(result.title, /Recover stale upstream 'code' review evidence/);
        assert.ok(result.reason.includes('required-reviews-check failed after compile'), result.reason);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
    });

    it('rejects receipt-spoofed lane-domain freshness when review context evidence changed', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const changedAfterReview = true;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const currentPreflight = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')
        ) as Record<string, unknown>;
        receipt.domain_scope_fingerprints = (currentPreflight.metrics as Record<string, unknown>).domain_scope_fingerprints;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-review-context');
        assert.ok(!result.commands[0].command.includes('required-reviews-check'));
        assert.ok(!result.review.launchable_review_types.includes('security'));
    });

    it('re-materializes lane-domain-current reused review evidence after a later compile', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const originalPreflight = JSON.parse(
            fs.readFileSync(path.join(reviewsRoot(repoRoot), `${TASK_ID}-preflight.json`), 'utf8')
        ) as Record<string, unknown>;
        const originalPreflightMetrics = originalPreflight.metrics as Record<string, unknown>;
        const originalLegacyScopes = ((originalPreflightMetrics.domain_scope_fingerprints as Record<string, unknown>)
            .legacy || {}) as Record<string, unknown>;
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_scope_sha256 = originalLegacyScopes.review_scope_sha256;
        receipt.code_scope_sha256 = originalLegacyScopes.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        const historicalReceiptSha256 = fileSha256(receiptPath);
        const historicalReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${historicalReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, historicalReceiptSnapshotPath);
        const historicalContextSha256 = fileSha256(contextPath);
        const reviewArtifactSha256 = fileSha256(artifactPath);
        const reviewArtifactSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-artifact-${reviewArtifactSha256}.md`
        );
        fs.copyFileSync(artifactPath, reviewArtifactSnapshotPath);
        const currentReviewContextReuseSha256 = '7'.repeat(64);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
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
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_receipt_sha256 = historicalReceiptSha256;
        receipt.review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_context_sha256 = historicalContextSha256;
        receipt.reused_from_review_context_reuse_sha256 = currentReviewContextReuseSha256;
        receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
        receipt.reused_from_review_scope_sha256 = receipt.review_scope_sha256;
        receipt.reused_from_code_scope_sha256 = receipt.code_scope_sha256;
        writeJson(receiptPath, receipt);
        const currentReceiptSha256 = fileSha256(receiptPath);
        const currentReceiptSnapshotPath = path.join(
            reviewsRoot(repoRoot),
            `${TASK_ID}-code-receipt-${currentReceiptSha256}.json`
        );
        fs.copyFileSync(receiptPath, currentReceiptSnapshotPath);
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
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
            review_context_reuse_sha256: currentReviewContextReuseSha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256
        });

        const testFile = path.join(repoRoot, 'tests', 'review-domain.test.ts');
        fs.mkdirSync(path.dirname(testFile), { recursive: true });
        fs.writeFileSync(testFile, 'test("review domain", () => {});\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            code: true,
            test: true
        }, {
            reviewPolicyMode: 'strict_sequential',
            changedFiles: ['src/app.ts', 'tests/review-domain.test.ts'],
            includeDomainScopeFingerprints: true
        });
        seedCompilePass(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.review.next_review_type, 'code', result.reason);
        assert.match(result.title, /Prepare 'code' review context/);
        assert.match(result.reason, /review-context artifact is stale for the current preflight/);
        assert.ok(result.commands[0].command.includes('--review-type "code"'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('rebuilds each stale specialist review context against the current preflight hash', () => {
        const repoRoot = makeTempRepo();
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        seedStartedTask(repoRoot, TASK_ID);
        const oldPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            db: true,
            security: true,
            refactor: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewContextOnly(repoRoot, TASK_ID, 'db', reviewerIdentity);
        writeReviewContextOnly(repoRoot, TASK_ID, 'security', reviewerIdentity);
        writeReviewContextOnly(repoRoot, TASK_ID, 'refactor', reviewerIdentity);
        const oldPreflightSha256 = fileSha256(oldPreflightPath);

        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const specialistRefresh = 3;\n', 'utf8');
        const currentPreflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            db: true,
            security: true,
            refactor: true
        });
        seedCompilePass(repoRoot, TASK_ID);
        const currentPreflightSha256 = fileSha256(currentPreflightPath);

        const dbResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(dbResult.next_gate, 'build-review-context');
        assert.equal(dbResult.review.next_review_type, 'db');
        assert.ok(dbResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(dbResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));

        writeReviewEvidence(repoRoot, TASK_ID, 'db');
        const securityResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(securityResult.next_gate, 'build-review-context');
        assert.equal(securityResult.review.next_review_type, 'security');
        assert.ok(securityResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(securityResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));

        writeReviewEvidence(repoRoot, TASK_ID, 'security');
        const refactorResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(refactorResult.next_gate, 'build-review-context');
        assert.equal(refactorResult.review.next_review_type, 'refactor');
        assert.ok(refactorResult.reason.includes(`preflight_sha256=${oldPreflightSha256}`));
        assert.ok(refactorResult.reason.includes(`preflight_sha256=${currentPreflightSha256}`));
    });

    it('blocks downstream review when current receipt provenance omits tree-state binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const provenance = receipt.reviewer_provenance as Record<string, unknown>;
        delete provenance.review_tree_state_sha256;
        receipt.reviewer_provenance = provenance;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('reviewer_provenance is missing review_tree_state_sha256'));
    });

    it('blocks downstream review when current review context omits tree-state binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');

        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const context = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
        const treeState = context.tree_state as Record<string, unknown>;
        const originalTreeStateSha256 = String(treeState.tree_state_sha256 || '').trim();
        delete context.tree_state;
        const contextText = `${JSON.stringify(context, null, 2)}\n`;
        fs.writeFileSync(contextPath, contextText, 'utf8');

        const reviewerIdentity = 'agent:code-reviewer';
        const routeIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const invocationIntegrity = appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            task_id: TASK_ID,
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity,
            reviewer_identity: reviewerIdentity,
            review_context_sha256: sha256Text(contextText),
            review_tree_state_sha256: originalTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256
        });
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_context_sha256 = sha256Text(contextText);
        receipt.review_tree_state_sha256 = originalTreeStateSha256;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            task_sequence: invocationIntegrity.task_sequence,
            prev_event_sha256: invocationIntegrity.prev_event_sha256,
            event_sha256: invocationIntegrity.event_sha256,
            review_context_sha256: sha256Text(contextText),
            review_tree_state_sha256: originalTreeStateSha256,
            routing_event_sha256: routeIntegrity.event_sha256
        };
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('review context is missing tree_state.tree_state_sha256'));
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });

    it('blocks downstream review when reused review telemetry omits tree-state reuse binding', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const artifactPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code.md`);
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-review-context.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const historicalTreeStateSha = '8'.repeat(64);
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_review_context_sha256 = '6'.repeat(64);
        receipt.reused_from_review_context_reuse_sha256 = '7'.repeat(64);
        receipt.reused_from_review_tree_state_sha256 = historicalTreeStateSha;
        receipt.reviewer_provenance = {
            ...(receipt.reviewer_provenance as Record<string, unknown>),
            task_sequence: 1,
            prev_event_sha256: null,
            event_sha256: '9'.repeat(64),
            review_tree_state_sha256: historicalTreeStateSha
        };
        writeJson(receiptPath, receipt);
        const { reused_from_review_tree_state_sha256, ...receiptWithoutReuseTreeState } = receipt;
        void reused_from_review_tree_state_sha256;
        appendEvent(repoRoot, TASK_ID, 'REVIEW_RECORDED', 'PASS', {
            ...receiptWithoutReuseTreeState,
            receipt_path: receiptPath,
            review_artifact_path: artifactPath,
            review_artifact_sha256: fileSha256(artifactPath),
            review_context_path: contextPath,
            review_context_sha256: fileSha256(contextPath),
            review_context_reuse_sha256: receipt.reused_from_review_context_reuse_sha256,
            review_tree_state_sha256: receipt.review_tree_state_sha256,
            reused_existing_review: true,
            reused_from_receipt_path: receiptPath,
            reused_from_review_context_sha256: receipt.reused_from_review_context_sha256,
            reused_from_review_context_reuse_sha256: receipt.reused_from_review_context_reuse_sha256
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current-cycle REVIEW_RECORDED reuse telemetry'), result.reason);
    });

    it('blocks reused review receipts even when preserved invocation provenance is otherwise valid', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        const reviewerProvenance = receipt.reviewer_provenance as Record<string, unknown>;
        receipt.reused_existing_review = true;
        receipt.reused_from_receipt_path = receiptPath;
        receipt.reused_from_review_context_sha256 = receipt.review_context_sha256;
        receipt.reused_from_review_context_reuse_sha256 = '7'.repeat(64);
        receipt.reused_from_review_tree_state_sha256 = reviewerProvenance.review_tree_state_sha256;
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes('current-cycle REVIEW_RECORDED reuse telemetry'), result.reason);
    });

    it('routes hidden timing distrust back to review result with generic remediation only', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, test: true });
        seedCompilePass(repoRoot, TASK_ID);
        writeReviewEvidence(repoRoot, TASK_ID, 'code');
        const receiptPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-code-receipt.json`);
        const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.review_output_source_mtime_utc = '2026-04-27T23:59:59.000Z';
        writeJson(receiptPath, receipt);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result', result.reason);
        assert.equal(result.review.next_review_type, 'code');
        assert.ok(result.reason.includes("Required review 'code' evidence is not sufficiently trustworthy"), result.reason);
        assert.ok(result.reason.includes('Launch a real subagent using built-in tools'), result.reason);
        assert.equal(/timing|threshold|elapsed|duration|seconds|impossible_ordering|missing_timing/i.test(result.reason), false);
        assert.ok(!result.commands[0].command.includes('--review-type "test"'));
    });
});
