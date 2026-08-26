import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
import { formatReviewFollowUpTaskClosurePolicyMetadata } from '../../../../src/core/review-follow-up-task-closure-policy';
import {
    buildTaskAuditSummary,
    formatFinalCloseoutMarkdown,
    formatFinalUserReport,
    formatTaskAuditSummaryText
} from '../../../../src/gates/task-audit/task-audit-summary';
import { buildReviewFindingsAuditSummary } from '../../../../src/gates/task-audit/task-audit-summary-review-findings';
import { materializeReviewFindingsFollowUpTasks } from '../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    createTempRepo,
    getOrchestratorRoot,
    getReviewsRoot,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue,
    writeBalancedProfilesConfig,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from '../../cli/commands/gate-test-helpers';

function readJson(filePath: string): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(filePath, 'utf8')) as Record<string, unknown>;
}

function readEvents(repoRoot: string, taskId: string): Record<string, unknown>[] {
    const eventPath = path.join(getOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
    if (!fs.existsSync(eventPath)) {
        return [];
    }
    return fs.readFileSync(eventPath, 'utf8')
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function seedFindingsReview(
    taskId: string,
    findingSeverity: 'high' | 'low' | null,
    residualRisk = false
): { repoRoot: string; reviewsRoot: string; preflight: Record<string, unknown> } {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId, 'IN_PROGRESS');
    seedInitAnswers(repoRoot, 'Codex');
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: 'Report structured review findings in task audit.',
        provider: 'Codex',
        routedTo: 'AGENTS.md'
    });
    const preflightPath = writePreflight(repoRoot, taskId, {
        scope_category: 'code',
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
        profile_selection: {
            task_profile: 'balanced',
            effective_profile: 'balanced'
        }
    });
    writeReceiptBackedReviewArtifact(
        repoRoot,
        taskId,
        'code',
        findingSeverity ? 'REVIEW FAILED' : 'REVIEW PASSED',
        undefined,
        { findingSeverity, residualRisk }
    );
    return {
        repoRoot,
        reviewsRoot: getReviewsRoot(repoRoot),
        preflight: readJson(preflightPath)
    };
}

function seedFollowUpClosurePolicyReview(
    taskId: string,
    closurePolicy: { skip_low_findings: boolean; forbid_child_tasks: boolean }
): { repoRoot: string; reviewsRoot: string; preflight: Record<string, unknown> } {
    const repoRoot = createTempRepo();
    seedTaskQueue(repoRoot, taskId, 'IN_PROGRESS');
    const taskPath = path.join(repoRoot, 'TASK.md');
    const parentTaskId = taskId.replace(/-F[1-9][0-9]*$/u, '');
    const taskNotes = [
        `Child of \`${parentTaskId}\`.`,
        `review_follow_up_fingerprint=${'f'.repeat(64)}.`,
        formatReviewFollowUpTaskClosurePolicyMetadata(closurePolicy)
    ].join(' ');
    const taskContent = fs.readFileSync(taskPath, 'utf8');
    const taskRow = taskContent.split(/\r?\n/u).find((line) => line.includes(`| ${taskId} |`));
    assert.ok(taskRow);
    const parentNotes = `Review follow-up tasks materialized: \`${taskId}\`; artifact `
        + `\`garda-agent-orchestrator/runtime/reviews/${parentTaskId}-review-findings-follow-up-tasks.json\`.`;
    const parentRow = `| ${parentTaskId} | IN_PROGRESS | P1 | core | Parent task | unassigned | 2026-03-28 | default | ${parentNotes} |`;
    const rewrittenTaskRow = taskRow
        .replace('| fixture |', `| ${taskNotes} |`);
    fs.writeFileSync(
        taskPath,
        taskContent.replace(taskRow, `${parentRow}\n${rewrittenTaskRow}`),
        'utf8'
    );
    seedInitAnswers(repoRoot, 'Codex');
    writeBalancedProfilesConfig(repoRoot);
    runEnterTaskMode({
        repoRoot,
        taskId,
        taskSummary: 'Audit F-task closure policy finding disposition.',
        provider: 'Codex',
        routedTo: 'AGENTS.md'
    });
    const taskMode = readJson(path.join(getReviewsRoot(repoRoot), `${taskId}-task-mode.json`));
    const preflightPath = writePreflight(repoRoot, taskId, {
        scope_category: 'code',
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
        profile_selection: {
            task_profile: 'balanced',
            effective_profile: 'balanced'
        },
        profile_policy_snapshot: taskMode.profile_policy_snapshot
    });
    writeReceiptBackedReviewArtifact(
        repoRoot,
        taskId,
        'code',
        'REVIEW FAILED',
        undefined,
        { findingSeverity: 'low' }
    );
    return {
        repoRoot,
        reviewsRoot: getReviewsRoot(repoRoot),
        preflight: readJson(preflightPath)
    };
}

