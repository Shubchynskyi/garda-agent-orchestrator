import * as path from 'node:path';

import { normalizeReviewCatalog } from '../../../core/review-catalog';
import {
    normalizeReviewCapabilitiesConfigMap,
    type ReviewCapabilitiesConfigMap
} from '../../../core/review-capabilities';
import { analyzeProfileReviewCatalogPolicy } from '../../../policy/profile-review-catalog-policy';
import type { ProfileEntry, ProfilesData } from '../../../policy/profile-resolver';
import {
    computeReviewCatalogStateSha256,
    serializeReviewCatalogManagedConfig,
    sha256Text,
    validateReviewCatalogCombinedConfig,
    assertCustomReviewId
} from './review-catalog-state';
import type {
    ReviewCatalogConfigFile,
    ReviewCatalogManagedFileChange,
    ReviewCatalogManagedState,
    ReviewCatalogManagementPlan,
    ReviewCatalogMutationRequest,
    ReviewCatalogProfileState,
    ReviewCatalogRawDefinition,
    ReviewCatalogSemanticDiffEntry
} from './review-catalog-types';

function clone<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

function normalizeReviewId(value: string): string {
    const normalized = String(value || '').trim().toLowerCase();
    if (!/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(normalized)) {
        throw new Error('Review id must be a lowercase stable id using letters, digits, and single hyphens.');
    }
    return normalized;
}

function normalizeUniqueIds(values: readonly string[] | undefined): string[] | undefined {
    if (values === undefined) return undefined;
    return [...new Set(values.map((value) => normalizeReviewId(value)))].sort((left, right) => left.localeCompare(right));
}

function getProfileEntries(data: ProfilesData): Array<[string, ProfileEntry]> {
    return [
        ...Object.entries(data.built_in_profiles),
        ...Object.entries(data.user_profiles)
    ];
}

function requireProfile(data: ProfilesData, profileName: string): ProfileEntry {
    if (Object.hasOwn(data.built_in_profiles, profileName)) return data.built_in_profiles[profileName];
    if (Object.hasOwn(data.user_profiles, profileName)) return data.user_profiles[profileName];
    throw new Error(`Unknown profile '${profileName}'.`);
}

function requireCustomRawDefinition(
    state: ReviewCatalogManagedState,
    catalogConfig: ReviewCatalogConfigFile,
    reviewId: string
): ReviewCatalogRawDefinition {
    assertCustomReviewId(state, reviewId);
    const definition = catalogConfig.custom_review_types.find(({ id }) => id === reviewId);
    if (!definition) throw new Error(`Custom review catalog definition '${reviewId}' is missing.`);
    return definition;
}

function assertInstalledSkill(state: ReviewCatalogManagedState, skillId: string): void {
    if (!state.knownSkillIds.includes(skillId)) {
        throw new Error(`Review skill '${skillId}' is not a known installed review skill.`);
    }
}

function buildCreateDefinition(
    state: ReviewCatalogManagedState,
    request: ReviewCatalogMutationRequest
): ReviewCatalogRawDefinition {
    if (!request.displayLabel || !request.skillId || !request.triggerMode || !request.roleId) {
        throw new Error(
            'review-catalog create requires --display-label, --skill-id, --trigger-mode, and --role-id.'
        );
    }
    const coverageCategoryIds = normalizeUniqueIds(request.coverageCategoryIds);
    if (!coverageCategoryIds || coverageCategoryIds.length === 0) {
        throw new Error('review-catalog create requires at least one --coverage-category.');
    }
    const signalIds = normalizeUniqueIds(request.signalIds) || [];
    const focusTags = normalizeUniqueIds(request.focusTags) ?? [...coverageCategoryIds];
    assertInstalledSkill(state, request.skillId);
    return {
        id: request.reviewId,
        display_label: request.displayLabel,
        enabled_by_default: false,
        skill_id: request.skillId,
        trigger: { mode: request.triggerMode, signal_ids: signalIds },
        coverage_category_ids: coverageCategoryIds,
        reviewer_role: { role_id: request.roleId, focus_tags: focusTags }
    };
}

