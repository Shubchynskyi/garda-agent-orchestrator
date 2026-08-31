import test from 'node:test';
import assert from 'node:assert/strict';

import { compileReviewDependencyGraph } from '../../../src/core/review-dependency-graph';
import {
    resolveRuntimeReviewRemediationModeGuards
} from '../../../src/cli/commands/gate-flows/recovery/recovery-flow-review-cycle';
import {
    REVIEW_REMEDIATION_DELTA_CATEGORIES,
    buildDefaultReviewRemediationRerunPolicy,
    resolveReviewRemediationRerunLanes,
    resolveReviewRemediationRerunPolicyFromSnapshot,
    validateReviewRemediationRerunPolicy,
    type ReviewRemediationDeltaCategory,
    type ReviewRemediationRerunPolicy
} from '../../../src/policy/review-remediation-rerun-policy';
import {
    buildDefaultReviewRemediationModePolicy,
    collectReviewRemediationProtectedBoundarySignals,
    evaluateReviewRemediationMode,
    hasReviewRemediationPolicySourceChange,
    migrateReviewRemediationModePolicyLaneDefaults,
    resolveReviewRemediationModePolicyFromProfile,
    resolveReviewRemediationModePolicyFromSnapshot,
    validateReviewRemediationModePolicy
} from '../../../src/policy/review-remediation-mode-policy';

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

    const production = resolve('production', 'code');
    assert.deepEqual(production.ordered_rerun_lanes, ['code']);

    for (const category of ['global', 'generated_churn', 'ambiguous'] as const) {
        const broad = resolve(category);
        assert.deepEqual(broad.ordered_rerun_lanes, canonicalReviewOrder, category);
        assert.match(broad.reason, /every currently required review lane/iu, category);
    }
});

test('allows every configured lane to use bounded DELTA while preserving per-lane disable fallback', () => {
    const policy = buildDefaultReviewRemediationModePolicy();
    const localCode = evaluateReviewRemediationMode({
        policy,
        reviewType: 'code',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 12,
        consecutiveDeltaReviews: 0
    });
    assert.equal(localCode.mode, 'DELTA');
    assert.deepEqual(localCode.delta_eligible_review_types, [
        'api',
        'code',
        'db',
        'dependency',
        'infra',
        'performance',
        'refactor',
        'security',
        'test'
    ]);

    const securityLane = evaluateReviewRemediationMode({
        policy,
        reviewType: 'security',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 12,
        consecutiveDeltaReviews: 0
    });
    assert.equal(securityLane.mode, 'DELTA');

    for (const reviewType of policy.delta_eligible_review_types) {
        assert.equal(evaluateReviewRemediationMode({
            policy,
            reviewType,
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 12,
            consecutiveDeltaReviews: 0
        }).mode, 'DELTA', reviewType);
    }

    const securityDisabledPolicy = {
        ...policy,
        delta_eligible_review_types: policy.delta_eligible_review_types.filter(
            (reviewType) => reviewType !== 'security'
        )
    };
    const securityDisabled = evaluateReviewRemediationMode({
        policy: securityDisabledPolicy,
        reviewType: 'security',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 12,
        consecutiveDeltaReviews: 0
    });
    assert.equal(securityDisabled.mode, 'FULL');
    assert.match(securityDisabled.full_review_reasons.join(' '), /security.*not DELTA-eligible/iu);
    assert.equal(evaluateReviewRemediationMode({
        policy: securityDisabledPolicy,
        reviewType: 'code',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 12,
        consecutiveDeltaReviews: 0
    }).mode, 'DELTA');

    const periodicFull = evaluateReviewRemediationMode({
        policy,
        reviewType: 'test',
        category: 'leaf_test',
        changedFilesCount: 1,
        changedLinesTotal: 2,
        consecutiveDeltaReviews: policy.max_consecutive_delta_reviews
    });
    assert.equal(periodicFull.mode, 'FULL');
    assert.match(periodicFull.full_review_reasons.join(' '), /periodic FULL/iu);
});

test('rejects protected scope evidence into FULL and never treats path keywords as allow evidence', () => {
    const policy = buildDefaultReviewRemediationModePolicy();
    const signals = collectReviewRemediationProtectedBoundarySignals({
        changedFiles: ['src/auth/permission-contract.ts', 'package-lock.json'],
        preflight: {
            triggers: { security: true, dependency: true },
            required_reviews: { security: true, dependency: true }
        }
    });
    assert.deepEqual(signals, [
        'api_contract',
        'auth_or_permission',
        'dependency',
        'lockfile',
        'security'
    ]);
    const assessment = evaluateReviewRemediationMode({
        policy,
        reviewType: 'code',
        category: 'production',
        changedFilesCount: 2,
        changedLinesTotal: 20,
        consecutiveDeltaReviews: 0,
        protectedBoundarySignals: signals
    });
    assert.equal(assessment.mode, 'FULL');
    assert.match(assessment.full_review_reasons.join(' '), /protected boundary signal/iu);
});

