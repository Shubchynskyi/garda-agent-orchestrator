import test from 'node:test';
import assert from 'node:assert/strict';

import { compileReviewDependencyGraph } from '../../../src/core/review-dependency-graph';
import {
    REVIEW_REMEDIATION_DELTA_CATEGORIES,
    buildDefaultReviewRemediationRerunPolicy,
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot,
    validateReviewRemediationRerunPolicy,
    type ReviewRemediationDeltaCategory,
    type ReviewRemediationRerunPolicy
} from '../../../src/policy/review-remediation-rerun-policy';

const allRequiredReviews = {
    dependency: true,
    test: true,
    api: true,
    code: true,
    infra: true,
    db: true,
    refactor: true,
    performance: true,
    security: true
};

const canonicalReviewOrder = [
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency',
    'test'
];

function resolve(category: ReviewRemediationDeltaCategory, currentReviewType = 'test') {
    return resolveReviewRemediationRerunLanes({
        policy: buildDefaultReviewRemediationRerunPolicy(),
        category,
        currentReviewType,
        requiredReviews: allRequiredReviews,
        reviewExecutionPolicyMode: 'strict_sequential'
    });
}

test('maps every remediation delta category to the snapshotted minimal affected-review policy', () => {
    const leaf = resolve('leaf_test');
    assert.equal(leaf.strategy, 'current_review_only');
    assert.deepEqual(leaf.ordered_rerun_lanes, ['test']);
    assert.equal(leaf.ordered_rerun_lanes.includes('refactor'), false);

    const structural = resolve('structural_test');
    assert.equal(structural.strategy, 'affected_dependent_reviews');
    assert.deepEqual(structural.ordered_rerun_lanes, ['refactor', 'test']);
    assert.deepEqual(structural.dependency_edges, [
        { review_type: 'refactor', depends_on: [] },
        { review_type: 'test', depends_on: ['refactor'] }
    ]);

    const shared = resolve('shared_test_helper_or_harness');
    assert.deepEqual(shared.ordered_rerun_lanes, ['code', 'refactor', 'test']);
    assert.deepEqual(shared.dependency_edges, [
        { review_type: 'code', depends_on: [] },
        { review_type: 'refactor', depends_on: ['code'] },
        { review_type: 'test', depends_on: ['code', 'refactor'] }
    ]);

    for (const category of ['production', 'global', 'generated_churn', 'ambiguous'] as const) {
        const broad = resolve(category);
        assert.deepEqual(broad.ordered_rerun_lanes, canonicalReviewOrder, category);
        assert.match(broad.reason, /every currently required review lane/iu, category);
    }
});