function updateDefinition(
    state: ReviewCatalogManagedState,
    definition: ReviewCatalogRawDefinition,
    request: ReviewCatalogMutationRequest
): void {
    const hasUpdate = [
        request.displayLabel,
        request.skillId,
        request.triggerMode,
        request.signalIds,
        request.coverageCategoryIds,
        request.roleId,
        request.focusTags
    ].some((value) => value !== undefined);
    if (!hasUpdate) throw new Error('review-catalog update requires at least one definition option.');
    if (request.displayLabel !== undefined) definition.display_label = request.displayLabel;
    if (request.skillId !== undefined) {
        assertInstalledSkill(state, request.skillId);
        definition.skill_id = request.skillId;
    }
    if (request.triggerMode !== undefined) {
        definition.trigger.mode = request.triggerMode;
        if (request.triggerMode === 'manual' && request.signalIds === undefined) definition.trigger.signal_ids = [];
    }
    if (request.signalIds !== undefined) definition.trigger.signal_ids = normalizeUniqueIds(request.signalIds) || [];
    if (request.coverageCategoryIds !== undefined) {
        definition.coverage_category_ids = normalizeUniqueIds(request.coverageCategoryIds) || [];
    }
    if (request.roleId !== undefined) definition.reviewer_role.role_id = request.roleId;
    if (request.focusTags !== undefined) definition.reviewer_role.focus_tags = normalizeUniqueIds(request.focusTags) || [];
}

function stateToProfileValue(state: ReviewCatalogProfileState): boolean | 'auto' {
    if (state === 'required') return true;
    if (state === 'disabled') return false;
    return 'auto';
}

function buildStableDependencyGraph(
    activeLaneIds: readonly string[],
    dependencyInput: Readonly<Record<string, readonly string[]>>,
    preferredOrder: readonly string[]
): { preparation_order: string[]; dependencies: Record<string, string[]> } {
    const active = new Set(activeLaneIds);
    const baseOrder = [...new Set([
        ...preferredOrder.filter((reviewId) => active.has(reviewId)),
        ...activeLaneIds.filter((reviewId) => !preferredOrder.includes(reviewId))
    ])];
    const rank = new Map(baseOrder.map((reviewId, index) => [reviewId, index]));
    const dependencies: Record<string, string[]> = {};
    for (const reviewId of activeLaneIds) {
        const values = [...new Set((dependencyInput[reviewId] || []).map(normalizeReviewId))];
        for (const dependency of values) {
            if (dependency === reviewId) {
                throw new Error(`Review lane '${reviewId}' cannot depend on itself; self-edge rejected.`);
            }
            if (!active.has(dependency)) {
                throw new Error(`Review lane '${reviewId}' depends on inactive or unknown lane '${dependency}'.`);
            }
        }
        dependencies[reviewId] = values.sort((left, right) => (
            (rank.get(left) ?? Number.MAX_SAFE_INTEGER) - (rank.get(right) ?? Number.MAX_SAFE_INTEGER)
            || left.localeCompare(right)
        ));
    }

    const indegree = new Map(activeLaneIds.map((reviewId) => [
        reviewId,
        dependencies[reviewId].length
    ]));
    const dependents = new Map(activeLaneIds.map((reviewId) => [reviewId, [] as string[]]));
    for (const [reviewId, reviewDependencies] of Object.entries(dependencies)) {
        for (const dependency of reviewDependencies) {
            dependents.get(dependency)!.push(reviewId);
        }
    }
    const preparationOrder: string[] = [];
    let ready = baseOrder.filter((reviewId) => indegree.get(reviewId) === 0);
    while (ready.length > 0) {
        for (const reviewId of ready) {
            preparationOrder.push(reviewId);
        }
        const nextReady: string[] = [];
        for (const reviewId of ready) {
            for (const dependent of dependents.get(reviewId)!) {
                const nextIndegree = indegree.get(dependent)! - 1;
                indegree.set(dependent, nextIndegree);
                if (nextIndegree === 0) nextReady.push(dependent);
            }
        }
        ready = nextReady.sort((left, right) => rank.get(left)! - rank.get(right)!);
    }
    if (preparationOrder.length !== activeLaneIds.length) {
        throw new Error('Review dependency mutation creates a cycle or an ambiguous invalid graph.');
    }
    return { preparation_order: preparationOrder, dependencies };
}

