import { createHash } from 'node:crypto';

import {
    normalizeReviewCatalog,
    type NormalizedReviewCatalog
} from './review-catalog';
import type { ReviewCapabilitiesConfigMap } from './review-capabilities';
import { compileReviewDependencyGraph } from './review-dependency-graph';
import type { ResolvedReviewExecutionPolicyConfig } from './review-execution-policy';
import {
    resolveProfileReviewCatalogPolicy,
    type ProfileReviewCatalogLane
} from '../policy/profile-review-catalog-policy';
import type { ProfileEntry, ProfilesData } from '../policy/profile-resolver';

export const REVIEW_CATALOG_MIGRATION_PARITY_SCHEMA_VERSION = 1 as const;

interface MigrationContractHash {
    before_sha256: string;
    after_sha256: string;
    equal: true;
}

export interface ReviewCatalogMigrationParity {
    schema_version: typeof REVIEW_CATALOG_MIGRATION_PARITY_SCHEMA_VERSION;
    status: 'PASS';
    source_catalog_mode: 'implicit_compatibility' | 'explicit_config';
    target_catalog_mode: 'explicit_config';
    review_execution_mode: ResolvedReviewExecutionPolicyConfig['mode'];
    review_execution_policy_configured: boolean;
    profile_count: number;
    contracts: {
        catalog: MigrationContractHash;
        required_reviews: MigrationContractHash;
        verdicts_and_receipts: MigrationContractHash;
        dependency_order: MigrationContractHash;
        task_reports: MigrationContractHash;
    };
    legacy_capabilities_source: 'retained_unchanged';
    custom_capability_changes: readonly string[];
    parity_sha256: string;
}

export interface AnalyzeReviewCatalogMigrationParityOptions {
    catalogExists: boolean;
    sourceCatalogConfig: unknown;
    proposedCatalogConfig: unknown;
    sourceCapabilities: ReviewCapabilitiesConfigMap;
    proposedCapabilities: ReviewCapabilitiesConfigMap;
    sourceProfiles: ProfilesData;
    proposedProfiles: ProfilesData;
    knownSkillIds: readonly string[];
    reviewExecutionPolicy: ResolvedReviewExecutionPolicyConfig;
}

interface ProfileContractSet {
    required_reviews: unknown;
    dependency_order: unknown;
    task_reports: unknown;
}

function canonicalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (!value || typeof value !== 'object') return value;
    return Object.keys(value as Record<string, unknown>)
        .sort((left, right) => left.localeCompare(right))
        .reduce<Record<string, unknown>>((result, key) => {
            result[key] = canonicalize((value as Record<string, unknown>)[key]);
            return result;
        }, {});
}

function sha256(value: unknown): string {
    return createHash('sha256')
        .update(JSON.stringify(canonicalize(value)), 'utf8')
        .digest('hex');
}

function getProfileEntries(profiles: ProfilesData): Array<[string, ProfileEntry]> {
    return [
        ...Object.entries(profiles.built_in_profiles),
        ...Object.entries(profiles.user_profiles)
    ].sort(([left], [right]) => left.localeCompare(right));
}

function buildCatalogContract(catalog: NormalizedReviewCatalog): unknown {
    return catalog.review_types.map((definition) => ({
        id: definition.id,
        display_label: definition.display_label,
        built_in: definition.built_in,
        enabled_by_default: definition.enabled_by_default,
        skill_ids: definition.skill_ids,
        trigger: definition.trigger,
        coverage_category_ids: definition.coverage_category_ids,
        reviewer_role: definition.reviewer_role,
        verdict_tokens: definition.verdict_tokens
    }));
}

function buildVerdictAndReceiptContract(catalog: NormalizedReviewCatalog): unknown {
    return catalog.review_types.map((definition) => ({
        review_id: definition.id,
        pass_token: definition.verdict_tokens.pass,
        fail_token: definition.verdict_tokens.fail
    }));
}

function buildLaneReportContract(
    lanes: readonly ProfileReviewCatalogLane[],
    profile: ProfileEntry
): unknown {
    return lanes.map((lane) => ({
        id: lane.id,
        display_label: lane.display_label,
        built_in: lane.built_in,
        state: lane.state,
        state_source: lane.state_source,
        capability_enabled: lane.capability_enabled,
        active: lane.active,
        inactive_reason: lane.inactive_reason,
        dependencies: [...(profile.review_dependency_graph?.dependencies[lane.id] || [])]
    }));
}

