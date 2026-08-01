import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildTaskAuditSummary,
    formatFinalCloseoutMarkdown,
    formatTaskAuditSummaryText
} from '../../../../src/gates/task-audit/task-audit-summary';
import { readTaskQueueEntries } from '../../../../src/core/task-queue-read';
import {
    initGitRepo,
    makeTempDir,
    writeEvent,
    writePassedLifecycle,
    writePreflight,
    writeWorkflowConfig
} from './task-audit-summary-fixtures';

const TASK_ID = 'T-AUDIT-DEFECT-CAPTURE';
const FOLLOW_UP_TASK_ID = 'T-990';
const PROBLEM_RECORD_ID = 'T-DEFECT-1';

function buildTaskFile(problemRecord: string | null = null, includeFollowUp = true): string {
    return [
        '<!-- garda-agent-orchestrator:managed-start -->',
        '# TASK.md',
        '',
        '## Active Queue',
        '| ID | Status | Priority | Area | Title | Owner | Updated | Profile | Notes |',
        '|---|---|---|---|---|---|---|---|---|',
        `| ${TASK_ID} | IN_PROGRESS | P1 | workflow/audit | Audit defects | Codex | 2026-08-01 | balanced | Fixture. |`,
        ...(includeFollowUp
            ? [`| ${FOLLOW_UP_TASK_ID} | TODO | P1 | workflow/follow-up | Fix defect | Codex | 2026-08-01 | balanced | Follow-up. |`]
            : []),
        '<!-- garda-agent-orchestrator:managed-end -->',
        '',
        '### Найденные проблемы оркестратора',
        '',
        ...(problemRecord ? [problemRecord] : []),
        ''
    ].join('\n');
}