function buildEffectiveCapabilities(
    catalogConfig: ReviewCatalogConfigFile,
    capabilitiesConfig: ReviewCapabilitiesConfigMap,
    knownSkillIds: readonly string[]
): { catalog: ReturnType<typeof normalizeReviewCatalog>; capabilities: ReviewCapabilitiesConfigMap } {
    const catalog = normalizeReviewCatalog(catalogConfig, { knownSkillIds });
    const capabilities = normalizeReviewCapabilitiesConfigMap(capabilitiesConfig);
    for (const definition of catalog.review_types) {
        if (!definition.built_in && capabilities[definition.id] !== true) capabilities[definition.id] = false;
    }
    return { catalog, capabilities };
}

function reconcileDeclaredGraphs(
    profiles: ProfilesData,
    catalogConfig: ReviewCatalogConfigFile,
    capabilitiesConfig: ReviewCapabilitiesConfigMap,
    knownSkillIds: readonly string[]
): void {
    const effective = buildEffectiveCapabilities(catalogConfig, capabilitiesConfig, knownSkillIds);
    const catalogOrder = effective.catalog.review_types.map(({ id }) => id);
    for (const [profileName, profile] of getProfileEntries(profiles)) {
        if (!profile.review_dependency_graph) continue;
        const policy = analyzeProfileReviewCatalogPolicy(
            profileName,
            profile.review_policy,
            effective.capabilities,
            effective.catalog
        );
        if (policy.issues.length > 0) throw new Error(policy.issues.join(' '));
        const activeLaneIds = policy.policy.lanes.filter(({ active }) => active).map(({ id }) => id);
        const active = new Set(activeLaneIds);
        const dependencies = Object.fromEntries(activeLaneIds.map((reviewId) => [
            reviewId,
            (profile.review_dependency_graph?.dependencies[reviewId] || []).filter((dependency) => active.has(dependency))
        ]));
        profile.review_dependency_graph = buildStableDependencyGraph(
            activeLaneIds,
            dependencies,
            [...profile.review_dependency_graph.preparation_order, ...catalogOrder]
        );
    }
}

function setProfileDependency(
    profiles: ProfilesData,
    catalogConfig: ReviewCatalogConfigFile,
    capabilitiesConfig: ReviewCapabilitiesConfigMap,
    knownSkillIds: readonly string[],
    request: ReviewCatalogMutationRequest
): void {
    const profileName = request.profileName || '';
    const profile = requireProfile(profiles, profileName);
    const effective = buildEffectiveCapabilities(catalogConfig, capabilitiesConfig, knownSkillIds);
    const policy = analyzeProfileReviewCatalogPolicy(
        profileName,
        profile.review_policy,
        effective.capabilities,
        effective.catalog
    );
    if (policy.issues.length > 0) throw new Error(policy.issues.join(' '));
    const activeLaneIds = policy.policy.lanes.filter(({ active }) => active).map(({ id }) => id);
    if (!activeLaneIds.includes(request.reviewId)) {
        throw new Error(`Review lane '${request.reviewId}' must be active in profile '${profileName}' before dependencies can be set.`);
    }
    if (request.dependencyIds === undefined && request.clearDependencies !== true) {
        throw new Error('review-catalog dependency requires --depends-on or --clear-dependencies.');
    }
    const preferredOrder = profile.review_dependency_graph?.preparation_order
        ?? effective.catalog.review_types.map(({ id }) => id);
    const currentDependencies = profile.review_dependency_graph?.dependencies || {};
    const dependencies = Object.fromEntries(activeLaneIds.map((reviewId) => [
        reviewId,
        reviewId === request.reviewId
            ? request.clearDependencies === true ? [] : normalizeUniqueIds(request.dependencyIds) || []
            : [...(currentDependencies[reviewId] || [])]
    ]));
    profile.review_dependency_graph = buildStableDependencyGraph(
        activeLaneIds,
        dependencies,
        preferredOrder
    );
}