function buildProfileContracts(
    profiles: ProfilesData,
    capabilities: ReviewCapabilitiesConfigMap,
    catalog: NormalizedReviewCatalog,
    reviewExecutionPolicy: ResolvedReviewExecutionPolicyConfig
): ProfileContractSet {
    const catalogLaneIds = catalog.review_types.map(({ id }) => id);
    const requiredReviews: unknown[] = [];
    const dependencyOrder: unknown[] = [];
    const taskReports: unknown[] = [];

    for (const [profileName, profile] of getProfileEntries(profiles)) {
        const policy = resolveProfileReviewCatalogPolicy(
            profileName,
            profile.review_policy,
            capabilities,
            catalog
        );
        const activeLaneIds = policy.lanes.filter(({ active }) => active).map(({ id }) => id);
        const compiledGraph = compileReviewDependencyGraph({
            catalogLaneIds,
            activeLaneIds,
            requiredReviewIds: activeLaneIds,
            mode: reviewExecutionPolicy.mode,
            declaration: profile.review_dependency_graph
        });
        requiredReviews.push({
            profile_name: profileName,
            lanes: policy.lanes.map((lane) => ({
                id: lane.id,
                state: lane.state,
                state_source: lane.state_source,
                capability_enabled: lane.capability_enabled,
                active: lane.active,
                inactive_reason: lane.inactive_reason
            }))
        });
        dependencyOrder.push({
            profile_name: profileName,
            mode: reviewExecutionPolicy.mode,
            declaration: profile.review_dependency_graph ?? null,
            active_lane_ids: activeLaneIds,
            preparation_order: compiledGraph.preparation_order,
            dependencies: compiledGraph.dependencies,
            preparation_batches: compiledGraph.preparation_batches
        });
        taskReports.push({
            profile_name: profileName,
            lanes: buildLaneReportContract(policy.lanes, profile)
        });
    }

    return {
        required_reviews: requiredReviews,
        dependency_order: dependencyOrder,
        task_reports: taskReports
    };
}

function requireEqualContract(label: string, beforeValue: unknown, afterValue: unknown): MigrationContractHash {
    const beforeSha256 = sha256(beforeValue);
    const afterSha256 = sha256(afterValue);
    if (beforeSha256 !== afterSha256) {
        throw new Error(
            `Review catalog migration parity failed for ${label}: `
            + `${beforeSha256} != ${afterSha256}. Migration cannot proceed.`
        );
    }
    return {
        before_sha256: beforeSha256,
        after_sha256: afterSha256,
        equal: true
    };
}

export function analyzeReviewCatalogMigrationParity(
    options: AnalyzeReviewCatalogMigrationParityOptions
): ReviewCatalogMigrationParity {
    const sourceCatalog = normalizeReviewCatalog(options.sourceCatalogConfig, {
        knownSkillIds: options.knownSkillIds
    });
    const proposedCatalog = normalizeReviewCatalog(options.proposedCatalogConfig, {
        knownSkillIds: options.knownSkillIds
    });
    const sourceProfileContracts = buildProfileContracts(
        options.sourceProfiles,
        options.sourceCapabilities,
        sourceCatalog,
        options.reviewExecutionPolicy
    );
    const proposedProfileContracts = buildProfileContracts(
        options.proposedProfiles,
        options.proposedCapabilities,
        proposedCatalog,
        options.reviewExecutionPolicy
    );
    const sourceCapabilitiesSha256 = sha256(options.sourceCapabilities);
    const proposedCapabilitiesSha256 = sha256(options.proposedCapabilities);
    if (sourceCapabilitiesSha256 !== proposedCapabilitiesSha256) {
        throw new Error(
            'Review catalog migration must retain the effective legacy review-capabilities contract unchanged.'
        );
    }

    const contracts = {
        catalog: requireEqualContract(
            'catalog lanes',
            buildCatalogContract(sourceCatalog),
            buildCatalogContract(proposedCatalog)
        ),
        required_reviews: requireEqualContract(
            'required reviews',
            sourceProfileContracts.required_reviews,
            proposedProfileContracts.required_reviews
        ),
        verdicts_and_receipts: requireEqualContract(
            'verdict and receipt tokens',
            buildVerdictAndReceiptContract(sourceCatalog),
            buildVerdictAndReceiptContract(proposedCatalog)
        ),
        dependency_order: requireEqualContract(
            'review dependency order',
            sourceProfileContracts.dependency_order,
            proposedProfileContracts.dependency_order
        ),
        task_reports: requireEqualContract(
            'task report review lanes',
            sourceProfileContracts.task_reports,
            proposedProfileContracts.task_reports
        )
    };
    const parityBody = {
        schema_version: REVIEW_CATALOG_MIGRATION_PARITY_SCHEMA_VERSION,
        status: 'PASS' as const,
        source_catalog_mode: options.catalogExists
            ? 'explicit_config' as const
            : 'implicit_compatibility' as const,
        target_catalog_mode: 'explicit_config' as const,
        review_execution_mode: options.reviewExecutionPolicy.mode,
        review_execution_policy_configured: options.reviewExecutionPolicy.configured,
        profile_count: getProfileEntries(options.sourceProfiles).length,
        contracts,
        legacy_capabilities_source: 'retained_unchanged' as const,
        custom_capability_changes: Object.freeze([] as string[])
    };
    return Object.freeze({
        ...parityBody,
        parity_sha256: sha256(parityBody)
    });
}
