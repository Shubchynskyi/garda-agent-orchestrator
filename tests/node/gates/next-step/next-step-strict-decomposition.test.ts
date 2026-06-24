import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { buildRulePackArtifact } from './next-step-test-support';
import { buildTaskModeArtifact } from './next-step-test-support';
import { buildEventIntegrityHash } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';
import { buildStrictDecompositionDecisionArtifact } from './next-step-test-support';

const TASK_ID = 'T-NEXT-1';


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




function normalizeForTimeline(filePath: string): string {
    return filePath.replace(/\\/g, '/');
}























afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step strict decomposition', () => {
    it('routes risky strict tasks to a decomposition decision before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('requires a current strict decomposition decision'));
        assert.ok(result.reason.includes('EVIDENCE_FILE_MISSING'));
        assert.ok(result.reason.includes('task_text:decomposition'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
        assert.ok(result.commands[0].command.includes('--task-summary "Seeded next-step task"'));
        assert.ok(result.commands[0].command.includes('--expected-review-type "none"'));
        assert.equal(text.includes('gate classify-change'), false);
        assert.equal(text.includes('gate compile-gate'), false);
    });

    it('keeps tiny local strict tasks out of the decomposition prompt', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P2 | tests/local | Fix one typo in local test wording | gpt-5.4 | 2026-05-20 | strict | Tiny local wording fix. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.equal(result.commands[0].command.includes('record-strict-decomposition-decision'), false);
    });

    it('routes broad strict multi-domain tasks with localization wording before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/checks-memory-backups-reset-i18n | Surface full-suite timing, memory prompt, manual backups, reset readiness, and localization audit in UI | gpt-5.4 | 2026-05-20 | strict | Scope: Checks tab timing; Project Memory prompt path; Backup UI manual action; Task reset readiness; all affected language packs. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.reason.includes('task_text:broad-enumerated-scope'));
        assert.ok(result.reason.includes('i18n'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
        assert.equal(text.includes('gate classify-change'), false);
    });

    it('does not treat preview and reporting substrings as broad review or report domains', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P2 | tests/local | Preview reporting copy for memory note | gpt-5.4 | 2026-05-20 | strict | Tiny local copy check for memory wording. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
        assert.equal(text.includes('record-strict-decomposition-decision'), false);
        assert.equal(text.includes('task_text:broad-domains='), false);
    });

    it('still counts deliberate reviewer and reports aliases as broad-domain signals', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/reviewer-reports-memory | Route reviewer reports and memory workflow planning | gpt-5.4 | 2026-05-20 | strict | Scope covers reviewer routing, reports UI, project memory, and workflow gates. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.reason.includes('review'));
        assert.ok(result.reason.includes('ui'));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
    });

    it('does not let low-risk copy wording exempt broad strict multi-domain tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | ui/settings-memory-backup-reset-i18n | Copy UI settings, memory backup, reset, and localization audit guidance | gpt-5.4 | 2026-05-20 | strict | Scope crosses UI, configuration, project memory, backup, reset, and language-pack audit behavior. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('task_text:broad-domains='));
        assert.ok(result.commands[0].command.includes('gate record-strict-decomposition-decision'));
    });

    it('accepts current single-cycle decomposition evidence before classify-change', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'single-cycle',
            taskSummary: 'Seeded next-step task',
            expectedReviewTypes: ['none']
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'classify-change');
        assert.ok(result.commands[0].command.includes('gate classify-change'));
    });

    it('rejects stale strict decomposition decisions bound to an old task summary', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            taskSummary: 'Old task summary that no longer matches the current task-mode evidence.'
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.next_gate, 'record-strict-decomposition-decision');
        assert.ok(result.reason.includes('EVIDENCE_TASK_SUMMARY_MISMATCH'));
        assert.ok(result.commands[0].command.includes('--task-summary "Seeded next-step task"'));
    });

    it('suppresses ordinary gates when a current strict decomposition decision requires split', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-next-step-enforcement | Make next-step require a current decomposition decision | gpt-5.4 | 2026-05-20 | strict | Risky strict workflow routing guard. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.equal(result.commands.length, 0);
        assert.ok(result.reason.includes('split-required'));
        assert.ok(result.reason.includes(`${TASK_ID}-1`));
        assert.ok(result.reason.includes('missing linked proposed child tasks'));
        assert.equal(text.includes('gate classify-change'), false);
        assert.equal(text.includes('gate compile-gate'), false);
    });

    it('routes strict split-required decisions through linked parent-derived strict children', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-2\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | First child | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-2 | TODO | P1 | workflow/strict-decomposition-split-routing | Second child | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`, `${TASK_ID}-2`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const text = formatNextStepText(result);
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');
        const events = fs.readFileSync(path.join(eventsRoot(repoRoot), `${TASK_ID}.jsonl`), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes(`next-step "${TASK_ID}-1"`));
        assert.ok(result.reason.includes('linked parent-derived strict child tasks match the decision artifact'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | DECOMPOSED |`));
        assert.ok(events.includes('"event_type":"STRICT_DECOMPOSITION_SPLIT_ROUTED"'));
        assert.ok(text.includes('Status: DECOMPOSED'));
    });

    it('blocks strict split-required routing when a proposed child is not strict', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | First child | gpt-5.4 | 2026-05-20 | balanced | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('child tasks without strict profile'));
        assert.ok(taskMd.includes(`| ${TASK_ID} | TODO |`));
    });

    it('blocks strict split-required routing for unexpected linked child tasks', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            `| ${TASK_ID} | TODO | P1 | workflow/strict-decomposition-split-routing | Route strict split decisions to children | gpt-5.4 | 2026-05-20 | strict | Child tasks: \`${TASK_ID}-1\` and \`${TASK_ID}-extra\`. |`,
            `| ${TASK_ID}-1 | TODO | P1 | workflow/strict-decomposition-split-routing | First child | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            `| ${TASK_ID}-extra | TODO | P1 | workflow/strict-decomposition-split-routing | Extra child | gpt-5.4 | 2026-05-20 | strict | Child of ${TASK_ID}. |`,
            ''
        ].join('\n'), 'utf8');
        seedStartedTask(repoRoot, TASK_ID);
        writeStrictDecompositionDecision(repoRoot, TASK_ID, {
            decision: 'split-required',
            taskSummary: 'Seeded next-step task',
            proposedChildTaskIds: [`${TASK_ID}-1`]
        });

        const result = resolveNextStep({ taskId: TASK_ID, repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'strict-decomposition-split-routing');
        assert.ok(result.reason.includes('linked child tasks not declared in the decision artifact'));
        assert.ok(result.reason.includes(`${TASK_ID}-extra`));
    });
});