test('detects protected implementation paths without relying on preflight review flags', () => {
    const policy = buildDefaultReviewRemediationModePolicy();
    const signals = collectReviewRemediationProtectedBoundarySignals({
        changedFiles: [
            'src/db/orders-repository.ts',
            'src/dependencies/client-adapter.ts',
            'src/security/crypto-provider.ts',
            'src/routes/orders-endpoint.ts'
        ],
        preflight: {}
    });
    assert.deepEqual(signals, [
        'api_contract',
        'database',
        'dependency',
        'security'
    ]);
    const assessment = evaluateReviewRemediationMode({
        policy,
        reviewType: 'code',
        category: 'production',
        changedFilesCount: 4,
        changedLinesTotal: 40,
        consecutiveDeltaReviews: 0,
        protectedBoundarySignals: signals
    });
    assert.equal(assessment.mode, 'FULL');
    assert.equal(assessment.protected_boundary_signals.length, 4);
});

test('detects review policy implementation and frozen configuration sources', () => {
    assert.equal(hasReviewRemediationPolicySourceChange([
        'src/policy/review-remediation-mode-policy.ts'
    ]), true);
    assert.equal(hasReviewRemediationPolicySourceChange([
        'src/core/review-dependency-graph.ts'
    ]), true);
    assert.equal(hasReviewRemediationPolicySourceChange([
        'garda-agent-orchestrator/live/config/profiles.json'
    ]), true);
    assert.equal(hasReviewRemediationPolicySourceChange([
        'template/config/profiles.json'
    ]), true);
    assert.equal(hasReviewRemediationPolicySourceChange([
        'src/services/review-summary.ts',
        'tests/node/policy/review-remediation-rerun-policy.test.ts'
    ]), false);
});

test('recovery mode guards force the policyChanged input for policy-source remediation', () => {
    const policySource = resolveRuntimeReviewRemediationModeGuards({
        currentChangedFiles: ['src/policy/review-remediation-mode-policy.ts'],
        preflightPayload: { triggers: {}, required_reviews: { code: true } }
    });
    assert.equal(policySource.policyChanged, true);
    assert.equal(policySource.taskCriteriaChanged, false);

    const ordinarySource = resolveRuntimeReviewRemediationModeGuards({
        currentChangedFiles: ['src/services/review-summary.ts'],
        preflightPayload: { triggers: {}, required_reviews: { code: true } }
    });
    assert.equal(ordinarySource.policyChanged, false);
});

test('recovery mode guards force taskCriteriaChanged for authenticated criteria drift or missing values', () => {
    const unchanged = resolveRuntimeReviewRemediationModeGuards({
        currentChangedFiles: ['src/app.ts'],
        authenticatedTaskCriteria: 'Keep the authenticated task criteria.',
        currentTaskCriteria: 'Keep the authenticated task criteria.'
    });
    assert.equal(unchanged.taskCriteriaChanged, false);

    const changed = resolveRuntimeReviewRemediationModeGuards({
        currentChangedFiles: ['src/app.ts'],
        authenticatedTaskCriteria: 'Keep the authenticated task criteria.',
        currentTaskCriteria: 'Expand the task criteria.'
    });
    assert.equal(changed.taskCriteriaChanged, true);

    const missing = resolveRuntimeReviewRemediationModeGuards({
        currentChangedFiles: ['src/app.ts'],
        authenticatedTaskCriteria: 'Keep the authenticated task criteria.',
        currentTaskCriteria: null
    });
    assert.equal(missing.taskCriteriaChanged, true);
});

