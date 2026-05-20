import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeReviewLaunchPlan } from '../../../src/core/review-execution-policy';

const REVIEW_FLAGS = Object.freeze({
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

describe('review execution launch plan', () => {
    it('launches all pending lanes under parallel_all', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'security', 'refactor', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            policyMode: 'parallel_all',
            reviewStates: [
                { review_type: 'code', satisfied: false },
                { review_type: 'security', satisfied: false },
                { review_type: 'refactor', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['code', 'security', 'refactor', 'test']);
        assert.deepEqual(plan.blocked_review_lanes, []);
        assert.equal(plan.next_review_type, 'code');
    });

    it('keeps code_first_optional dependencies blocked without hiding independent lanes', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'security', 'api', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, security: true, api: true, test: true },
            policyMode: 'code_first_optional',
            reviewStates: [
                { review_type: 'code', satisfied: false },
                { review_type: 'security', satisfied: false },
                { review_type: 'api', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['code', 'security']);
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'api', blocked_by: ['code'] },
            { review_type: 'test', blocked_by: ['code', 'security', 'api'] }
        ]);
        assert.equal(plan.next_review_type, 'code');
    });

    it('blocks only test behind code under test_after_code', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'db', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, db: true, test: true },
            policyMode: 'test_after_code',
            reviewStates: [
                { review_type: 'code', satisfied: false },
                { review_type: 'db', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['code', 'db']);
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'test', blocked_by: ['code'] }
        ]);
        assert.equal(plan.next_review_type, 'code');
    });

    it('models strict_sequential as one launchable lane and downstream blockers', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'db', 'api', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, db: true, api: true, test: true },
            policyMode: 'strict_sequential',
            reviewStates: [
                { review_type: 'code', satisfied: true },
                { review_type: 'db', satisfied: false },
                { review_type: 'api', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['db']);
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'api', blocked_by: ['db'] },
            { review_type: 'test', blocked_by: ['db', 'api'] }
        ]);
        assert.equal(plan.next_review_type, 'db');
    });

    it('keeps legacy compatibility mode test review downstream of every required upstream review', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'db', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, db: true, test: true },
            policyMode: 'legacy_test_downstream',
            reviewStates: [
                { review_type: 'code', satisfied: false },
                { review_type: 'db', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['code', 'db']);
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'test', blocked_by: ['code', 'db'] }
        ]);
        assert.equal(plan.next_review_type, 'code');
    });

    it('prioritizes current failed-review remediation over otherwise launchable lanes', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'security', 'refactor', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            policyMode: 'code_first_optional',
            reviewStates: [
                { review_type: 'code', satisfied: false, failed_current: true },
                { review_type: 'security', satisfied: false },
                { review_type: 'refactor', satisfied: false },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, []);
        assert.equal(plan.failed_review_type, 'code');
        assert.equal(plan.next_review_type, 'code');
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'test', blocked_by: ['code', 'security', 'refactor'] }
        ]);
    });

    it('routes stale upstream lanes before blocked failed downstream review remediation', () => {
        const plan = computeReviewLaunchPlan({
            requiredReviewTypes: ['code', 'security', 'refactor', 'test'],
            requiredReviews: { ...REVIEW_FLAGS, code: true, security: true, refactor: true, test: true },
            policyMode: 'strict_sequential',
            reviewStates: [
                { review_type: 'code', satisfied: false },
                { review_type: 'security', satisfied: false },
                { review_type: 'refactor', satisfied: false, failed_current: true },
                { review_type: 'test', satisfied: false }
            ]
        });

        assert.deepEqual(plan.launchable_review_types, ['code']);
        assert.equal(plan.failed_review_type, null);
        assert.equal(plan.next_review_type, 'code');
        assert.deepEqual(plan.blocked_review_lanes, [
            { review_type: 'security', blocked_by: ['code'] },
            { review_type: 'refactor', blocked_by: ['code', 'security'] },
            { review_type: 'test', blocked_by: ['code', 'security', 'refactor'] }
        ]);
    });
});
