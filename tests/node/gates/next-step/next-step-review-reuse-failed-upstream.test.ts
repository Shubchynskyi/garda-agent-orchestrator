import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fx from './next-step-review-reuse-fixtures';
const {
    ALL_REVIEW_FLAGS,
    formatNextStepText,
    makeTempRepo,
    resolveNextStep,
    seedCompilePass,
    seedStartedTask,
    TASK_ID,
    writePreflight,
    writeReviewEvidence
} = fx;
void [assert];
describe('gates/next-step review reuse failed upstream routing', () => {
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
});