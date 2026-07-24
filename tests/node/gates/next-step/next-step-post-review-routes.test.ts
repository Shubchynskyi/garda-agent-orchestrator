import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveGroupedReviewFollowUpRoute,
    resolvePostReviewLifecycleDecisionRoute,
    resolvePostReviewLifecycleDecisionRouteFromState
} from '../../../../src/gates/next-step/next-step-post-review-routes';
import {
    resolveReviewFindingsTaskQueueRows
} from '../../../../src/gates/review/review-findings-disposition-evidence';
import {
    materializeReviewFindingsFollowUpTasks
} from '../../../../src/gates/review/review-findings-follow-up-tasks';
import {
    buildTaskAuditSummary
} from '../../../../src/gates/task-audit/task-audit-summary';
import {
    readTaskQueueEntries
} from '../../../../src/core/task-queue-read';
import {
    createTempRepo,
    getReviewsRoot,
    runEnterTaskMode,
    seedInitAnswers,
    seedTaskQueue,
    writePreflight,
    writeReceiptBackedReviewArtifact
} from '../../cli/commands/gate-test-helpers';

function route(nextGate: string) {
    return {
        status: 'BLOCKED' as const,
        nextGate,
        title: nextGate,
        reason: nextGate,
        commands: []
    };
}

function withTaskQueueFixture<T>(callback: (repoRoot: string) => T): T {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-findings-queue-'));
    fs.writeFileSync(path.join(repoRoot, 'TASK.md'), [
        '| ID | Status | Priority | Area | Title | Assignee | Updated | Profile | Notes |',
        '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
        '| T-DISK | TODO | P1 | test | Disk row | unassigned | 2026-07-24 | balanced | disk-note |'
    ].join('\n'), 'utf8');
    try {
        return callback(repoRoot);
    } finally {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
}

describe('next-step post-review routes', () => {
    it('stale recovery state preempts grouped follow-up and closeout lazily', () => {
        const calls: string[] = [];
        const selected = resolvePostReviewLifecycleDecisionRoute({
            resolveDownstreamDependencyRebindRoute: () => {
                calls.push('rebind');
                return null;
            },
            resolveStaleUpstreamRecoveryRoute: () => {
                calls.push('stale-upstream');
                return route('build-review-context');
            },
            resolveStaleContextRecoveryRoute: () => {
                calls.push('stale-context');
                return route('stale-context');
            },
            resolveGroupedFollowUpRoute: () => {
                calls.push('follow-up');
                return route('follow-up');
            },
            resolveCloseoutRoute: () => {
                calls.push('closeout');
                return route('closeout');
            }
        });

        assert.equal(selected?.nextGate, 'build-review-context');
        assert.deepEqual(calls, ['rebind', 'stale-upstream']);
    });

    it('falls through to closeout when no recovery or grouped follow-up applies', () => {
        const selected = resolvePostReviewLifecycleDecisionRoute({
            resolveDownstreamDependencyRebindRoute: () => null,
            resolveStaleUpstreamRecoveryRoute: () => null,
            resolveStaleContextRecoveryRoute: () => null,
            resolveGroupedFollowUpRoute: () => null,
            resolveCloseoutRoute: () => route('required-reviews-check')
        });

        assert.equal(selected?.nextGate, 'required-reviews-check');
    });

    it('builds grouped follow-up only after every required lane is satisfied', () => {
        const updateCommand = {
            label: 'Update grouped review follow-up task',
            command: 'node bin/garda.js gate materialize-review-follow-up-tasks'
        };
        const blocked = resolveGroupedReviewFollowUpRoute({
            allRequiredReviewLanesSatisfied: false,
            reviewType: 'code',
            groupedByParent: true,
            stateReady: true,
            dispositionReady: true,
            followUpCount: 2,
            followUpSatisfied: false,
            updateCommand
        });
        const ready = resolveGroupedReviewFollowUpRoute({
            allRequiredReviewLanesSatisfied: true,
            reviewType: 'code',
            groupedByParent: true,
            stateReady: true,
            dispositionReady: true,
            followUpCount: 2,
            followUpSatisfied: false,
            updateCommand
        });

        assert.equal(blocked, null);
        assert.equal(ready?.nextGate, 'materialize-review-follow-up-tasks');
        assert.equal(ready?.commands[0], updateCommand);
    });

    it('missing grouped follow-up prerequisites fail closed without a route', () => {
        const base = {
            allRequiredReviewLanesSatisfied: true,
            reviewType: 'test',
            groupedByParent: true,
            stateReady: true,
            dispositionReady: true,
            followUpCount: 1,
            followUpSatisfied: false,
            updateCommand: { label: 'update', command: 'update' }
        };

        assert.equal(resolveGroupedReviewFollowUpRoute({ ...base, groupedByParent: false }), null);
        assert.equal(resolveGroupedReviewFollowUpRoute({ ...base, followUpCount: 0 }), null);
        assert.equal(resolveGroupedReviewFollowUpRoute({ ...base, followUpSatisfied: true }), null);
    });

    it('builds the required-review closeout route from lifecycle state', () => {
        withTaskQueueFixture((repoRoot) => {
            const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
            const selected = resolvePostReviewLifecycleDecisionRouteFromState({
                repoRoot,
                eventsRoot: path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events'),
                reviewsRoot,
                taskId: 'T-STATEFUL',
                cliPrefix: 'node bin/garda.js',
                preflight: null,
                preflightPath: path.join(reviewsRoot, 'T-STATEFUL-preflight.json'),
                preflightCommandPath: 'garda-agent-orchestrator/runtime/reviews/T-STATEFUL-preflight.json',
                preflightSha256: null,
                taskMode: null,
                taskModePath: null,
                reviewGateAlreadyPassed: false,
                requiredReviewTypes: [],
                requiredReviews: {},
                reviewPolicyMode: 'strict_sequential',
                reviewStates: [],
                closeoutState: {
                    requiredReviewsGatePassed: false,
                    zeroDiffNoReviewCloseout: false,
                    docImpactGatePassed: false,
                    docImpactCompatibilityHint: 'compatibility',
                    docImpactCommand: 'doc-impact',
                    fullSuiteEnabled: false,
                    fullSuiteGatePassed: false,
                    fullSuiteNotRequiredForDocsOnly: false,
                    fullSuitePlacement: 'after_compile_before_reviews',
                    fullSuiteConfigPath: 'workflow-config.json',
                    fullSuiteCommandText: 'npm test',
                    fullSuiteTimeoutForecastLine: null,
                    fullSuiteCommand: 'full-suite',
                    projectMemoryRequired: false,
                    projectMemoryEvidenceCurrent: false,
                    projectMemoryVisibleSummaryLine: 'disabled',
                    projectMemoryAffectedMemoryFiles: [],
                    projectMemoryViolations: [],
                    projectMemoryCommand: 'project-memory',
                    completionGatePassed: false,
                    completionCommand: 'completion'
                }
            });

            assert.equal(selected.nextGate, 'required-reviews-check');
            assert.equal(selected.commands.length, 1);
            assert.match(selected.commands[0]?.command || '', /required-reviews-check/u);
            assert.match(selected.commands[0]?.command || '', /--task-id "T-STATEFUL"/u);
            assert.match(
                selected.commands[0]?.command || '',
                /--preflight-path "garda-agent-orchestrator\/runtime\/reviews\/T-STATEFUL-preflight\.json"/u
            );
            assert.doesNotMatch(selected.commands[0]?.command || '', /review-authorship-attestation/u);
        });
    });
});

describe('review findings task queue source selection', () => {
    it('supplied canonical snapshot wins over divergent TASK.md rows', () => {
        withTaskQueueFixture((repoRoot) => {
            const rows = resolveReviewFindingsTaskQueueRows({
                repoRoot,
                taskQueueRows: [{ taskId: 'T-SNAPSHOT', notes: 'snapshot-note' }]
            });

            assert.deepEqual(rows, [{ taskId: 'T-SNAPSHOT', notes: 'snapshot-note' }]);
        });
    });

    it('empty supplied canonical snapshot remains authoritative', () => {
        withTaskQueueFixture((repoRoot) => {
            const rows = resolveReviewFindingsTaskQueueRows({
                repoRoot,
                taskQueueRows: []
            });

            assert.deepEqual(rows, []);
        });
    });

    it('missing canonical snapshot falls back to TASK.md', () => {
        withTaskQueueFixture((repoRoot) => {
            const rows = resolveReviewFindingsTaskQueueRows({ repoRoot });

            assert.equal(rows.length, 1);
            assert.equal(rows[0]?.taskId, 'T-DISK');
            assert.equal(rows[0]?.notes, 'disk-note');
        });
    });

    it('task audit preserves its point-in-time queue snapshot through findings validation', () => {
        const taskId = 'T-AUDIT-SNAPSHOT';
        const repoRoot = createTempRepo();
        try {
            seedTaskQueue(repoRoot, taskId, 'IN_PROGRESS');
            seedInitAnswers(repoRoot, 'Codex');
            runEnterTaskMode({
                repoRoot,
                taskId,
                taskSummary: 'Verify canonical queue snapshot propagation.',
                provider: 'Codex',
                routedTo: 'AGENTS.md'
            });
            writePreflight(repoRoot, taskId, {
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
                'REVIEW PASSED',
                undefined,
                { findingSeverity: 'low' }
            );
            const taskQueueSnapshot = readTaskQueueEntries(repoRoot);
            const materialized = materializeReviewFindingsFollowUpTasks({
                repoRoot,
                taskId,
                reviewType: 'code'
            });
            assert.equal(materialized.status, 'MATERIALIZED');
            assert.ok(materialized.created_task_ids[0]);

            const diskSummary = buildTaskAuditSummary({
                taskId,
                repoRoot,
                reviewsRoot: getReviewsRoot(repoRoot)
            });
            const snapshotSummary = buildTaskAuditSummary({
                taskId,
                repoRoot,
                reviewsRoot: getReviewsRoot(repoRoot),
                taskQueueEntries: taskQueueSnapshot
            });

            assert.equal(diskSummary.review_findings_audit?.status, 'CLEAR');
            assert.equal(snapshotSummary.review_findings_audit?.status, 'BLOCKED');
            assert.equal(
                snapshotSummary.review_findings_audit?.lanes[0].findings[0].follow_up_task_id,
                null
            );
        } finally {
            fs.rmSync(repoRoot, { recursive: true, force: true });
        }
    });
});
