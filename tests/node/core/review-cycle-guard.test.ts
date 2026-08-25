import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_REVIEW_CYCLE_GUARD_CONFIG,
    evaluateReviewCycleGuard,
    normalizeReviewCycleGuardConfig
} from '../../../src/core/review-cycle-guard';

test('review cycle guard defaults to splitting after ten failed non-test reviews', () => {
    assert.equal(DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.max_failed_non_test_reviews, 10);
    assert.equal(normalizeReviewCycleGuardConfig({}).max_failed_non_test_reviews, 10);
});

test('review cycle guard blocks when failed reviews reach the configured maximum', () => {
    const config = normalizeReviewCycleGuardConfig({
        enabled: true,
        action: 'BLOCK_FOR_OPERATOR_DECISION',
        max_failed_non_test_reviews: 10,
        max_total_non_test_reviews: 30,
        excluded_review_types: ['test'],
        auto_split_enabled: true
    });
    const attempts = Array.from({ length: 10 }, () => ({
        reviewType: 'code',
        failed: true,
        latestEventFailed: true
    }));

    const evaluation = evaluateReviewCycleGuard(config, {
        attempts,
        timelineValid: true
    });

    assert.equal(evaluation.failed_non_test_review_count, 10);
    assert.equal(evaluation.should_block, true);
    assert.deepEqual(evaluation.violations, [{
        metric: 'failed_non_test_review_count',
        actual: 10,
        limit: 10
    }]);
    assert.match(evaluation.summary_line, /failed_non_test_review_count=10>=10/u);
});

test('review cycle guard does not count excluded test review failures', () => {
    const config = normalizeReviewCycleGuardConfig({
        enabled: true,
        action: 'BLOCK_FOR_OPERATOR_DECISION',
        max_failed_non_test_reviews: 1,
        max_total_non_test_reviews: 30,
        excluded_review_types: ['test'],
        auto_split_enabled: true
    });

    const evaluation = evaluateReviewCycleGuard(config, {
        attempts: [{
            reviewType: 'test',
            failed: true,
            latestEventFailed: true
        }],
        timelineValid: true
    });

    assert.equal(evaluation.failed_non_test_review_count, 0);
    assert.equal(evaluation.should_block, false);
});
