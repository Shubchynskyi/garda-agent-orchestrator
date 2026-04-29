import * as path from 'node:path';

import {
    getProfileSource,
    loadProfilesData,
    resolveEffectivePolicy,
    type EffectivePolicy
} from './profile-resolver';

export type TaskProfileSelectionSource = 'task_queue' | 'workspace_active';

export interface TaskProfileSelectionSummary {
    task_profile: string | null;
    profile_selection_source: TaskProfileSelectionSource;
    effective_profile: string;
    effective_profile_source: 'built_in' | 'user';
    runtime_active_profile: string;
    runtime_profile_source: 'built_in' | 'user' | null;
}

export interface ResolvedTaskProfileSelection {
    selection: TaskProfileSelectionSummary;
    effective_policy: EffectivePolicy;
}

export interface TaskProfileSelectionOptions {
    domainSurface?: Record<string, boolean>;
    forceAllDomainReviews?: boolean;
    forceCodeReview?: boolean;
    protectedControlPlaneChanged?: boolean;
}

export function normalizeTaskProfileValue(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return normalized || null;
}

export function resolveTaskProfileSelection(
    bundleRoot: string,
    taskProfile: unknown,
    scopeCategory: string | null = null,
    options: TaskProfileSelectionOptions = {}
): ResolvedTaskProfileSelection {
    const profilesPath = path.join(bundleRoot, 'live', 'config', 'profiles.json');
    const profilesData = loadProfilesData(profilesPath);
    const runtimeActiveProfile = profilesData.active_profile.trim();
    const runtimeProfileSource = getProfileSource(profilesData, runtimeActiveProfile);
    const normalizedTaskProfile = normalizeTaskProfileValue(taskProfile);
    const usesTaskQueueProfile = normalizedTaskProfile != null && normalizedTaskProfile !== 'default';
    const effectivePolicy = resolveEffectivePolicy(bundleRoot, {
        ...(usesTaskQueueProfile ? { profileOverride: normalizedTaskProfile } : {}),
        ...(scopeCategory ? { scopeCategory } : {}),
        ...(options.domainSurface ? { domainSurface: options.domainSurface } : {}),
        ...(options.forceAllDomainReviews === true ? { forceAllDomainReviews: true } : {}),
        ...(options.forceCodeReview === true ? { forceCodeReview: true } : {}),
        ...(options.protectedControlPlaneChanged === true ? { protectedControlPlaneChanged: true } : {})
    });

    return {
        selection: {
            task_profile: normalizedTaskProfile,
            profile_selection_source: usesTaskQueueProfile ? 'task_queue' : 'workspace_active',
            effective_profile: effectivePolicy.profile_name,
            effective_profile_source: effectivePolicy.profile_source,
            runtime_active_profile: runtimeActiveProfile,
            runtime_profile_source: runtimeProfileSource
        },
        effective_policy: effectivePolicy
    };
}
