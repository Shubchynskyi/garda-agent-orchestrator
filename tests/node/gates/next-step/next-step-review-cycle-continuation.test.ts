import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { getWorkspaceSnapshot } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import {
    REVIEW_CYCLE_CONTINUATION_EVENT,
    buildReviewCycleContinuationArtifact
} from '../../../../src/gates/review-cycle/review-cycle-continuation';

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

afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step review cycle continuation', () => {
    it('uses an active one-shot continuation without changing workflow-config.json', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        const configPath = path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json');
        writeJson(configPath, workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                review_type: 'code',
                reviewer_identity: `agent:code-one-shot-active-${index}`,
                review_context_sha256: sha256Text(`code-one-shot-active-${index}`)
            });
        }
        const beforeConfig = fs.readFileSync(configPath, 'utf8');
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(text.includes('Review cycle one-shot continuation active'));
        assert.ok(text.includes('does not mutate workflow-config.json'));
        assert.equal(fs.readFileSync(configPath, 'utf8'), beforeConfig);
    });

    it('blocks attempted reuse after the one-shot continuation count is consumed', () => {
        const repoRoot = makeTempRepo();
        const workflowConfig = buildDefaultWorkflowConfig();
        workflowConfig.full_suite_validation.enabled = false;
        workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
        workflowConfig.review_cycle_guard.max_total_non_test_reviews = 2;
        writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
        seedStartedTask(repoRoot, TASK_ID);
        writePreflight(repoRoot, TASK_ID, { ...ALL_REVIEW_FLAGS, code: true });
        for (let index = 0; index < 3; index += 1) {
            appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
                review_type: 'code',
                reviewer_identity: `agent:code-one-shot-reuse-baseline-${index}`,
                review_context_sha256: sha256Text(`code-one-shot-reuse-baseline-${index}`)
            });
        }
        writeReviewCycleContinuation(repoRoot, TASK_ID, {
            baselineTotalNonTestReviewCount: 3,
            baselineFailedNonTestReviewCount: 0,
            maxTotalNonTestReviews: 2
        });
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', 'INFO', {
            review_type: 'code',
            reviewer_identity: 'agent:code-one-shot-reuse-extra-0',
            review_context_sha256: sha256Text('code-one-shot-reuse-extra-0')
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'review-cycle-attempt-guard');
        assert.ok(text.includes('Review cycle one-shot continuation expired'));
        assert.ok(text.includes('already used'));
        assert.equal(result.commands[0]?.label, 'Record one-shot review-cycle continuation');
    });
});

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-continuation-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'docs', 'agent-rules'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'bin'), { recursive: true });
    fs.mkdirSync(path.join(repoRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, 'bin', 'garda.js'), '#!/usr/bin/env node\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'src', 'app.ts'), 'export const value = 1;\n', 'utf8');
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '# TASK.md',
        '',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | TODO | P1 | workflow/review-cycle | Review cycle continuation | gpt-5.4 | 2026-04-25 | balanced | Test queue entry. |`,
        ''
    ].join('\n'), 'utf8');
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
    workflowConfig.review_execution_policy = { mode: 'code_first_optional' };
    workflowConfig.project_memory_maintenance.enabled = false;
    workflowConfig.project_memory_maintenance.mode = 'check';
    writeJson(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'), workflowConfig);
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

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome = 'PASS',
    details: Record<string, unknown> = {}
): void {
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
        timestamp_utc: new Date().toISOString(),
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
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
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

function seedRulePack(repoRoot: string, taskId: string, stage: 'TASK_ENTRY' | 'POST_PREFLIGHT', preflightPath = ''): void {
    const rulePackPath = path.join(reviewsRoot(repoRoot), `${taskId}-rule-pack.json`);
    const loadedRuleFiles = stage === 'POST_PREFLIGHT'
        ? [
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
        : ['00-core.md', '15-project-memory.md', '40-commands.md', '80-task-workflow.md', '90-skill-catalog.md'];
    const artifact = buildRulePackArtifact({
        repoRoot,
        taskId,
        stage,
        preflightPath,
        loadedRuleFiles
    });
    writeJson(rulePackPath, artifact);
    appendEvent(repoRoot, taskId, 'RULE_PACK_LOADED', 'PASS', {
        stage,
        ...(preflightPath ? { preflight_path: normalizeForTimeline(preflightPath) } : {}),
        artifact_path: normalizeForTimeline(rulePackPath)
    });
}

function writePreflight(repoRoot: string, taskId: string, requiredReviews: Record<string, boolean>): string {
    const preflightPath = path.join(reviewsRoot(repoRoot), `${taskId}-preflight.json`);
    const changedFiles = ['src/app.ts'];
    const snapshot = getWorkspaceSnapshot(repoRoot, 'explicit_changed_files', true, changedFiles);
    writeJson(preflightPath, {
        task_id: taskId,
        detection_source: snapshot.detection_source,
        mode: 'FULL_PATH',
        scope_category: 'code',
        metrics: {
            changed_lines_total: snapshot.changed_lines_total,
            changed_files_sha256: snapshot.changed_files_sha256,
            scope_content_sha256: snapshot.scope_content_sha256,
            scope_sha256: snapshot.scope_sha256
        },
        required_reviews: requiredReviews,
        changed_files: changedFiles,
        review_execution_policy: {
            mode: 'code_first_optional',
            visible_summary_line: 'Review execution policy: code_first_optional'
        }
    });
    appendEvent(repoRoot, taskId, 'PREFLIGHT_CLASSIFIED', 'INFO', {
        output_path: normalizeForTimeline(preflightPath)
    });
    seedRulePack(repoRoot, taskId, 'POST_PREFLIGHT', preflightPath);
    return preflightPath;
}

function writeReviewCycleContinuation(
    repoRoot: string,
    taskId: string,
    options: {
        baselineTotalNonTestReviewCount: number;
        baselineFailedNonTestReviewCount: number;
        maxTotalNonTestReviews?: number;
        maxFailedNonTestReviews?: number;
        excludedReviewTypes?: string[];
    }
): void {
    const artifactPath = path.join(reviewsRoot(repoRoot), `${taskId}-review-cycle-continuation.json`);
    const artifact = buildReviewCycleContinuationArtifact({
        taskId,
        decision: 'allow_one_more_cycle',
        reason: 'Operator approved one more review-cycle continuation for the test.',
        operatorConfirmedAtUtc: new Date().toISOString(),
        baselineTotalNonTestReviewCount: options.baselineTotalNonTestReviewCount,
        baselineFailedNonTestReviewCount: options.baselineFailedNonTestReviewCount,
        maxTotalNonTestReviews: options.maxTotalNonTestReviews ?? 2,
        maxFailedNonTestReviews: options.maxFailedNonTestReviews ?? 15,
        excludedReviewTypes: options.excludedReviewTypes || ['test']
    });
    writeJson(artifactPath, artifact);
    appendEvent(repoRoot, taskId, REVIEW_CYCLE_CONTINUATION_EVENT, 'INFO', {
        artifact_path: normalizeForTimeline(artifactPath),
        artifact_sha256: fileSha256(artifactPath),
        decision: 'allow_one_more_cycle',
        one_shot: true,
        baseline_total_non_test_review_count: options.baselineTotalNonTestReviewCount,
        baseline_failed_non_test_review_count: options.baselineFailedNonTestReviewCount
    });
}