function buildSemanticDiff(
    beforeCatalog: ReviewCatalogConfigFile,
    afterCatalog: ReviewCatalogConfigFile,
    beforeCapabilities: Record<string, boolean>,
    afterCapabilities: Record<string, boolean>,
    beforeProfiles: ProfilesData,
    afterProfiles: ProfilesData
): ReviewCatalogSemanticDiffEntry[] {
    const diff: ReviewCatalogSemanticDiffEntry[] = [];
    const beforeDefinitions = new Map(beforeCatalog.custom_review_types.map((definition) => [definition.id, definition]));
    const afterDefinitions = new Map(afterCatalog.custom_review_types.map((definition) => [definition.id, definition]));
    for (const reviewId of [...new Set([...beforeDefinitions.keys(), ...afterDefinitions.keys()])].sort()) {
        const before = beforeDefinitions.get(reviewId) ?? null;
        const after = afterDefinitions.get(reviewId) ?? null;
        if (JSON.stringify(before) !== JSON.stringify(after)) {
            diff.push({ path: `review-catalog.custom_review_types.${reviewId}`, before, after });
        }
    }
    for (const reviewId of [...new Set([...Object.keys(beforeCapabilities), ...Object.keys(afterCapabilities)])].sort()) {
        const before = beforeCapabilities[reviewId];
        const after = afterCapabilities[reviewId];
        if (before !== after) diff.push({ path: `review-capabilities.${reviewId}`, before, after });
    }
    const beforeProfileMap = new Map(getProfileEntries(beforeProfiles));
    const afterProfileMap = new Map(getProfileEntries(afterProfiles));
    for (const profileName of [...afterProfileMap.keys()].sort()) {
        const beforeProfile = beforeProfileMap.get(profileName)!;
        const afterProfile = afterProfileMap.get(profileName)!;
        const reviewIds = [...new Set([
            ...Object.keys(beforeProfile.review_policy),
            ...Object.keys(afterProfile.review_policy)
        ])].sort();
        for (const reviewId of reviewIds) {
            const before = beforeProfile.review_policy[reviewId];
            const after = afterProfile.review_policy[reviewId];
            if (before !== after) {
                diff.push({ path: `profiles.${profileName}.review_policy.${reviewId}`, before, after });
            }
        }
        if (JSON.stringify(beforeProfile.review_dependency_graph ?? null) !== JSON.stringify(afterProfile.review_dependency_graph ?? null)) {
            diff.push({
                path: `profiles.${profileName}.review_dependency_graph`,
                before: beforeProfile.review_dependency_graph ?? null,
                after: afterProfile.review_dependency_graph ?? null
            });
        }
    }
    return diff;
}

function buildExplanation(
    catalogConfig: ReviewCatalogConfigFile,
    profiles: ProfilesData,
    request: ReviewCatalogMutationRequest
): string[] {
    const definition = catalogConfig.custom_review_types.find(({ id }) => id === request.reviewId);
    const lines: string[] = [];
    if (definition) {
        lines.push(definition.trigger.mode === 'signals'
            ? `${definition.id} trigger uses signals: ${definition.trigger.signal_ids.join(', ')}`
            : `${definition.id} trigger is manual only`);
        lines.push(`${definition.id} is disabled by default and requires explicit capability and profile policy enablement.`);
    }
    if (request.profileName) {
        const profile = requireProfile(profiles, request.profileName);
        const dependencies = profile.review_dependency_graph?.dependencies[request.reviewId] || [];
        lines.push(dependencies.length > 0
            ? `${request.reviewId} depends on ${dependencies.join(', ')} in profile ${request.profileName}.`
            : `${request.reviewId} has no upstream dependencies in profile ${request.profileName}.`);
    }
    return lines;
}