test('accepts stable custom review lanes, rejects malformed identifiers, and preserves mandatory FULL floors', () => {
    const customLane = buildDefaultReviewRemediationModePolicy({
        allowedReviewTypeIds: ['custom-quality']
    });
    const allowedReviewTypeIds = [...customLane.delta_eligible_review_types];
    const validatedCustomLane = validateReviewRemediationModePolicy(customLane, { allowedReviewTypeIds });
    assert.equal(evaluateReviewRemediationMode({
        policy: validatedCustomLane,
        reviewType: 'custom-quality',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 12,
        consecutiveDeltaReviews: 0
    }).mode, 'DELTA');

    assert.throws(
        () => validateReviewRemediationModePolicy(customLane, {
            allowedReviewTypeIds: allowedReviewTypeIds.filter((reviewType) => reviewType !== 'custom-quality')
        }),
        /absent from the review catalog: custom-quality/iu
    );

    const malformedLane = buildDefaultReviewRemediationModePolicy();
    malformedLane.delta_eligible_review_types.push('custom_quality');
    malformedLane.delta_eligible_review_types.sort();
    assert.throws(
        () => validateReviewRemediationModePolicy(malformedLane),
        /invalid or unsupported.*review lane identifiers/iu
    );

    const weakenedCategory = buildDefaultReviewRemediationModePolicy();
    weakenedCategory.force_full_categories = ['global'];
    assert.throws(() => validateReviewRemediationModePolicy(weakenedCategory), /mandatory floors/iu);

    const migratedCustomLane = migrateReviewRemediationModePolicyLaneDefaults({
        ...buildDefaultReviewRemediationModePolicy(),
        schema_version: 1,
        delta_eligible_review_types: ['code']
    }, { allowedReviewTypeIds: ['custom-quality'] }) as { delta_eligible_review_types: string[] };
    assert.ok(migratedCustomLane.delta_eligible_review_types.includes('custom-quality'));

    const extendedCategory = buildDefaultReviewRemediationModePolicy() as unknown as Record<string, unknown>;
    extendedCategory.force_full_categories = ['ambiguous', 'generated_churn', 'global', 'local'];
    assert.throws(() => validateReviewRemediationModePolicy(extendedCategory), /unsupported categories/iu);

    const weakenedBounds = buildDefaultReviewRemediationModePolicy();
    weakenedBounds.max_delta_changed_files = 50;
    weakenedBounds.max_delta_changed_lines = 50_000;
    weakenedBounds.max_consecutive_delta_reviews = 50;
    assert.throws(() => validateReviewRemediationModePolicy(weakenedBounds), /safety ceiling/iu);

    const legacy = resolveReviewRemediationModePolicyFromSnapshot({ schema_version: 1 });
    assert.equal(legacy.legacy_fallback, true);
    const legacyAssessment = evaluateReviewRemediationMode({
        policy: legacy.policy,
        legacyFallback: legacy.legacy_fallback,
        reviewType: 'code',
        category: 'production',
        changedFilesCount: 1,
        changedLinesTotal: 1,
        consecutiveDeltaReviews: 0
    });
    assert.equal(legacyAssessment.mode, 'FULL');
});

test('migrates valid schema-1 lane selections once while preserving explicit schema-2 disables', () => {
    const migrated = migrateReviewRemediationModePolicyLaneDefaults({
        ...buildDefaultReviewRemediationModePolicy(),
        schema_version: 1,
        delta_eligible_review_types: ['code', 'test']
    }) as ReturnType<typeof buildDefaultReviewRemediationModePolicy>;
    assert.equal(migrated.schema_version, 2);
    assert.deepEqual(migrated.delta_eligible_review_types, [
        'api',
        'code',
        'db',
        'dependency',
        'infra',
        'performance',
        'security',
        'test'
    ]);

    const explicitlyDisabled = {
        ...migrated,
        delta_eligible_review_types: ['code', 'test']
    };
    assert.deepEqual(
        migrateReviewRemediationModePolicyLaneDefaults(explicitlyDisabled),
        explicitlyDisabled
    );
    assert.deepEqual(validateReviewRemediationModePolicy({
        ...explicitlyDisabled,
        delta_eligible_review_types: []
    }).delta_eligible_review_types, []);
});

test('keeps unresolved schema-1 profile and snapshot policies FULL-only until init migration', () => {
    const legacyPolicy = {
        ...buildDefaultReviewRemediationModePolicy(),
        schema_version: 1 as const,
        delta_eligible_review_types: ['code', 'test']
    };
    const profileResolution = resolveReviewRemediationModePolicyFromProfile(legacyPolicy, 'legacy');
    const snapshotResolution = resolveReviewRemediationModePolicyFromSnapshot({
        review_remediation_mode_policy: legacyPolicy
    });

    for (const resolution of [profileResolution, snapshotResolution]) {
        assert.equal(resolution.legacy_fallback, true);
        assert.ok(resolution.diagnostics.some((entry) => entry.includes('schema version 1')));
        assert.equal(evaluateReviewRemediationMode({
            policy: resolution.policy,
            legacyFallback: resolution.legacy_fallback,
            reviewType: 'code',
            category: 'production',
            changedFilesCount: 1,
            changedLinesTotal: 12,
            consecutiveDeltaReviews: 0
        }).mode, 'FULL');
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