test('filters configured affected lanes to required reviews and fails closed when current review is unavailable', () => {
    const policy = buildDefaultReviewRemediationRerunPolicy();
    const structural = resolveReviewRemediationRerunLanes({
        policy,
        category: 'structural_test',
        currentReviewType: 'test',
        requiredReviews: { refactor: false, test: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    assert.deepEqual(structural.ordered_rerun_lanes, ['test']);
    assert.deepEqual(structural.omitted_configured_lanes, ['refactor']);

    const unavailableCurrent = resolveReviewRemediationRerunLanes({
        policy,
        category: 'leaf_test',
        currentReviewType: 'code',
        requiredReviews: { refactor: true, test: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    });
    assert.equal(unavailableCurrent.fallback_to_all_required, true);
    assert.deepEqual(unavailableCurrent.ordered_rerun_lanes, ['refactor', 'test']);
});

test('preserves the active review execution dependency graph without changing selected lanes', () => {
    const parallel = resolveReviewRemediationRerunLanes({
        policy: buildDefaultReviewRemediationRerunPolicy(),
        category: 'structural_test',
        currentReviewType: 'test',
        requiredReviews: { refactor: true, test: true },
        reviewExecutionPolicyMode: 'parallel_all'
    });
    assert.deepEqual(parallel.ordered_rerun_lanes, ['refactor', 'test']);
    assert.deepEqual(parallel.dependency_edges, [
        { review_type: 'refactor', depends_on: [] },
        { review_type: 'test', depends_on: [] }
    ]);
});

test('expands remediation seeds through a frozen custom graph while preserving independent lanes', () => {
    const reviewDependencyGraph = compileReviewDependencyGraph({
        catalogLaneIds: ['code', 'security', 'architecture-boundary', 'test'],
        activeLaneIds: ['code', 'security', 'architecture-boundary', 'test'],
        requiredReviewIds: ['code', 'security', 'architecture-boundary', 'test'],
        mode: 'parallel_all',
        declaration: {
            preparation_order: ['code', 'security', 'architecture-boundary', 'test'],
            dependencies: {
                'architecture-boundary': ['code'],
                test: ['architecture-boundary']
            }
        }
    });

    const selection = resolveReviewRemediationRerunLanes({
        policy: buildDefaultReviewRemediationRerunPolicy(),
        category: 'leaf_test',
        currentReviewType: 'code',
        requiredReviews: { code: true, security: true, 'architecture-boundary': true, test: true },
        reviewExecutionPolicyMode: 'parallel_all',
        reviewDependencyGraph
    });

    assert.deepEqual(selection.ordered_rerun_lanes, ['code', 'architecture-boundary', 'test']);
    assert.deepEqual(selection.dependency_edges, [
        { review_type: 'code', depends_on: [] },
        { review_type: 'architecture-boundary', depends_on: ['code'] },
        { review_type: 'test', depends_on: ['architecture-boundary'] }
    ]);
    assert.equal(selection.ordered_rerun_lanes.includes('security'), false);
    assert.match(selection.reason, /expands through affected downstream graph lanes/u);
});

test('resolves legacy snapshots conservatively to all required lanes for every category', () => {
    const resolution = resolveReviewRemediationRerunPolicyFromSnapshot({ schema_version: 1 });
    assert.equal(resolution.legacy_fallback, true);
    assert.ok(resolution.diagnostics.some((entry) => entry.includes('Legacy task profile policy snapshot')));
    for (const category of REVIEW_REMEDIATION_DELTA_CATEGORIES) {
        const selection = resolveReviewRemediationRerunLanes({
            policy: resolution.policy,
            category,
            currentReviewType: 'test',
            requiredReviews: { code: true, test: true },
            reviewExecutionPolicyMode: 'strict_sequential'
        });
        assert.equal(selection.strategy, 'affected_dependent_reviews', category);
        assert.deepEqual(selection.ordered_rerun_lanes, ['code', 'test'], category);
    }
});

test('rejects malformed, incomplete, duplicated, and unknown rerun policy rules', () => {
    const missingRule = buildDefaultReviewRemediationRerunPolicy() as unknown as Record<string, unknown>;
    delete (missingRule.rules as Record<string, unknown>).ambiguous;
    assert.throws(() => validateReviewRemediationRerunPolicy(missingRule), /rules\.ambiguous is required/iu);

    const duplicateLane = buildDefaultReviewRemediationRerunPolicy();
    duplicateLane.rules.structural_test.ordered_rerun_lanes = ['refactor', 'refactor'];
    assert.throws(() => validateReviewRemediationRerunPolicy(duplicateLane), /duplicate lane 'refactor'/iu);

    const emptyLanes = buildDefaultReviewRemediationRerunPolicy();
    emptyLanes.rules.structural_test.ordered_rerun_lanes = [];
    assert.throws(
        () => validateReviewRemediationRerunPolicy(emptyLanes),
        /must be "all_required" or a non-empty array/u
    );

    const unsupportedLane = buildDefaultReviewRemediationRerunPolicy();
    unsupportedLane.rules.structural_test.ordered_rerun_lanes = ['release' as 'test'];
    assert.throws(
        () => validateReviewRemediationRerunPolicy(unsupportedLane),
        /contains unsupported lane 'release'/u
    );

    const noncanonicalLane = buildDefaultReviewRemediationRerunPolicy();
    noncanonicalLane.rules.structural_test.ordered_rerun_lanes = [' Refactor ' as 'refactor', 'test'];
    assert.throws(
        () => validateReviewRemediationRerunPolicy(noncanonicalLane),
        /lane ' Refactor ' must use canonical value 'refactor'/u
    );

    const noncanonicalStrategy = buildDefaultReviewRemediationRerunPolicy();
    noncanonicalStrategy.rules.leaf_test.strategy = ' current_review_only ' as 'current_review_only';
    assert.throws(
        () => validateReviewRemediationRerunPolicy(noncanonicalStrategy),
        /strategy must use the canonical value 'current_review_only'/u
    );

    const unknownStrategy = buildDefaultReviewRemediationRerunPolicy() as unknown as ReviewRemediationRerunPolicy;
    unknownStrategy.rules.leaf_test.strategy = 'silent_reuse' as 'current_review_only';
    assert.throws(() => validateReviewRemediationRerunPolicy(unknownStrategy), /strategy must be one of/iu);

    assert.throws(() => resolveReviewRemediationRerunLanes({
        policy: buildDefaultReviewRemediationRerunPolicy(),
        category: 'unknown' as ReviewRemediationDeltaCategory,
        currentReviewType: 'test',
        requiredReviews: { test: true },
        reviewExecutionPolicyMode: 'strict_sequential'
    }), /unknown review remediation delta category/iu);
});