function buildManagedChanges(
    state: ReviewCatalogManagedState,
    proposedCatalog: ReviewCatalogConfigFile,
    proposedCapabilities: Record<string, boolean>,
    proposedProfiles: ProfilesData
): ReviewCatalogManagedFileChange[] {
    const candidates = [
        { path: state.roots.catalogPath, value: proposedCatalog, beforeValue: state.catalogConfig },
        { path: state.roots.capabilitiesPath, value: proposedCapabilities, beforeValue: state.capabilitiesConfig },
        { path: state.roots.profilesPath, value: proposedProfiles, beforeValue: state.profiles }
    ];
    return candidates
        .filter(({ value, beforeValue }) => JSON.stringify(value) !== JSON.stringify(beforeValue))
        .map(({ path: filePath, value }) => ({
            path: filePath,
            relative_path: path.relative(state.roots.bundleRoot, filePath).replace(/\\/gu, '/'),
            before_text: state.fileTexts[filePath] ?? null,
            after_text: serializeReviewCatalogManagedConfig(value)
        }));
}

export function buildReviewCatalogManagementPlan(
    state: ReviewCatalogManagedState,
    input: ReviewCatalogMutationRequest
): ReviewCatalogManagementPlan {
    const request: ReviewCatalogMutationRequest = {
        ...input,
        reviewId: normalizeReviewId(input.reviewId),
        profileName: input.profileName?.trim()
    };
    const proposedCatalog = clone(state.catalogConfig);
    const proposedCapabilities = clone(state.capabilitiesConfig);
    const proposedProfiles = clone(state.profiles);

    switch (request.operation) {
        case 'create': {
            if (state.catalog.review_types.some(({ id }) => id === request.reviewId)) {
                throw new Error(`Review catalog id '${request.reviewId}' already exists.`);
            }
            proposedCatalog.custom_review_types.push(buildCreateDefinition(state, request));
            proposedCatalog.custom_review_types.sort((left, right) => left.id.localeCompare(right.id));
            break;
        }
        case 'update': {
            const definition = requireCustomRawDefinition(state, proposedCatalog, request.reviewId);
            updateDefinition(state, definition, request);
            break;
        }
        case 'enable':
        case 'disable':
            assertCustomReviewId(state, request.reviewId);
            proposedCapabilities[request.reviewId] = request.operation === 'enable';
            reconcileDeclaredGraphs(proposedProfiles, proposedCatalog, proposedCapabilities, state.knownSkillIds);
            break;
        case 'profile-bind': {
            assertCustomReviewId(state, request.reviewId);
            if (!request.profileName || !request.profileState) {
                throw new Error('review-catalog profile-bind requires --profile and --state.');
            }
            requireProfile(proposedProfiles, request.profileName).review_policy[request.reviewId] = stateToProfileValue(request.profileState);
            reconcileDeclaredGraphs(proposedProfiles, proposedCatalog, proposedCapabilities, state.knownSkillIds);
            break;
        }
        case 'dependency':
            assertCustomReviewId(state, request.reviewId);
            if (!request.profileName) throw new Error('review-catalog dependency requires --profile.');
            setProfileDependency(
                proposedProfiles,
                proposedCatalog,
                proposedCapabilities,
                state.knownSkillIds,
                request
            );
            break;
    }

    validateReviewCatalogCombinedConfig(
        proposedCatalog,
        proposedCapabilities,
        proposedProfiles,
        state.knownSkillIds
    );
    const diff = buildSemanticDiff(
        state.catalogConfig,
        proposedCatalog,
        state.capabilitiesConfig,
        proposedCapabilities,
        state.profiles,
        proposedProfiles
    );
    const changes = buildManagedChanges(state, proposedCatalog, proposedCapabilities, proposedProfiles);
    const afterFileTexts = { ...state.fileTexts };
    for (const change of changes) afterFileTexts[change.path] = change.after_text;
    const afterStateSha256 = computeReviewCatalogStateSha256(afterFileTexts);
    const explanation = buildExplanation(proposedCatalog, proposedProfiles, request);
    const planBody = {
        action: 'review-catalog-mutation' as const,
        operation: request.operation,
        review_id: request.reviewId,
        before_state_sha256: state.stateSha256,
        after_state_sha256: afterStateSha256,
        changed: changes.length > 0,
        changes,
        diff,
        explanation
    };
    return {
        ...planBody,
        plan_sha256: sha256Text(JSON.stringify(planBody)),
        proposed_catalog: proposedCatalog,
        proposed_capabilities: proposedCapabilities,
        proposed_profiles: proposedProfiles
    };
}