describe('task-audit-summary orchestrator defect capture', () => {
    let repoRoot: string;
    let eventsDir: string;
    let reviewsDir: string;

    beforeEach(() => {
        repoRoot = makeTempDir();
        eventsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
        reviewsDir = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(eventsDir, { recursive: true });
        fs.mkdirSync(reviewsDir, { recursive: true });
        writeWorkflowConfig(repoRoot, false);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), buildTaskFile(), 'utf8');
        initGitRepo(repoRoot);
        writePassedLifecycle(eventsDir, TASK_ID);
        writePreflight(reviewsDir, TASK_ID, {
            mode: 'FAST_PATH',
            scope_category: 'docs-only',
            changed_files: [],
            metrics: { changed_lines_total: 0 },
            required_reviews: {}
        });
    });

    afterEach(() => {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    });

    function acknowledge(details: Record<string, unknown>): void {
        writeEvent(eventsDir, TASK_ID, {
            timestamp_utc: '2026-08-01T01:00:00.000Z',
            task_id: TASK_ID,
            event_type: 'ORCHESTRATOR_DEFECT_ACKNOWLEDGED',
            outcome: 'INFO',
            actor: 'orchestrator',
            message: 'Orchestrator defect acknowledged.',
            details
        });
    }

    it('keeps historical timelines without a declaration read-only compatible', () => {
        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });

        assert.equal(result.final_closeout.orchestrator_defect_capture?.status, 'NOT_DECLARED');
        assert.equal(result.final_closeout.orchestrator_defect_capture?.encountered, null);
        assert.equal(result.blockers.some((blocker) => blocker.gate === 'orchestrator-defect-capture'), false);
        assert.match(formatTaskAuditSummaryText(result), /Orchestrator defect capture: status=NOT_DECLARED/);
    });

    it('exposes a captured defect with its canonical problem record and follow-up task', () => {
        fs.writeFileSync(
            path.join(repoRoot, 'TASK.md'),
            buildTaskFile(`- \`${PROBLEM_RECORD_ID}\` — reproduced during audit; follow-up task \`${FOLLOW_UP_TASK_ID}\`.`),
            'utf8'
        );
        acknowledge({
            defect_id: 'OD-1',
            summary: 'Navigator skipped the implementation lane.',
            resolution: 'deferred_to_follow_up',
            problem_record_id: PROBLEM_RECORD_ID,
            follow_up_task_id: FOLLOW_UP_TASK_ID
        });

        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        const capture = result.final_closeout.orchestrator_defect_capture;

        assert.equal(capture?.status, 'CAPTURED');
        assert.equal(capture?.encountered, true);
        assert.equal(capture?.records[0].problem_record_found, true);
        assert.equal(capture?.records[0].follow_up_task_found, true);
        assert.equal(result.blockers.some((blocker) => blocker.gate === 'orchestrator-defect-capture'), false);
        assert.match(formatFinalCloseoutMarkdown(result.final_closeout), /problem_record=T-DEFECT-1; follow_up=T-990/);
    });

    it('uses the latest acknowledgement to recover an earlier invalid defect record', () => {
        fs.writeFileSync(
            path.join(repoRoot, 'TASK.md'),
            buildTaskFile(`- \`${PROBLEM_RECORD_ID}\` — corrected by follow-up task \`${FOLLOW_UP_TASK_ID}\`.`),
            'utf8'
        );
        acknowledge({
            defect_id: 'OD-RECOVERY',
            summary: 'The first acknowledgement omitted durable references.',
            resolution: 'deferred_to_follow_up'
        });
        acknowledge({
            defect_id: 'OD-RECOVERY',
            summary: 'The acknowledgement was corrected with durable references.',
            resolution: 'deferred_to_follow_up',
            problem_record_id: PROBLEM_RECORD_ID,
            follow_up_task_id: FOLLOW_UP_TASK_ID
        });

        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        const capture = result.final_closeout.orchestrator_defect_capture;

        assert.equal(capture?.status, 'CAPTURED');
        assert.equal(capture?.acknowledged_count, 1);
        assert.equal(capture?.captured_count, 1);
        assert.equal(capture?.records[0].summary, 'The acknowledgement was corrected with durable references.');
        assert.deepEqual(capture?.violations, []);
        assert.equal(result.blockers.some((blocker) => blocker.gate === 'orchestrator-defect-capture'), false);
    });

    it('blocks missing durable capture references for an acknowledged in-task fix', () => {
        acknowledge({
            defect_id: 'OD-2',
            summary: 'The defect was fixed while executing another task.',
            resolution: 'fixed_in_current_task'
        });

        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        const blocker = result.blockers.find((entry) => entry.gate === 'orchestrator-defect-capture');

        assert.equal(result.final_closeout.orchestrator_defect_capture?.status, 'INVALID');
        assert.ok(blocker);
        assert.match(blocker.reason, /no valid problem_record_id/);
        assert.match(blocker.reason, /no valid follow_up_task_id/);
    });

    it('blocks a reference whose follow-up row and linked problem record are absent', () => {
        acknowledge({
            defect_id: 'OD-3',
            summary: 'The defect needs a follow-up.',
            resolution: 'deferred_to_follow_up',
            problem_record_id: 'T-DEFECT-3',
            follow_up_task_id: 'T-991'
        });

        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        const violations = result.final_closeout.orchestrator_defect_capture?.violations || [];

        assert.ok(violations.some((violation) => /follow-up task 'T-991'.*is missing from TASK\.md/u.test(violation)));
        assert.ok(violations.some((violation) => /no linked record.*canonical TASK\.md/u.test(violation)));
    });

    it('blocks a self-referential follow-up task even when its row and problem link exist', () => {
        fs.writeFileSync(
            path.join(repoRoot, 'TASK.md'),
            buildTaskFile(`- \`${PROBLEM_RECORD_ID}\` — incorrectly points back to \`${TASK_ID}\`.`),
            'utf8'
        );
        acknowledge({
            defect_id: 'OD-4',
            summary: 'The defect needs a distinct follow-up task.',
            resolution: 'deferred_to_follow_up',
            problem_record_id: PROBLEM_RECORD_ID,
            follow_up_task_id: TASK_ID
        });

        const result = buildTaskAuditSummary({ taskId: TASK_ID, repoRoot });
        const capture = result.final_closeout.orchestrator_defect_capture;

        assert.equal(capture?.status, 'INVALID');
        assert.equal(capture?.records[0].follow_up_task_found, false);
        assert.ok(capture?.violations.some((violation) => /must be distinct from the current task/u.test(violation)));
        assert.equal(result.blockers.some((blocker) => blocker.gate === 'orchestrator-defect-capture'), true);
    });

    it('ignores stale injected queue data when the canonical follow-up row was removed', () => {
        const problemRecord = `- \`${PROBLEM_RECORD_ID}\` — still mentions follow-up \`${FOLLOW_UP_TASK_ID}\`.`;
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), buildTaskFile(problemRecord), 'utf8');
        const staleTaskQueueEntries = readTaskQueueEntries(repoRoot);
        fs.writeFileSync(path.join(repoRoot, 'TASK.md'), buildTaskFile(problemRecord, false), 'utf8');
        acknowledge({
            defect_id: 'OD-5',
            summary: 'The follow-up row was removed after an earlier queue read.',
            resolution: 'deferred_to_follow_up',
            problem_record_id: PROBLEM_RECORD_ID,
            follow_up_task_id: FOLLOW_UP_TASK_ID
        });

        const result = buildTaskAuditSummary({
            taskId: TASK_ID,
            repoRoot,
            taskQueueEntries: staleTaskQueueEntries
        });
        const capture = result.final_closeout.orchestrator_defect_capture;

        assert.equal(capture?.status, 'INVALID');
        assert.equal(capture?.records[0].follow_up_task_found, false);
        assert.ok(capture?.violations.some((violation) => /is missing from TASK\.md/u.test(violation)));
    });
});
