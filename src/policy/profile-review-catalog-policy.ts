import { createHash } from 'node:crypto';

import type { ReviewCapabilitiesConfigMap } from '../core/review-capabilities';
import type {
    NormalizedReviewCatalog,
    NormalizedReviewTypeDefinition
} from '../core/review-catalog';

export type ProfileReviewPolicyValue = boolean | 'auto';
export type ProfileReviewCatalogState = 'disabled' | 'auto' | 'required';
export type ProfileReviewCatalogStateSource =
    | 'profile'
    | 'built_in_compatibility_default'
    | 'custom_disabled_default';
export type ProfileReviewCatalogInactiveReason = 'profile_disabled' | 'capability_disabled';

export interface ProfileReviewCatalogLane {
    id: string;
    display_label: string;
    built_in: boolean;
    state: ProfileReviewCatalogState;
    state_source: ProfileReviewCatalogStateSource;
    capability_enabled: boolean;
    active: boolean;
    inactive_reason: ProfileReviewCatalogInactiveReason | null;
}

export interface ResolvedProfileReviewCatalogPolicy {
    schema_version: 1;
    profile_name: string;
    activity_basis: 'profile_policy_and_capability';
    task_effective_selection: 'resolved_during_preflight';
    catalog_sha256: string;
    policy_sha256: string;
    lanes: readonly ProfileReviewCatalogLane[];
}

export interface ProfileReviewCatalogPolicyAnalysis {
    policy: ResolvedProfileReviewCatalogPolicy;
    issues: string[];
}

export interface LegacyCompatibilityReviewCatalogBinding {
    profile_policy: ResolvedProfileReviewCatalogPolicy;
    profile_snapshot_sha256: string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeState(
    definition: NormalizedReviewTypeDefinition,
    rawValue: unknown
): Pick<ProfileReviewCatalogLane, 'state' | 'state_source'> | null {
    if (rawValue === true) {
        return { state: 'required', state_source: 'profile' };
    }
    if (rawValue === false) {
        return { state: 'disabled', state_source: 'profile' };
    }
    if (rawValue === 'auto') {
        return { state: 'auto', state_source: 'profile' };
    }
    if (rawValue === undefined) {
        return definition.built_in
            ? { state: 'auto', state_source: 'built_in_compatibility_default' }
            : { state: 'disabled', state_source: 'custom_disabled_default' };
    }
    return null;
}

function computePolicySha256(value: Omit<ResolvedProfileReviewCatalogPolicy, 'policy_sha256'>): string {
    return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function deepFreeze<T>(value: T): T {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) {
        return value;
    }
    for (const child of Object.values(value as Record<string, unknown>)) {
        deepFreeze(child);
    }
    return Object.freeze(value);
}

export function analyzeProfileReviewCatalogPolicy(
    profileName: string,
    profilePolicyInput: unknown,
    capabilities: ReviewCapabilitiesConfigMap,
    catalog: NormalizedReviewCatalog
): ProfileReviewCatalogPolicyAnalysis {
    const issues: string[] = [];
    const profilePolicy = isPlainRecord(profilePolicyInput) ? profilePolicyInput : {};
    if (!isPlainRecord(profilePolicyInput)) {
        issues.push(`Profile '${profileName}' review_policy must be a JSON object.`);
    }

    const definitionsById = new Map(catalog.review_types.map((definition) => [definition.id, definition]));
    for (const reviewId of Object.keys(profilePolicy)) {
        if (!definitionsById.has(reviewId)) {
            issues.push(`Profile '${profileName}' review_policy contains unknown catalog review id '${reviewId}'.`);
        }
    }

    const lanes = catalog.review_types.map((definition): ProfileReviewCatalogLane => {
        const rawValue = profilePolicy[definition.id];
        const normalized = normalizeState(definition, rawValue);
        if (!normalized) {
            issues.push(
                `Profile '${profileName}' review_policy.${definition.id} must be true, false, or 'auto'.`
            );
        }
        const state = normalized?.state ?? 'disabled';
        const stateSource = normalized?.state_source ?? 'profile';
        const capabilityEnabled = capabilities[definition.id] === true;
        if (!definition.built_in && state === 'required' && !capabilityEnabled) {
            issues.push(
                `Profile '${profileName}' review_policy.${definition.id} is required but review capability ` +
                `'${definition.id}' is disabled; enable the capability or choose false/'auto'.`
            );
        }
        const active = state !== 'disabled'
            && (capabilityEnabled || (definition.built_in && state === 'required'));
        return {
            id: definition.id,
            display_label: definition.display_label,
            built_in: definition.built_in,
            state,
            state_source: stateSource,
            capability_enabled: capabilityEnabled,
            active,
            inactive_reason: active
                ? null
                : state === 'disabled'
                    ? 'profile_disabled'
                    : 'capability_disabled'
        };
    });

    const payload: Omit<ResolvedProfileReviewCatalogPolicy, 'policy_sha256'> = {
        schema_version: 1,
        profile_name: profileName,
        activity_basis: 'profile_policy_and_capability',
        task_effective_selection: 'resolved_during_preflight',
        catalog_sha256: catalog.catalog_sha256,
        lanes
    };
    return {
        policy: deepFreeze({ ...payload, policy_sha256: computePolicySha256(payload) }),
        issues
    };
}

export function resolveProfileReviewCatalogPolicy(
    profileName: string,
    profilePolicyInput: unknown,
    capabilities: ReviewCapabilitiesConfigMap,
    catalog: NormalizedReviewCatalog
): ResolvedProfileReviewCatalogPolicy {
    const analysis = analyzeProfileReviewCatalogPolicy(profileName, profilePolicyInput, capabilities, catalog);
    if (analysis.issues.length > 0) {
        throw new Error(analysis.issues.join(' '));
    }
    return analysis.policy;
}

export function resolveLegacyCompatibilityReviewCatalogBinding(
    capabilities: ReviewCapabilitiesConfigMap,
    catalog: NormalizedReviewCatalog
): LegacyCompatibilityReviewCatalogBinding {
    const profilePolicy = resolveProfileReviewCatalogPolicy(
        'legacy-compatibility',
        {},
        capabilities,
        catalog
    );
    const profileSnapshotSha256 = createHash('sha256').update(JSON.stringify({
        schema_version: 1,
        mode: 'legacy_builtin_compatibility',
        catalog_sha256: catalog.catalog_sha256,
        profile_policy_sha256: profilePolicy.policy_sha256
    }), 'utf8').digest('hex');
    return deepFreeze({
        profile_policy: profilePolicy,
        profile_snapshot_sha256: profileSnapshotSha256
    });
}
