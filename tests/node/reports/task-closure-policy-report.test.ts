import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    formatReviewFollowUpTaskClosurePolicyMetadata,
    replaceReviewFollowUpTaskClosurePolicyMetadata,
    type ReviewFollowUpTaskClosurePolicyTaskContext
} from '../../../src/core/review-follow-up-task-closure-policy';
import { buildReportTaskDetail } from '../../../src/reports/report-data-contract';
import {
    createTempRepo,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue,
    writeBalancedProfilesConfig
} from '../cli/commands/gate-test-helpers';

const TASK_ID = 'T-REPORT-F1';
const PARENT_TASK_ID = 'T-REPORT';
const FINGERPRINT = 'b'.repeat(64);
const PARENT_NOTES = `Review follow-up tasks materialized: \`${TASK_ID}\`; artifact `
    + `\`garda-agent-orchestrator/runtime/reviews/${PARENT_TASK_ID}-review-findings-follow-up-tasks.json\`.`;

function reviewFollowUpNotes(skipLowFindings: boolean, forbidChildTasks: boolean): string {
    return [
        'Child of `T-REPORT`.',
        `review_follow_up_fingerprint=${FINGERPRINT}.`,
        formatReviewFollowUpTaskClosurePolicyMetadata({
            skip_low_findings: skipLowFindings,
            forbid_child_tasks: forbidChildTasks
        })
    ].join(' ');
}

function rewriteTaskNotes(repoRoot: string, notes: string): void {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const content = fs.readFileSync(taskPath, 'utf8');
    const taskRow = content.split(/\r?\n/u).find((line) => line.includes(`| ${TASK_ID} |`));
    assert.ok(taskRow);
    const rewrittenTaskRow = taskRow
        .replace('| fixture |', `| ${notes} |`);
    const parentRow = `| ${PARENT_TASK_ID} | IN_PROGRESS | P1 | core | Parent task | unassigned | 2026-03-28 | default | ${PARENT_NOTES} |`;
    fs.writeFileSync(taskPath, content.replace(taskRow, `${parentRow}\n${rewrittenTaskRow}`), 'utf8');
}

function policyContext(notes: string): ReviewFollowUpTaskClosurePolicyTaskContext {
    return {
        taskId: TASK_ID,
        taskRows: [
            { taskId: PARENT_TASK_ID, notes: PARENT_NOTES },
            { taskId: TASK_ID, notes }
        ]
    };
}

test('task detail distinguishes ordinary, invalid, eligible, and completed closure controls', () => {
    const fixtures = [
        {
            status: 'IN_PROGRESS',
            notes: 'ordinary notes',
            state: 'inapplicable',
            editable: false
        },
        {
            status: 'IN_PROGRESS',
            notes: `review_follow_up_fingerprint=${FINGERPRINT}. `
                + 'review_follow_up_task_closure_policy=`{"schema_version":1,"skip_low_findings":"yes","forbid_child_tasks":true}`.',
            state: 'invalid',
            editable: false
        },
        {
            status: 'IN_PROGRESS',
            notes: reviewFollowUpNotes(true, false),
            state: 'editable',
            editable: true
        },
        {
            status: 'DONE',
            notes: reviewFollowUpNotes(false, true),
            state: 'completed',
            editable: false
        }
    ] as const;

    for (const fixture of fixtures) {
        const repoRoot = createTempRepo();
        try {
            seedTaskQueue(repoRoot, TASK_ID, fixture.status);
            rewriteTaskNotes(repoRoot, fixture.notes);
            const detail = buildReportTaskDetail({ repoRoot, taskId: TASK_ID });
            const policy = detail.review_follow_up_task_closure_policy;

            assert.equal(policy.state, fixture.state);
            assert.equal(policy.editable, fixture.editable);
            assert.equal(policy.effective_source, 'task_metadata');
            if (fixture.state === 'editable') {
                assert.equal(policy.stored.skip_low_findings, true);
                assert.equal(policy.stored.forbid_child_tasks, false);
            }
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    }
});

test('task detail keeps the current cycle frozen while reporting stored policy drift for the next cycle', () => {
    const repoRoot = createTempRepo();
    try {
        seedTaskQueue(repoRoot, TASK_ID, 'IN_PROGRESS');
        seedInitAnswers(repoRoot, 'Codex');
        writeBalancedProfilesConfig(repoRoot);
        rewriteTaskNotes(repoRoot, reviewFollowUpNotes(false, false));
        runEnterTaskMode({
            repoRoot,
            taskId: TASK_ID,
            taskSummary: 'Report frozen F-task closure policy diagnostics.',
            provider: 'Codex',
            routedTo: 'AGENTS.md'
        });

        const taskPath = path.join(repoRoot, 'TASK.md');
        const taskContent = fs.readFileSync(taskPath, 'utf8');
        const currentNotes = taskContent.split(/\r?\n/u)
            .find((line) => line.includes(`| ${TASK_ID} |`))
            ?.split('|')[9]
            ?.trim() || '';
        const notesWithUnrelatedChange = `${currentNotes} unrelated_note=changed.`;
        fs.writeFileSync(
            taskPath,
            taskContent.replace(currentNotes, notesWithUnrelatedChange),
            'utf8'
        );
        const unrelatedChangePolicy = buildReportTaskDetail({ repoRoot, taskId: TASK_ID })
            .review_follow_up_task_closure_policy;
        assert.equal(unrelatedChangePolicy.state, 'editable');
        assert.equal(unrelatedChangePolicy.drift_detected, false);

        const contentWithUnrelatedChange = fs.readFileSync(taskPath, 'utf8');
        fs.writeFileSync(
            taskPath,
            contentWithUnrelatedChange.replace(
                notesWithUnrelatedChange,
                replaceReviewFollowUpTaskClosurePolicyMetadata(
                    notesWithUnrelatedChange,
                    {
                        skip_low_findings: true,
                        forbid_child_tasks: true
                    },
                    policyContext(notesWithUnrelatedChange)
                )
            ),
            'utf8'
        );

        const policy = buildReportTaskDetail({ repoRoot, taskId: TASK_ID })
            .review_follow_up_task_closure_policy;
        assert.equal(policy.state, 'pending_next_cycle');
        assert.equal(policy.editable, true);
        assert.equal(policy.drift_detected, true);
        assert.equal(policy.effective_source, 'task_mode_profile_policy_snapshot');
        assert.equal(policy.stored.skip_low_findings, true);
        assert.equal(policy.stored.forbid_child_tasks, true);
        assert.equal(policy.effective.skip_low_findings, false);
        assert.equal(policy.effective.forbid_child_tasks, false);
        assert.ok(policy.diagnostics.some((message) => /apply on the next task-mode entry/iu.test(message)));

        const taskModePath = path.join(
            repoRoot,
            'garda-agent-orchestrator',
            'runtime',
            'reviews',
            `${TASK_ID}-task-mode.json`
        );
        const taskMode = JSON.parse(fs.readFileSync(taskModePath, 'utf8')) as Record<string, unknown>;
        taskMode.status = 'FAILED';
        fs.writeFileSync(taskModePath, JSON.stringify(taskMode, null, 2), 'utf8');
        const untrustedPolicy = buildReportTaskDetail({ repoRoot, taskId: TASK_ID })
            .review_follow_up_task_closure_policy;
        assert.equal(untrustedPolicy.effective_source, 'task_metadata');
        assert.equal(untrustedPolicy.state, 'editable');
        assert.equal(untrustedPolicy.drift_detected, false);
        assert.equal(untrustedPolicy.effective.skip_low_findings, true);
        assert.equal(untrustedPolicy.effective.forbid_child_tasks, true);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});
