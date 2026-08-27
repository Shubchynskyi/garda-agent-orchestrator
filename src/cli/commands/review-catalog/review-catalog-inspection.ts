import { analyzeProfileReviewCatalogPolicy } from '../../../policy/profile-review-catalog-policy';
import type { ProfileEntry } from '../../../policy/profile-resolver';
import type {
    ReviewCatalogInspectionLane,
    ReviewCatalogInspectionLaneSummary,
    ReviewCatalogManagedState,
    ReviewCatalogProfileState
} from './review-catalog-types';

function getProfiles(state: ReviewCatalogManagedState): Array<[string, ProfileEntry]> {
    return [
        ...Object.entries(state.profiles.built_in_profiles),
        ...Object.entries(state.profiles.user_profiles)
    ];
}

function resolveProfileState(value: unknown, builtIn: boolean): ReviewCatalogProfileState {
    if (value === true) return 'required';
    if (value === false) return 'disabled';
    if (value === 'auto') return 'auto';
    return builtIn ? 'auto' : 'disabled';
}

function buildInspectionLaneSummary(
    state: ReviewCatalogManagedState,
    definition: ReviewCatalogManagedState['catalog']['review_types'][number]
): ReviewCatalogInspectionLaneSummary {
    return {
        id: definition.id,
        display_label: definition.display_label,
        built_in: definition.built_in,
        capability_enabled: state.capabilities[definition.id] === true,
        skill_ids: definition.skill_ids,
        trigger: definition.trigger,
        coverage_category_ids: definition.coverage_category_ids,
        reviewer_role: definition.reviewer_role,
        verdict_tokens: definition.verdict_tokens
    };
}

export function buildReviewCatalogInspectionLaneSummaries(
    state: ReviewCatalogManagedState
): ReviewCatalogInspectionLaneSummary[] {
    return state.catalog.review_types.map((definition) => buildInspectionLaneSummary(state, definition));
}

export function requireInspectionLane(
    state: ReviewCatalogManagedState,
    reviewId: string
): ReviewCatalogInspectionLane {
    const definition = state.catalog.review_types.find(({ id }) => id === reviewId);
    if (!definition) throw new Error(`Unknown review catalog id '${reviewId}'.`);
    const profileStates: Record<string, ReviewCatalogProfileState> = {};
    const dependencies: Record<string, readonly string[]> = {};
    for (const [profileName, profile] of getProfiles(state)) {
        profileStates[profileName] = resolveProfileState(
            profile.review_policy[definition.id],
            definition.built_in
        );
        dependencies[profileName] = Object.freeze([
            ...(profile.review_dependency_graph?.dependencies[definition.id] || [])
        ]);
    }
    return {
        ...buildInspectionLaneSummary(state, definition),
        profile_states: profileStates,
        dependencies
    };
}

export function buildReviewCatalogLaneExplanation(
    state: ReviewCatalogManagedState,
    reviewId: string,
    profileName: string
): string[] {
    const lane = requireInspectionLane(state, reviewId);
    const profile = Object.hasOwn(state.profiles.built_in_profiles, profileName)
        ? state.profiles.built_in_profiles[profileName]
        : state.profiles.user_profiles[profileName];
    if (!profile) throw new Error(`Unknown profile '${profileName}'.`);
    const policy = analyzeProfileReviewCatalogPolicy(
        profileName,
        profile.review_policy,
        state.capabilities,
        state.catalog
    );
    if (policy.issues.length > 0) throw new Error(policy.issues.join(' '));
    const policyLane = policy.policy.lanes.find(({ id }) => id === reviewId)!;
    const triggerLine = lane.trigger.mode === 'signals'
        ? `${reviewId} trigger uses signals: ${lane.trigger.signal_ids.join(', ')}`
        : lane.trigger.mode === 'manual'
            ? `${reviewId} trigger is manual only`
            : `${reviewId} uses built-in compatibility triggers`;
    const dependencies = lane.dependencies[profileName] || [];
    return [
        triggerLine,
        `${reviewId} profile state is ${policyLane.state}; capability is ${policyLane.capability_enabled ? 'enabled' : 'disabled'}; effective lane is ${policyLane.active ? 'active' : 'inactive'}.`,
        dependencies.length > 0
            ? `${reviewId} depends on ${dependencies.join(', ')} in profile ${profileName}.`
            : `${reviewId} has no upstream dependencies in profile ${profileName}.`,
        `${reviewId} coverage categories: ${lane.coverage_category_ids.join(', ')}.`,
        `${reviewId} canonical verdicts: ${lane.verdict_tokens.pass} / ${lane.verdict_tokens.fail}.`
    ];
}
