import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { formatNextStepText, resolveNextStep } from './next-step-test-support';
import { extractExplicitLinkedChildTaskIds } from './next-step-test-support';
import { buildDefaultWorkflowConfig } from './next-step-test-support';

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



function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}








































afterEach(() => {
    for (const tempRoot of tempRoots) {
        fs.rmSync(tempRoot, { recursive: true, force: true });
    }
    tempRoots = [];
});

describe('gates/next-step decomposed parent child parsing', () => {
    it('does not mark decomposed parents DONE when an explicit range child is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-601 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks `T-602` through `T-603`. |',
            '| T-602 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-601', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-603'));
        assert.ok(taskMd.includes('| T-601 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a backticked explicit child is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-604 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks `T-CUSTOM-CHILD` and `T-605`. |',
            '| T-605 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-604', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-CUSTOM-CHILD'));
        assert.ok(taskMd.includes('| T-604 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a plain conventional child ID is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-700 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.5 | 2026-05-06 | strict | Split into child tasks T-701 and T-702. |',
            '| T-701 | 🟩 DONE | P1 | workflow | Existing child | gpt-5.5 | 2026-05-06 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-700', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-702'));
        assert.ok(taskMd.includes('| T-700 | 🟪 DECOMPOSED |'));
    });

    it('stops explicit child parsing before then-continue note text', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Split into child tasks T-711, then continue with T-712 as unrelated operator guidance.',
            ['T-711', 'T-712']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-711']);
    });

    it('parses plain comma-separated suffixed child task IDs in explicit child lists', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Child tasks: T-091-1, T-091-2.',
            ['T-091-1', 'T-091-2']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-091-1', 'T-091-2']);
    });

    it('ignores task IDs in unrelated note segments after explicit child links', () => {
        const linkedChildTaskIds = extractExplicitLinkedChildTaskIds(
            'Split into child tasks `T-721`. Security review artifact `T-722` and source note T-723 are unrelated.',
            ['T-721', 'T-722', 'T-723']
        );

        assert.deepEqual(linkedChildTaskIds, ['T-721']);
    });

    it('routes decomposed parent tasks to nonnumeric child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-520 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-NEXT-1`; continue there. |',
            '| T-NEXT-1 | 🟦 TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-520', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-NEXT-1"'));
    });

    it('routes suffixed child task IDs without partially matching their parent prefix', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-500 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: `T-500-1`. |',
            '| T-500-1 | 🟦 TODO | P1 | workflow | Suffixed child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-500', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-500-1"'));
        assert.equal(result.reason.includes('could not be found'), false);
    });

    it('does not mark a decomposed parent DONE while a plain suffixed comma child remains unfinished', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-091 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: T-091-1, T-091-2. |',
            '| T-091-1 | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-091-2 | 🟦 TODO | P1 | workflow | Second child | gpt-5.4 | 2026-05-05 | strict | Still open. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-091', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-091-2"'));
        assert.ok(taskMd.includes('| T-091 | 🟪 DECOMPOSED |'));
    });

    it('does not mark decomposed parents DONE when a plain suffixed comma child row is missing', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-091 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Child tasks: T-091-1, T-091-2. |',
            '| T-091-1 | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-091', repoRoot });
        const taskMd = fs.readFileSync(path.join(repoRoot, 'TASK.md'), 'utf8');

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, null);
        assert.ok(result.reason.includes('Explicit child task link(s) could not be found'));
        assert.ok(result.reason.includes('T-091-2'));
        assert.ok(taskMd.includes('| T-091 | 🟪 DECOMPOSED |'));
    });

    it('routes decomposed parents to exact-case semantic child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-530 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-CLI-ART` and `T-next-1`; continue with the first unfinished child. |',
            '| T-CLI-ART | 🟩 DONE | P1 | workflow | First child | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-next-1 | 🟦 TODO | P1 | workflow | Mixed-case child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-530', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-next-1"'));
        assert.equal(result.commands[0].command.includes('T-NEXT-1'), false);
    });

    it('preserves parent note order for semantic child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-540 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-A` and `T-LONG-CHILD`; continue with the first unfinished child. |',
            '| T-A | 🟦 TODO | P1 | workflow | Short child | gpt-5.4 | 2026-05-05 | strict | First. |',
            '| T-LONG-CHILD | 🟦 TODO | P1 | workflow | Long child | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-540', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-A"'));
    });

    it('preserves range prefix casing for numeric child task IDs', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-550 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-Case-1` through `T-Case-3`; continue through the range. |',
            '| T-Case-1 | 🟩 DONE | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-Case-2 | 🟦 TODO | P1 | workflow | Second | gpt-5.4 | 2026-05-05 | strict | Next. |',
            '| T-Case-3 | 🟦 TODO | P1 | workflow | Third | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-550', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.equal(result.commands.length, 1);
        assert.ok(result.commands[0].command.includes('next-step "T-Case-2"'));
        assert.equal(result.commands[0].command.includes('T-CASE-2'), false);
    });

    it('does not pad variable-width numeric child task ranges', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-552 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-9` through `T-11`. |',
            '| T-9 | TODO | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Next. |',
            '| T-10 | TODO | P1 | workflow | Second | gpt-5.4 | 2026-05-05 | strict | Later. |',
            '| T-11 | TODO | P1 | workflow | Third | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-552', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-9"'));
        assert.equal(result.commands[0].command.includes('T-09'), false);
    });

    it('does not synthesize mixed-prefix numeric child task ranges', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-554 | 🟪 DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-001` through `T-ALT-003`. |',
            '| T-001 | DONE | P1 | workflow | First | gpt-5.4 | 2026-05-05 | strict | Complete. |',
            '| T-002 | TODO | P1 | workflow | Mixed middle | gpt-5.4 | 2026-05-05 | strict | Should not be synthesized. |',
            '| T-ALT-003 | TODO | P1 | workflow | Literal endpoint | gpt-5.4 | 2026-05-05 | strict | Endpoint. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-554', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-ALT-003"'));
        assert.equal(result.commands[0].command.includes('T-002'), false);
    });

    it('does not treat malformed status substrings as lifecycle tokens', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-560 | NOT_DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-561`. |',
            '| T-561 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-560', repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'DECOMPOSED');
        assert.notEqual(result.next_gate, 'child-task');
        assert.equal(text.includes('next-step "T-561"'), false);
    });

    it('does not treat suffixed status tokens as lifecycle tokens', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-562 | DECOMPOSED/blocked | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-563`. |',
            '| T-563 | DONE-ish | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Not canonical. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-562', repoRoot });
        const text = formatNextStepText(result);

        assert.notEqual(result.status, 'DECOMPOSED');
        assert.notEqual(result.next_gate, 'child-task');
        assert.equal(text.includes('next-step "T-563"'), false);
    });

    it('does not skip children whose status only contains DONE as a substring', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-570 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-571` through `T-572`. |',
            '| T-571 | UNDONE | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Not complete. |',
            '| T-572 | TODO | P1 | workflow | Later child | gpt-5.4 | 2026-05-05 | strict | Later. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-570', repoRoot });

        assert.equal(result.status, 'DECOMPOSED');
        assert.equal(result.next_gate, 'child-task');
        assert.ok(result.commands[0].command.includes('next-step "T-571"'));
    });

    it('fails closed when requested task ID casing differs from TASK.md', () => {
        const repoRoot = makeTempRepo();
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
            '# TASK.md',
            '',
            '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
            '|---|---|---|---|---|---|---|---|---|',
            '| T-next-1 | DECOMPOSED | P1 | workflow | Parent | gpt-5.4 | 2026-05-05 | strict | Split into child tasks `T-next-2`. |',
            '| T-next-2 | TODO | P1 | workflow | Child | gpt-5.4 | 2026-05-05 | strict | Next. |',
            ''
        ].join('\n'), 'utf8');

        const result = resolveNextStep({ taskId: 'T-NEXT-1', repoRoot });

        assert.equal(result.status, 'BLOCKED');
        assert.equal(result.next_gate, 'task-id-casing');
        assert.ok(result.commands[0].command.includes('next-step "T-next-1"'));
    });
});
