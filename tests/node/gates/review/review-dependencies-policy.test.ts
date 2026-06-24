import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getRequiredUpstreamReviewsFromRecord} from '../../../../src/gates/review/review-dependencies';
import { getReviewExecutionPreparationBatches } from '../../../../src/core/review-execution-policy';








test('getRequiredUpstreamReviewsFromRecord keeps all reviews independent in parallel_all mode', () => {
    const requiredReviews = {
        code: true,
        api: true,
        test: true
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'parallel_all'), []);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'parallel_all'), []);
});

test('getRequiredUpstreamReviewsFromRecord applies code_first_optional dependencies', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'code_first_optional'), ['code']);
    assert.deepEqual(
        getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'code_first_optional'),
        ['code', 'security', 'api', 'performance']
    );
});

test('getRequiredUpstreamReviewsFromRecord narrows test_after_code to code only and serializes strict_sequential', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: false,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'test_after_code'), ['code']);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'strict_sequential'), ['code', 'db', 'security']);
    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'strict_sequential'), ['code', 'db', 'security', 'api']);
});

test('getRequiredUpstreamReviewsFromRecord keeps legacy compatibility with only test downstream of all required upstream reviews', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(getRequiredUpstreamReviewsFromRecord('api', requiredReviews, 'legacy_test_downstream'), []);
    assert.deepEqual(
        getRequiredUpstreamReviewsFromRecord('test', requiredReviews, 'legacy_test_downstream'),
        ['code', 'db', 'security', 'api', 'performance']
    );
});

test('getReviewExecutionPreparationBatches groups independent reviews together for parallel_all and test_after_code', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: false,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'parallel_all'),
        [['code', 'api', 'performance', 'test']]
    );
    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'test_after_code'),
        [['code', 'api', 'performance'], ['test']]
    );
});

test('getReviewExecutionPreparationBatches keeps code-gated and legacy downstream reviews in later batches', () => {
    const requiredReviews = {
        code: true,
        db: false,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: true,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'code_first_optional'),
        [['code', 'security'], ['api', 'performance'], ['test']]
    );
    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'legacy_test_downstream'),
        [['code', 'security', 'api', 'performance'], ['test']]
    );
});

test('getReviewExecutionPreparationBatches keeps strict_sequential fully serialized', () => {
    const requiredReviews = {
        code: true,
        db: true,
        security: true,
        refactor: false,
        api: true,
        test: true,
        performance: false,
        infra: false,
        dependency: false
    };

    assert.deepEqual(
        getReviewExecutionPreparationBatches(requiredReviews, 'strict_sequential'),
        [['code'], ['db'], ['security'], ['api'], ['test']]
    );
});

