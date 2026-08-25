import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { appendTaskEvent } from '../../../../src/gate-runtime/task-events';
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
});
