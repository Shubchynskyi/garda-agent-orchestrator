import test from 'node:test';
import assert from 'node:assert/strict';

import {
    analyzeReviewCatalogMigrationParity
} from '../../../src/core/review-catalog-migration';
import type { ReviewCapabilitiesConfigMap } from '../../../src/core/review-capabilities';
import type { EffectiveReviewExecutionPolicyMode } from '../../../src/core/review-execution-policy';
import type { ProfileReviewPolicy, ProfilesData } from '../../../src/policy/profile-resolver';

const COMPATIBILITY_MODES: EffectiveReviewExecutionPolicyMode[] = [
    'legacy_test_downstream',
    'parallel_all',
    'test_after_code',
    'code_first_optional',
    'strict_sequential'
];

function createCapabilities(): ReviewCapabilitiesConfigMap {
    return {
        code: true,
        db: true,
        security: true,
        refactor: true,
        api: true,
        test: true,
        performance: true,
        infra: true,
        dependency: true
    };
}

function createProfiles(): ProfilesData {
    const reviewPolicy: ProfileReviewPolicy = {
        code: true,
        db: 'auto',
        security: 'auto',
        refactor: 'auto',
        api: 'auto',
        test: 'auto',
        performance: 'auto',
        infra: 'auto',
        dependency: 'auto'
    };
    return {
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: {
                description: 'Balanced migration fixture.',
                depth: 2,
                review_policy: reviewPolicy,
                token_economy: {
                    enabled: true,
                    strip_examples: true,
                    strip_code_blocks: true,
                    scoped_diffs: true,
                    compact_reviewer_output: true
                },
                skills: { auto_suggest: true }
            }
        },
        user_profiles: {}
    };
}

function createCatalog(customReviewTypes: unknown[] = []): Record<string, unknown> {
    return { version: 1, custom_review_types: customReviewTypes };
}

test('review catalog migration preserves legacy and every preset behavior contract', () => {
    const capabilities = createCapabilities();
    const profiles = createProfiles();

    for (const mode of COMPATIBILITY_MODES) {
        const parity = analyzeReviewCatalogMigrationParity({
            catalogExists: false,
            sourceCatalogConfig: createCatalog(),
            proposedCatalogConfig: createCatalog(),
            sourceCapabilities: capabilities,
            proposedCapabilities: capabilities,
            sourceProfiles: profiles,
            proposedProfiles: profiles,
            knownSkillIds: [],
            reviewExecutionPolicy: {
                mode,
                configured: mode !== 'legacy_test_downstream'
            }
        });

        assert.equal(parity.status, 'PASS', mode);
        assert.equal(parity.source_catalog_mode, 'implicit_compatibility', mode);
        assert.equal(parity.target_catalog_mode, 'explicit_config', mode);
        assert.equal(parity.review_execution_mode, mode);
        assert.equal(parity.review_execution_policy_configured, mode !== 'legacy_test_downstream');
        assert.ok(Object.values(parity.contracts).every((contract) => contract.equal));
        assert.match(parity.parity_sha256, /^[a-f0-9]{64}$/u);
    }
});

test('review catalog migration keeps custom lanes disabled and profile policy unchanged', () => {
    const customDefinition = {
        id: 'architecture',
        display_label: 'Architecture review',
        enabled_by_default: false,
        skill_id: 'architecture-review',
        trigger: { mode: 'manual', signal_ids: [] },
        coverage_category_ids: ['maintainability'],
        reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
    };
    const catalog = createCatalog([customDefinition]);
    const capabilities = { ...createCapabilities(), architecture: false };
    const profiles = createProfiles();
    const parity = analyzeReviewCatalogMigrationParity({
        catalogExists: true,
        sourceCatalogConfig: catalog,
        proposedCatalogConfig: catalog,
        sourceCapabilities: capabilities,
        proposedCapabilities: capabilities,
        sourceProfiles: profiles,
        proposedProfiles: profiles,
        knownSkillIds: ['architecture-review'],
        reviewExecutionPolicy: { mode: 'strict_sequential', configured: true }
    });

    assert.equal(parity.status, 'PASS');
    assert.equal(parity.legacy_capabilities_source, 'retained_unchanged');
    assert.deepEqual(parity.custom_capability_changes, []);
    assert.equal(parity.contracts.required_reviews.equal, true);
    assert.equal(parity.contracts.task_reports.equal, true);
});

test('review catalog migration rejects capability or catalog parity drift', () => {
    const capabilities = createCapabilities();
    const profiles = createProfiles();
    const baseOptions = {
        catalogExists: false,
        sourceCatalogConfig: createCatalog(),
        sourceCapabilities: capabilities,
        sourceProfiles: profiles,
        proposedProfiles: profiles,
        reviewExecutionPolicy: { mode: 'strict_sequential' as const, configured: true }
    };

    assert.throws(
        () => analyzeReviewCatalogMigrationParity({
            ...baseOptions,
            proposedCatalogConfig: createCatalog(),
            proposedCapabilities: { ...capabilities, test: false },
            knownSkillIds: []
        }),
        /parity failed|retain the effective legacy review-capabilities contract/iu
    );
    assert.throws(
        () => analyzeReviewCatalogMigrationParity({
            ...baseOptions,
            sourceCapabilities: { ...capabilities, architecture: false },
            proposedCatalogConfig: createCatalog([{
                id: 'architecture',
                display_label: 'Architecture review',
                enabled_by_default: false,
                skill_id: 'architecture-review',
                trigger: { mode: 'manual', signal_ids: [] },
                coverage_category_ids: ['maintainability'],
                reviewer_role: { role_id: 'architecture-reviewer', focus_tags: ['maintainability'] }
            }]),
            proposedCapabilities: { ...capabilities, architecture: false },
            knownSkillIds: ['architecture-review']
        }),
        /migration parity failed/iu
    );
});
