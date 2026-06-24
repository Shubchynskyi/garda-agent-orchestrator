import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { initGitRepo } from '../git-fixtures';

import { resolveNextStep } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildDomainScopeFingerprints } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';

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





function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
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
    const delegationStartedAtUtc = '2026-04-28T00:00:00.000Z';
    const launchCompletedAtUtc = '2026-04-28T00:00:12.000Z';
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
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        ...launchInputEvidenceFixture(taskId, reviewType),
        fork_context: false
    });
    appendEvent(repoRoot, taskId, 'REVIEWER_DELEGATION_STARTED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        provider_invocation_id: `test-${reviewType}-invocation`,
        delegation_started_at_utc: delegationStartedAtUtc
    });
    appendEvent(repoRoot, taskId, 'REVIEWER_LAUNCH_COMPLETED', 'INFO', {
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: reviewerIdentity,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: fileSha256(reviewContextPath),
        routing_event_sha256: routeIntegrity.event_sha256,
        reviewer_launch_artifact_path: launchArtifactPath,
        reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
        provider_invocation_id: `test-${reviewType}-invocation`,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc
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
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
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






afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step post preflight binding', () => {
    it('routes stale scoped diff metadata back to build-scoped-diff before review context', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'token-economy.json'), {
            enabled: false,
            enabled_depths: [2],
            scoped_diffs: false
        });
        const preflightPath = writePreflight(repoRoot, TASK_ID, {
            ...ALL_REVIEW_FLAGS,
            security: true
        });
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

        const metrics = preflight.metrics as Record<string, unknown>;
        const metadataPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security-scoped.json`);
        const outputPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-security-scoped.diff`);
        writeJson(metadataPath, {
            review_type: 'security',
            preflight_path: preflightPath.replace(/\\/g, '/'),
            preflight_sha256: '0'.repeat(64),
            changed_files_sha256: metrics.changed_files_sha256,
            scope_content_sha256: metrics.scope_content_sha256,
            scope_sha256: metrics.scope_sha256,
            output_path: outputPath.replace(/\\/g, '/'),
            metadata_path: metadataPath.replace(/\\/g, '/'),
            changed_files: ['src/app.ts'],
            output_diff_line_count: 4
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'build-scoped-diff');
        assert.ok(result.reason.includes('stale preflight_sha256'));
        assert.ok(result.commands[0].command.includes('gate build-scoped-diff'));
    });

    it('routes stale POST_PREFLIGHT evidence back to load-rule-pack after preflight refresh', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS });
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        preflight.required_reviews = { ...ALL_REVIEW_FLAGS, code: true, test: true };
        writeJson(preflightPath, preflight);
        appendEvent(repoRoot, TASK_ID, 'PREFLIGHT_CLASSIFIED', 'INFO', {
            output_path: normalizeForTimeline(preflightPath)
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.ok(result.reason.includes('Rule-pack evidence'));
        assert.ok(result.commands[0].command.includes('--stage "POST_PREFLIGHT"'));
        assert.ok(!result.commands[0].command.includes('<task-specific-rule-file>'));
        assert.deepEqual(getLoadedRuleFileBasenames(result.commands[0].command), [
            '00-core.md',
            '15-project-memory.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('routes stale docs-only workspace changes to classify-change before missing POST_PREFLIGHT rules', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const preflighted = 1;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '\nDocument late change.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.title, /Refresh preflight for the current workspace/);
        assert.match(result.reason, /Preflight scope is stale before compile/);
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--changed-file "CHANGELOG.md"'));
        assert.ok(!result.commands[0].command.includes('--stage "POST_PREFLIGHT"'));
        assert.ok(!result.commands[0].command.includes('bind-rule-pack-to-preflight'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));
    });

    it('routes equivalent current-cycle POST_PREFLIGHT refreshes to evidence binding instead of rereading rules', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const refreshed = 1;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'bind-rule-pack-to-preflight');
        assert.match(result.title, /Bind existing POST_PREFLIGHT/);
        assert.match(result.reason, /only the preflight binding must be refreshed/);
        assert.ok(result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
        assert.ok(!result.commands[0].command.includes('--loaded-rule-file'));
    });

    it('routes stale docs-only workspace changes to classify-change before POST_PREFLIGHT rebind', () => {
        const repoRoot = makeTempRepo();
        initGitRepo(repoRoot);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const preflighted = 1;\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath);
        fs.appendFileSync(path.join(repoRoot, 'CHANGELOG.md'), '\nDocument late rebind change.\n', 'utf8');

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.match(result.title, /Refresh preflight for the current workspace/);
        assert.match(result.reason, /Preflight scope is stale before compile/);
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.ok(result.commands[0].command.includes('--changed-file "CHANGELOG.md"'));
        assert.ok(!result.commands[0].command.includes('bind-rule-pack-to-preflight'));
        assert.ok(!result.commands[0].command.includes('gate compile-gate'));
    });

    it('preserves custom task-mode path when binding refreshed POST_PREFLIGHT evidence', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-task-mode.json`);
        writeJson(customTaskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
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
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: normalizeForTimeline(customTaskModePath)
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', customTaskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);
        fs.appendFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const customRefresh = 1;\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'bind-rule-pack-to-preflight');
        assert.ok(result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
        assert.ok(result.commands[0].command.includes(`--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`));
    });

    it('preserves custom task-mode path when running compile after POST_PREFLIGHT binding', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-task-mode.json`);
        writeJson(customTaskModePath, buildTaskModeArtifact({
            taskId: TASK_ID,
            entryMode: 'EXPLICIT_TASK_EXECUTION',
            requestedDepth: 2,
            effectiveDepth: 2,
            taskSummary: 'Seeded custom compile task',
            startBanner: 'Garda captures my mind',
            provider: 'Codex',
            canonicalSourceOfTruth: 'Codex',
            executionProviderSource: 'explicit_provider',
            runtimeIdentityStatus: 'resolved'
        }));
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', {
            artifact_path: normalizeForTimeline(customTaskModePath)
        });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY', customTaskModePath);
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'compile-gate');
        assert.ok(result.commands[0].command.includes('gate compile-gate'));
        assert.ok(result.commands[0].command.includes(`--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`));
    });

    it('preserves custom task-mode path across review preparation commands', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = seedCustomStartedTask(repoRoot, TASK_ID);
        const customTaskModeOption = `--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`;
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);
        seedCompilePass(repoRoot, TASK_ID);

        const contextResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(contextResult.next_gate, 'build-review-context');
        assert.ok(contextResult.commands[0].command.includes('gate build-review-context'));
        assert.ok(contextResult.commands[0].command.includes(customTaskModeOption));
        assert.ok(contextResult.present_artifacts.some((artifact) => (
            artifact.key === 'task-mode'
            && artifact.path === normalizeForTimeline(path.relative(repoRoot, customTaskModePath))
        )));

        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        const routingResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(routingResult.next_gate, 'record-review-routing');
        assert.ok(routingResult.commands[0].command.includes('gate record-review-routing'));
        assert.ok(routingResult.commands[0].command.includes(customTaskModeOption));

        appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', 'INFO', {
            review_type: 'code',
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: reviewerIdentity
        });
        const launchResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(launchResult.next_gate, 'prepare-reviewer-launch');
        assert.ok(launchResult.commands[0].command.includes('gate prepare-reviewer-launch'));
        assert.ok(launchResult.commands[0].command.includes(customTaskModeOption));
    });

    it('preserves custom task-mode path across review result and closeout commands', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = seedCustomStartedTask(repoRoot, TASK_ID);
        const customTaskModeOption = `--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`;
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);
        seedCompilePass(repoRoot, TASK_ID);

        const reviewGateResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(reviewGateResult.next_gate, 'required-reviews-check');
        assert.ok(reviewGateResult.commands[0].command.includes('gate required-reviews-check'));
        assert.ok(reviewGateResult.commands[0].command.includes(customTaskModeOption));

        seedReviewGatePass(repoRoot, TASK_ID);
        seedDocImpactPass(repoRoot, TASK_ID);
        const completionResult = resolveNextStep({ taskId: TASK_ID, repoRoot });
        assert.equal(completionResult.next_gate, 'completion-gate');
        assert.ok(completionResult.commands[0].command.includes('gate completion-gate'));
        assert.ok(completionResult.commands[0].command.includes(customTaskModeOption));
    });

    it('preserves custom task-mode path when recording delegated review output', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = seedCustomStartedTask(repoRoot, TASK_ID);
        const customTaskModeOption = `--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`;
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);
        seedCompilePass(repoRoot, TASK_ID);
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        seedCompletedReviewerLaunchAndInvocation(repoRoot, TASK_ID, 'code', reviewerIdentity);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-result');
        assert.ok(result.commands[0].command.includes('gate record-review-result'));
        assert.ok(result.commands[0].command.includes(customTaskModeOption));
    });

    it('preserves custom task-mode path when attesting delegated review invocation', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = seedCustomStartedTask(repoRoot, TASK_ID);
        const customTaskModeOption = `--task-mode-path "${normalizeForTimeline(path.relative(repoRoot, customTaskModePath))}"`;
        const preflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, preflightPath, customTaskModePath);
        seedCompilePass(repoRoot, TASK_ID);
        const reviewerIdentity = 'agent:019dc191-3d81-7091-aca0-9f44b440328b';
        writeReviewContextOnly(repoRoot, TASK_ID, 'code', reviewerIdentity);
        seedCompletedReviewerLaunchAndInvocation(repoRoot, TASK_ID, 'code', reviewerIdentity, { includeInvocation: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-review-invocation');
        assert.ok(result.commands[0].command.includes('gate record-review-invocation'));
        assert.ok(result.commands[0].command.includes(customTaskModeOption));
    });

    it('preserves custom task-mode path when restarting an incoherent preflight cycle', () => {
        const repoRoot = makeTempRepo();
        const customTaskModePath = seedCustomStartedTask(repoRoot, TASK_ID);
        const initialPreflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, initialPreflightPath, customTaskModePath);
        seedCompilePass(repoRoot, TASK_ID);
        seedReviewGatePass(repoRoot, TASK_ID);
        const refreshedPreflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        seedPostPreflightRulePack(repoRoot, TASK_ID, refreshedPreflightPath, customTaskModePath);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'restart-coherent-cycle');
        assert.ok(result.commands[0].command.includes('gate restart-coherent-cycle'));
        assert.ok(result.commands[0].command.includes(`--task-mode-path '${customTaskModePath}'`));
    });

    it('keeps POST_PREFLIGHT reread guidance when refreshed preflight changes required rule files', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true, security: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.title, /Read and record POST_PREFLIGHT/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(result.commands[0].command.includes('--loaded-rule-file'));
        assert.deepEqual(getLoadedRuleFileBasenames(result.commands[0].command), [
            '00-core.md',
            '15-project-memory.md',
            '35-strict-coding-rules.md',
            '40-commands.md',
            '50-structure-and-docs.md',
            '70-security.md',
            '80-task-workflow.md',
            '90-skill-catalog.md'
        ]);
    });

    it('keeps POST_PREFLIGHT reread guidance when prior rule-pack evidence references missing rule files', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        const rulePackPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(rulePackPath, 'utf8')) as Record<string, any>;
        artifact.stages.post_preflight.loaded_rule_files.push(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', 'deleted-rule.md').replace(/\\/g, '/')
        );
        artifact.stages.post_preflight.required_rule_files.push(
            path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules', 'deleted-rule.md').replace(/\\/g, '/')
        );
        writeJson(rulePackPath, artifact);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.title, /Read and record POST_PREFLIGHT/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(!result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
    });

    it('keeps POST_PREFLIGHT reread guidance after a resumed task-mode cycle', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { restarted: true });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.title, /Read and record POST_PREFLIGHT/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(!result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
    });

    it('keeps POST_PREFLIGHT reread guidance when current-cycle evidence belongs to another artifact', () => {
        const repoRoot = makeTempRepo();
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        appendEvent(repoRoot, TASK_ID, 'TASK_MODE_ENTERED', 'PASS', { restarted: true });
        seedRulePack(repoRoot, TASK_ID, 'TASK_ENTRY');
        seedHandshake(repoRoot, TASK_ID);
        seedShellSmoke(repoRoot, TASK_ID);
        const refreshedPreflightPath = writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });
        appendEvent(repoRoot, TASK_ID, 'RULE_PACK_LOADED', 'PASS', {
            stage: 'POST_PREFLIGHT',
            preflight_path: normalizeForTimeline(refreshedPreflightPath),
            artifact_path: normalizeForTimeline(path.join(reviewsRoot(repoRoot), `${TASK_ID}-custom-rule-pack.json`))
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.title, /Read and record POST_PREFLIGHT/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(!result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
    });

    it('keeps POST_PREFLIGHT reread guidance when an extra loaded rule file changed', () => {
        const repoRoot = makeTempRepo();
        const extraRulePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'live',
            'docs',
            'agent-rules',
            'project-specific-rule.md'
        );
        fs.writeFileSync(extraRulePath, '# Project specific rule\n\nInitial content.\n', 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: true });
        const rulePackPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-rule-pack.json`);
        const artifact = JSON.parse(fs.readFileSync(rulePackPath, 'utf8')) as Record<string, any>;
        const normalizedExtraRulePath = normalizeForTimeline(extraRulePath);
        artifact.stages.post_preflight.loaded_rule_files.push(normalizedExtraRulePath);
        artifact.stages.post_preflight.extra_rule_files.push(normalizedExtraRulePath);
        artifact.stages.post_preflight.loaded_rule_hashes[normalizedExtraRulePath] = fileSha256(extraRulePath);
        artifact.stages.post_preflight.loaded_rule_count = artifact.stages.post_preflight.loaded_rule_files.length;
        writeJson(rulePackPath, artifact);

        fs.writeFileSync(extraRulePath, '# Project specific rule\n\nUpdated content.\n', 'utf8');
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true }, { seedPostPreflight: false });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'load-rule-pack');
        assert.match(result.title, /Read and record POST_PREFLIGHT/);
        assert.match(result.reason, /changed or cannot be hashed/);
        assert.ok(result.commands[0].command.includes('gate load-rule-pack'));
        assert.ok(!result.commands[0].command.includes('gate bind-rule-pack-to-preflight'));
    });
});
