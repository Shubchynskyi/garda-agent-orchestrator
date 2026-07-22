import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ProfileEntry, type ProfilesData } from '../../cli/commands/profile/profile-types';
import { KNOWN_REVIEW_TYPES } from '../../cli/commands/profile/profile-model';
import { readProfilesData } from '../../cli/commands/profile/profile-data';
import { buildProfileFindingPolicyProjection } from '../../cli/commands/profile/profile-finding-policy';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import { resolveReviewFollowUpPolicy } from '../../policy/profile-resolver';
import { loadReviewTriggerPolicy } from '../../policy/review-trigger-policy';
import { getKnownReviewTypeLabel } from '../review-type-setting-text';
import type { ReportDataUnavailableEntry, ReportProfileRow, ReportProfilesTab } from './types';

function profilesPath(repoRoot: string): string {
    return joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'profiles.json'));
}

function pathsConfigPath(repoRoot: string): string {
    return joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'paths.json'));
}

function buildProfileRows(data: ProfilesData): ReportProfileRow[] {
    const rows: ReportProfileRow[] = [];
    for (const [name, entry] of Object.entries(data.built_in_profiles)) {
        rows.push(buildProfileRow(name, 'built_in', data.active_profile, entry));
    }
    for (const [name, entry] of Object.entries(data.user_profiles)) {
        rows.push(buildProfileRow(name, 'user', data.active_profile, entry));
    }
    return rows;
}

function buildProfileRow(
    name: string,
    source: ReportProfileRow['source'],
    activeProfile: string,
    entry: ProfileEntry
): ReportProfileRow {
    const findingPolicy = buildProfileFindingPolicyProjection(name, entry);
    const followUpPolicy = resolveReviewFollowUpPolicy(entry.review_follow_up_policy, name);
    return {
        name,
        source,
        active: name === activeProfile,
        protected: source === 'built_in',
        description: entry.description,
        depth: entry.depth,
        review_policy: { ...entry.review_policy },
        review_finding_policy: findingPolicy.policy,
        review_finding_policy_sha256: findingPolicy.policy_sha256,
        review_finding_policy_migration: {
            ...findingPolicy.migration,
            diagnostics: findingPolicy.diagnostics
        },
        review_follow_up_policy: { ...followUpPolicy.policy },
        review_follow_up_policy_diagnostics: [...followUpPolicy.diagnostics],
        token_economy: { ...entry.token_economy },
        skills: { ...entry.skills }
    };
}

function buildEmptyProfilesTab(configPath: string, status: ReportProfilesTab['status'], reason: string): ReportProfilesTab {
    return {
        config_path: toPosix(configPath),
        config_exists: status !== 'missing',
        status,
        active_profile: null,
        review_trigger_policy: null,
        review_types: KNOWN_REVIEW_TYPES.map((id) => ({ id, label: getKnownReviewTypeLabel(id) })),
        profiles: [],
        built_in_profile_names: [],
        user_profile_names: [],
        unavailable: [{ scope: 'profiles', reason }]
    };
}

export function buildProfilesTab(repoRoot: string): ReportProfilesTab {
    const configPath = profilesPath(repoRoot);
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        return buildEmptyProfilesTab(configPath, 'missing', 'Profiles config file missing.');
    }

    const unavailable: ReportDataUnavailableEntry[] = [];
    try {
        const data = readProfilesData(configPath);
        const reviewTriggerPolicy = loadReviewTriggerPolicy(pathsConfigPath(repoRoot));
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'present',
            active_profile: data.active_profile,
            review_trigger_policy: reviewTriggerPolicy,
            review_types: KNOWN_REVIEW_TYPES.map((id) => ({ id, label: getKnownReviewTypeLabel(id) })),
            profiles: buildProfileRows(data),
            built_in_profile_names: Object.keys(data.built_in_profiles),
            user_profile_names: Object.keys(data.user_profiles),
            unavailable
        };
    } catch (error: unknown) {
        return buildEmptyProfilesTab(
            configPath,
            'invalid',
            error instanceof Error ? error.message : String(error)
        );
    }
}
