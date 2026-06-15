import { padRight } from '../cli-helpers';
import {
    getAllProfileNames,
    getProfileEntry,
    isBuiltInProfile,
    resolveProfilesPath
} from './profile-data';
import { ProfilesData } from './profile-types';

export function buildProfileListOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            built_in_profiles: Object.keys(data.built_in_profiles),
            user_profiles: Object.keys(data.user_profiles),
            config_path: resolveProfilesPath(bundleRoot)
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: list');
    lines.push(`Bundle: ${bundleRoot}`);
    lines.push(`ConfigPath: ${resolveProfilesPath(bundleRoot)}`);
    lines.push(`ActiveProfile: ${data.active_profile}`);
    lines.push('');
    lines.push('Built-in Profiles');
    for (const [name, entry] of Object.entries(data.built_in_profiles)) {
        const marker = name === data.active_profile ? '(*) ' : '    ';
        lines.push(`  ${marker}${padRight(name, 16)} depth=${entry.depth} ${entry.description}`);
    }
    const userNames = Object.keys(data.user_profiles);
    if (userNames.length > 0) {
        lines.push('');
        lines.push('User Profiles');
        for (const [name, entry] of Object.entries(data.user_profiles)) {
            const marker = name === data.active_profile ? '(*) ' : '    ';
            lines.push(`  ${marker}${padRight(name, 16)} depth=${entry.depth} ${entry.description}`);
        }
    }
    return lines.join('\n');
}

export function buildProfileCurrentOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    const entry = getProfileEntry(data, data.active_profile);
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            is_built_in: isBuiltInProfile(data, data.active_profile),
            entry: entry,
            config_path: resolveProfilesPath(bundleRoot)
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: current');
    lines.push(`ActiveProfile: ${data.active_profile}`);
    lines.push(`Type: ${isBuiltInProfile(data, data.active_profile) ? 'built-in' : 'user'}`);
    if (entry) {
        lines.push(`Description: ${entry.description}`);
        lines.push(`Depth: ${entry.depth}`);
        lines.push(`ReviewPolicy: ${formatReviewPolicy(entry.review_policy)}`);
        lines.push(`TokenEconomy: ${formatTokenEconomy(entry.token_economy)}`);
        lines.push(`Skills: ${formatSkills(entry.skills)}`);
        lines.push('Why: Active profile settings are used by default.');
    }
    lines.push('Tip: run "profile list" to inspect all available profiles.');
    return lines.join('\n');
}

export function buildProfileUseOutput(name: string, previous: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'use', previous_profile: previous, active_profile: name, changed: previous !== name }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: use');
    lines.push(`PreviousProfile: ${previous}`);
    lines.push(`ActiveProfile: ${name}`);
    lines.push(`Status: ${previous !== name ? 'CHANGED' : 'NO_CHANGE'}`);
    return lines.join('\n');
}

export function buildProfileCreateOutput(name: string, configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'create', profile: name, config_path: configPath }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: create');
    lines.push(`Profile: ${name}`);
    lines.push(`ConfigPath: ${configPath}`);
    lines.push('Status: CREATED');
    return lines.join('\n');
}

export function buildProfileDeleteOutput(name: string, configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({ action: 'delete', profile: name, config_path: configPath }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: delete');
    lines.push(`Profile: ${name}`);
    lines.push(`ConfigPath: ${configPath}`);
    lines.push('Status: DELETED');
    return lines.join('\n');
}

export function buildProfileValidateOutput(data: ProfilesData, issues: string[], configPath: string, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify({
            action: 'validate',
            config_path: configPath,
            profile_count: getAllProfileNames(data).length,
            issue_count: issues.length,
            validation: issues.length === 0 ? 'PASS' : 'FAIL',
            issues
        }, null, 2);
    }
    const lines: string[] = [];
    lines.push('GARDA_PROFILES');
    lines.push('Action: validate');
    lines.push(`ConfigPath: ${configPath}`);
    lines.push(`ProfileCount: ${getAllProfileNames(data).length}`);
    lines.push(`IssueCount: ${issues.length}`);
    lines.push(`Validation: ${issues.length === 0 ? 'PASS' : 'FAIL'}`);
    if (issues.length > 0) {
        lines.push('');
        for (const issue of issues) {
            lines.push(`- ${issue}`);
        }
    }
    return lines.join('\n');
}

function formatReviewPolicy(policy: Record<string, boolean | 'auto'>): string {
    return Object.entries(policy)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}

function formatTokenEconomy(economy: Record<string, boolean>): string {
    return Object.entries(economy)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}

function formatSkills(skills: Record<string, boolean>): string {
    return Object.entries(skills)
        .map(([k, v]) => `${k}=${String(v)}`)
        .join(', ');
}
