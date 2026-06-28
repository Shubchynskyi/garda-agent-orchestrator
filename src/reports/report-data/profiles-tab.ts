import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ProfileEntry, type ProfilesData } from '../../cli/commands/profile/profile-types';
import { KNOWN_REVIEW_TYPES } from '../../cli/commands/profile/profile-model';
import { readProfilesData } from '../../cli/commands/profile/profile-data';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import { getKnownReviewTypeLabel } from '../review-type-setting-text';
import type { ReportDataUnavailableEntry, ReportProfileRow, ReportProfilesTab } from './types';

function profilesPath(repoRoot: string): string {
    return joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'profiles.json'));
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
    return {
        name,
        source,
        active: name === activeProfile,
        protected: source === 'built_in',
        description: entry.description,
        depth: entry.depth,
        review_policy: { ...entry.review_policy },
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
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'present',
            active_profile: data.active_profile,
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
