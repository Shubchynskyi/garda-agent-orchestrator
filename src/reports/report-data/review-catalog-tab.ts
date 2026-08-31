import * as path from 'node:path';

import {
    buildReviewCatalogLaneExplanation,
    requireInspectionLane
} from '../../cli/commands/review-catalog/review-catalog-inspection';
import {
    readReviewCatalogManagedState,
    resolveReviewCatalogRoots
} from '../../cli/commands/review-catalog/review-catalog-state';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import { analyzeProfileReviewCatalogPolicy } from '../../policy/profile-review-catalog-policy';
import type { ParsedOptionsRecord } from '../../cli/commands/profile/profile-types';
import type {
    ReportReviewCatalogLane,
    ReportReviewCatalogTab
} from './types';

interface ReviewCatalogReportPaths {
    bundleRoot: string;
    catalogPath: string;
    capabilitiesPath: string;
    profilesPath: string;
}

function resolveReportPaths(repoRoot: string): ReviewCatalogReportPaths {
    const bundleRoot = joinOrchestratorPath(path.resolve(repoRoot), '');
    const configRoot = path.join(bundleRoot, 'live', 'config');
    return {
        bundleRoot,
        catalogPath: path.join(configRoot, 'review-catalog.json'),
        capabilitiesPath: path.join(configRoot, 'review-capabilities.json'),
        profilesPath: path.join(configRoot, 'profiles.json')
    };
}

function buildInvalidTab(paths: ReviewCatalogReportPaths, reason: string): ReportReviewCatalogTab {
    return {
        status: 'invalid',
        catalog_path: toPosix(paths.catalogPath),
        capabilities_path: toPosix(paths.capabilitiesPath),
        profiles_path: toPosix(paths.profilesPath),
        catalog_exists: false,
        catalog_sha256: null,
        state_sha256: null,
        active_profile: null,
        selected_profile: null,
        profile_names: [],
        known_skill_ids: [],
        validation: {
            status: 'FAIL',
            issues: [reason]
        },
        migration: {
            status: 'blocked_invalid',
            required: false,
            reason: 'Review catalog migration cannot be assessed until the managed configuration is valid.'
        },
        lanes: []
    };
}

function selectProfileName(
    requestedProfile: string | null | undefined,
    activeProfile: string,
    profileNames: readonly string[]
): string {
    const requested = String(requestedProfile || '').trim();
    return requested && profileNames.includes(requested) ? requested : activeProfile;
}

export function buildReviewCatalogTab(
    repoRoot: string,
    requestedProfile?: string | null
): ReportReviewCatalogTab {
    const paths = resolveReportPaths(repoRoot);
    try {
        const rootOptions: ParsedOptionsRecord = {
            targetRoot: path.dirname(paths.bundleRoot),
            bundleRoot: paths.bundleRoot
        };
        const state = readReviewCatalogManagedState(resolveReviewCatalogRoots(rootOptions));
        const profileEntries = [
            ...Object.entries(state.profiles.built_in_profiles),
            ...Object.entries(state.profiles.user_profiles)
        ];
        const profileNames = profileEntries.map(([profileName]) => profileName);
        const selectedProfile = selectProfileName(requestedProfile, state.profiles.active_profile, profileNames);
        const selectedEntry = profileEntries.find(([profileName]) => profileName === selectedProfile)?.[1];
        if (!selectedEntry) {
            throw new Error(`Review catalog profile '${selectedProfile}' is unavailable.`);
        }
        const policyAnalysis = analyzeProfileReviewCatalogPolicy(
            selectedProfile,
            selectedEntry.review_policy,
            state.capabilities,
            state.catalog
        );
        if (policyAnalysis.issues.length > 0) {
            throw new Error(policyAnalysis.issues.join(' '));
        }
        const policyLanes = new Map(policyAnalysis.policy.lanes.map((lane) => [lane.id, lane]));
        const lanes: ReportReviewCatalogLane[] = state.catalog.review_types.map((definition) => {
            const inspection = requireInspectionLane(state, definition.id);
            const policyLane = policyLanes.get(definition.id);
            if (!policyLane) throw new Error(`Review catalog policy lane '${definition.id}' is unavailable.`);
            return {
                id: definition.id,
                display_label: definition.display_label,
                source: definition.built_in ? 'built_in' : 'custom',
                built_in: definition.built_in,
                enabled_by_default: definition.enabled_by_default,
                capability_enabled: inspection.capability_enabled,
                skill_ids: [...inspection.skill_ids],
                trigger: {
                    mode: inspection.trigger.mode,
                    signal_ids: [...inspection.trigger.signal_ids]
                },
                coverage_category_ids: [...inspection.coverage_category_ids],
                reviewer_role: {
                    role_id: inspection.reviewer_role.role_id,
                    focus_tags: [...inspection.reviewer_role.focus_tags]
                },
                verdict_tokens: { ...inspection.verdict_tokens },
                profile: {
                    name: selectedProfile,
                    state: policyLane.state,
                    state_source: policyLane.state_source,
                    active: policyLane.active,
                    inactive_reason: policyLane.inactive_reason,
                    dependencies: [...(inspection.dependencies[selectedProfile] || [])],
                    explanation: buildReviewCatalogLaneExplanation(state, definition.id, selectedProfile)
                }
            };
        });
        const legacyCompatible = !state.catalogExists;
        return {
            status: legacyCompatible ? 'legacy_compatible' : 'present',
            catalog_path: toPosix(state.roots.catalogPath),
            capabilities_path: toPosix(state.roots.capabilitiesPath),
            profiles_path: toPosix(state.roots.profilesPath),
            catalog_exists: state.catalogExists,
            catalog_sha256: state.catalog.catalog_sha256,
            state_sha256: state.stateSha256,
            active_profile: state.profiles.active_profile,
            selected_profile: selectedProfile,
            profile_names: profileNames,
            known_skill_ids: [...state.knownSkillIds],
            validation: {
                status: 'PASS',
                issues: []
            },
            migration: legacyCompatible
                ? {
                    status: 'legacy_compatible',
                    required: false,
                    reason: 'The optional catalog file is absent; built-in compatibility lanes remain effective.'
                }
                : {
                    status: 'current',
                    required: false,
                    reason: 'The managed review catalog is present and validates with capabilities and profiles.'
                },
            lanes
        };
    } catch (error: unknown) {
        return buildInvalidTab(paths, error instanceof Error ? error.message : String(error));
    }
}