describe('gates/task-audit-summary structured review findings', () => {
    const tempRoots: string[] = [];

    afterEach(() => {
        for (const tempRoot of tempRoots.splice(0)) {
            fs.rmSync(tempRoot, { recursive: true, force: true });
        }
    });

    it('reports fix-now evidence, rejected validation history, remediation cycles, and every report surface', () => {
        const taskId = 'T-AUDIT-FINDINGS-BLOCKED';
        const fixture = seedFindingsReview(taskId, 'high');
        tempRoots.push(fixture.repoRoot);
        appendTaskEvent(
            getOrchestratorRoot(fixture.repoRoot),
            taskId,
            'REVIEWER_LAUNCH_FAILED',
            'FAIL',
            'Structured findings validation rejected.',
            {
                review_type: 'code',
                reviewer_identity: 'agent:rejected-reviewer',
                launch_failure_stage: 'review_findings_validation',
                launch_failure_reason: 'Coverage obligation FILE-001 has no authenticated evidence.',
                review_findings_validation_artifact_sha256: 'a'.repeat(64)
            }
        );
        appendTaskEvent(
            getOrchestratorRoot(fixture.repoRoot),
            taskId,
            'REVIEW_CYCLE_RESTARTED',
            'PASS',
            'Review cycle restarted.',
            {
                restart_reason: 'failed_review_remediation_cycle',
                invalidated_review_types: ['code'],
                preserved_review_types: ['test'],
                launch_required_review_types: ['code'],
                reused_review_types: ['test']
            }
        );

        const result = buildTaskAuditSummary({
            taskId,
            repoRoot: fixture.repoRoot,
            reviewsRoot: fixture.reviewsRoot
        });
        const findingsAudit = result.review_findings_audit;

        assert.equal(findingsAudit?.status, 'BLOCKED');
        assert.equal(findingsAudit?.finding_count, 1);
        assert.equal(findingsAudit?.disposition_counts.fix_now, 1);
        assert.deepEqual(findingsAudit?.lanes[0].remaining_blocker_ids, ['F-001']);
        assert.deepEqual(findingsAudit?.lanes[0].findings[0].evidence_locations, ['src/app.ts:1']);
        assert.equal(findingsAudit?.lanes[0].findings[0].action, 'fix_now');
        assert.equal(findingsAudit?.validation_failures[0].violation, 'Coverage obligation FILE-001 has no authenticated evidence.');
        assert.deepEqual(findingsAudit?.remediation_cycles[0].reused_review_types, ['test']);
        assert.equal(findingsAudit?.fresh_review_count, 1);

        for (const rendered of [
            formatTaskAuditSummaryText(result),
            formatFinalCloseoutMarkdown(result.final_closeout)
        ]) {
            assert.match(rendered, /Review findings audit:/u);
            assert.match(rendered, /code\/F-001/u);
            assert.match(rendered, /Fixture active finding/u);
            assert.match(rendered, /src\/app\.ts:1/u);
            assert.match(rendered, /Coverage obligation FILE-001 has no authenticated evidence\./u);
        }
        const finalUserReport = formatFinalUserReport(result.final_closeout);
        assert.match(finalUserReport, /Unresolved blockers:\ncode\/F-001/u);
        assert.doesNotMatch(finalUserReport, /Review findings audit:/u);
        assert.doesNotMatch(finalUserReport, /Fixture active finding/u);
        assert.doesNotMatch(finalUserReport, /src\/app\.ts:1/u);
    });

    it('reports a materialized follow-up task as satisfied without a remaining blocker', () => {
        const taskId = 'T-AUDIT-FINDINGS-FOLLOW-UP';
        const fixture = seedFindingsReview(taskId, 'low');
        tempRoots.push(fixture.repoRoot);
        const before = buildReviewFindingsAuditSummary({
            repoRoot: fixture.repoRoot,
            reviewsRoot: fixture.reviewsRoot,
            taskId,
            requiredReviews: { code: true },
            currentPreflight: fixture.preflight,
            timelineEvents: readEvents(fixture.repoRoot, taskId) as never[],
            reviewAttemptSummary: null
        });
        assert.equal(before?.status, 'BLOCKED');
        assert.deepEqual(before?.lanes[0].remaining_blocker_ids, ['F-001']);

        const materialized = materializeReviewFindingsFollowUpTasks({
            repoRoot: fixture.repoRoot,
            taskId,
            reviewType: 'code'
        });
        assert.equal(materialized.status, 'MATERIALIZED');

        const after = buildReviewFindingsAuditSummary({
            repoRoot: fixture.repoRoot,
            reviewsRoot: fixture.reviewsRoot,
            taskId,
            requiredReviews: { code: true },
            currentPreflight: fixture.preflight,
            timelineEvents: readEvents(fixture.repoRoot, taskId) as never[],
            reviewAttemptSummary: null
        });
        assert.equal(after?.status, 'CLEAR');
        assert.equal(after?.remaining_blocker_count, 0);
        assert.deepEqual(after?.lanes[0].remaining_blocker_ids, []);
        assert.equal(after?.lanes[0].findings[0].action, 'create_follow_up');
        assert.equal(after?.lanes[0].findings[0].follow_up_task_id, materialized.created_task_ids[0]);
    });

    it('renders residual risks through task audit, closeout, and the final user report', () => {
        const taskId = 'T-AUDIT-RESIDUAL-RISK';
        const fixture = seedFindingsReview(taskId, null, true);
        tempRoots.push(fixture.repoRoot);

        const result = buildTaskAuditSummary({
            taskId,
            repoRoot: fixture.repoRoot,
            reviewsRoot: fixture.reviewsRoot
        });
        const residualRisk = result.review_findings_audit?.lanes[0].findings[0];

        assert.equal(result.review_findings_audit?.residual_risk_count, 1);
        assert.equal(residualRisk?.id, 'R-001');
        assert.equal(residualRisk?.kind, 'residual_risk');
        assert.equal(residualRisk?.severity, 'residual_risk');
        for (const rendered of [
            formatTaskAuditSummaryText(result),
            formatFinalCloseoutMarkdown(result.final_closeout)
        ]) {
            assert.match(rendered, /code\/R-001/u);
            assert.match(rendered, /Seeded residual-risk fixture/u);
            assert.match(rendered, /src\/app\.ts:1/u);
        }
        const finalUserReport = formatFinalUserReport(result.final_closeout);
        assert.match(finalUserReport, /Residual risks:\ncode\/R-001: Seeded residual-risk fixture/u);
        assert.doesNotMatch(finalUserReport, /src\/app\.ts:1/u);
    });

    it('reports ignored low findings and prohibited descendants from the frozen F-task closure policy', () => {
        const ignoredTaskId = 'T-AUDIT-CLOSURE-IGNORE-F1';
        const ignoredFixture = seedFollowUpClosurePolicyReview(ignoredTaskId, {
            skip_low_findings: true,
            forbid_child_tasks: false
        });
        tempRoots.push(ignoredFixture.repoRoot);
        const ignoredResult = buildTaskAuditSummary({
            taskId: ignoredTaskId,
            repoRoot: ignoredFixture.repoRoot,
            reviewsRoot: ignoredFixture.reviewsRoot
        });
        const ignoredAudit = ignoredResult.review_findings_audit;

        assert.equal(ignoredAudit?.status, 'CLEAR');
        assert.equal(ignoredAudit?.lanes[0].findings[0].action, 'ignore');
        assert.equal(
            ignoredAudit?.lanes[0].findings[0].source_rule,
            'review_follow_up_task_closure_policy.skip_low_findings'
        );
        assert.equal(ignoredAudit?.review_follow_up_task_closure_policy?.source, 'preflight_profile_policy_snapshot');
        assert.equal(ignoredAudit?.review_follow_up_task_closure_policy?.ignored_low_findings_count, 1);
        assert.equal(ignoredAudit?.review_follow_up_task_closure_policy?.retained_current_task_count, 0);
        assert.match(formatTaskAuditSummaryText(ignoredResult), /ignored_low=1/u);
        assert.match(formatFinalUserReport(ignoredResult.final_closeout), /ignored by F-task skip-low policy/u);

        const retainedTaskId = 'T-AUDIT-CLOSURE-RETAIN-F1';
        const retainedFixture = seedFollowUpClosurePolicyReview(retainedTaskId, {
            skip_low_findings: false,
            forbid_child_tasks: true
        });
        tempRoots.push(retainedFixture.repoRoot);
        const retainedResult = buildTaskAuditSummary({
            taskId: retainedTaskId,
            repoRoot: retainedFixture.repoRoot,
            reviewsRoot: retainedFixture.reviewsRoot
        });
        const retainedAudit = retainedResult.review_findings_audit;

        assert.equal(retainedAudit?.status, 'BLOCKED');
        assert.equal(retainedAudit?.lanes[0].findings[0].action, 'fix_now');
        assert.equal(
            retainedAudit?.lanes[0].findings[0].source_rule,
            'review_follow_up_task_closure_policy.forbid_child_tasks'
        );
        assert.equal(retainedAudit?.review_follow_up_task_closure_policy?.retained_current_task_count, 1);
        assert.equal(retainedAudit?.review_follow_up_task_closure_policy?.prohibited_descendant_creation_count, 1);
        assert.equal(retainedAudit?.review_follow_up_task_closure_policy?.remaining_blocker_count, 1);
        assert.match(formatTaskAuditSummaryText(retainedResult), /prohibited_descendants=1/u);
        assert.match(
            formatFinalUserReport(retainedResult.final_closeout),
            /retained in the current F task; descendant creation prohibited/u
        );
    });
});
