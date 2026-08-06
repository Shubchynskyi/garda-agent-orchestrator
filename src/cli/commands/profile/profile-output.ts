import * as path from 'node:path';
import { padRight } from '../cli-helpers';
import { readReviewCapabilitiesConfigFile } from '../../../core/review-capabilities';
import { readReviewCatalogConfigFile } from '../../../core/review-catalog';
import {
    analyzeProfileReviewCatalogPolicy,
    resolveConfigPaths,
    resolveProfileReviewCatalogPolicy,
    type ResolvedProfileReviewCatalogPolicy
} from '../../../policy/profile-resolver';
import { loadReviewTriggerPolicy } from '../../../policy/review-trigger-policy';
import {
    getAllProfileNames,
    getProfileEntry,
    isBuiltInProfile,
    resolveProfilesPath
} from './profile-data';
import { ProfileEntry, ProfilesData } from './profile-types';

type ProfileReviewCatalogPolicyOutput = ResolvedProfileReviewCatalogPolicy & {
    validation_issues?: readonly string[];
};

function buildProfileReviewCatalogPolicies(
    data: ProfilesData,
    bundleRoot: string
): Record<string, ProfileReviewCatalogPolicyOutput> {
    const configPaths = resolveConfigPaths(bundleRoot);
    const catalog = readReviewCatalogConfigFile(configPaths.reviewCatalog);
    const capabilities = readReviewCapabilitiesConfigFile(configPaths.reviewCapabilities);
    return Object.fromEntries(
        [...Object.entries(data.built_in_profiles), ...Object.entries(data.user_profiles)]
            .map(([name, entry]) => {
                const analysis = analyzeProfileReviewCatalogPolicy(
                    name,
                    entry.review_policy,
                    capabilities,
                    catalog
                );
                return [
                    name,
                    analysis.issues.length === 0
                        ? analysis.policy
                        : { ...analysis.policy, validation_issues: analysis.issues }
                ];
            })
    );
}

function buildProfileReviewCatalogPolicy(
    profileName: string,
    entry: ProfileEntry,
    bundleRoot: string
): ResolvedProfileReviewCatalogPolicy {
    const configPaths = resolveConfigPaths(bundleRoot);
    const catalog = readReviewCatalogConfigFile(configPaths.reviewCatalog);
    const capabilities = readReviewCapabilitiesConfigFile(configPaths.reviewCapabilities);
    return resolveProfileReviewCatalogPolicy(
        profileName,
        entry.review_policy,
        capabilities,
        catalog
    );
}

function formatCatalogLaneSummary(policy: ProfileReviewCatalogPolicyOutput): string {
    const active = policy.lanes
        .filter((lane) => lane.active)
        .map((lane) => `${lane.id}(${lane.state})`);
    const inactive = policy.lanes
        .filter((lane) => !lane.active)
        .map((lane) => `${lane.id}(${lane.state}:${lane.inactive_reason})`);
    const laneSummary = `active=[${active.join(', ') || 'none'}]; inactive=[${inactive.join(', ') || 'none'}]`;
    return policy.validation_issues?.length
        ? `validation=[${policy.validation_issues.join(' | ')}]; ${laneSummary}`
        : laneSummary;
}

export function buildProfileListOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    const catalogPolicies = buildProfileReviewCatalogPolicies(data, bundleRoot);
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            built_in_profiles: Object.keys(data.built_in_profiles),
            user_profiles: Object.keys(data.user_profiles),
            profile_review_catalog_policies: catalogPolicies,
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
    lines.push('');
    lines.push('Review Catalog Lanes');
    for (const name of getAllProfileNames(data)) {
        lines.push(`  ${name}: ${formatCatalogLaneSummary(catalogPolicies[name])}`);
    }
    return lines.join('\n');
}

export function buildProfileCurrentOutput(data: ProfilesData, bundleRoot: string, jsonMode: boolean): string {
    const entry = getProfileEntry(data, data.active_profile);
    if (!entry) {
        throw new Error(`Active profile '${data.active_profile}' was not found.`);
    }
    const catalogPolicy = buildProfileReviewCatalogPolicy(data.active_profile, entry, bundleRoot);
    const reviewTriggerPolicy = loadReviewTriggerPolicy(path.join(bundleRoot, 'live', 'config', 'paths.json'));
    if (jsonMode) {
        return JSON.stringify({
            active_profile: data.active_profile,
            is_built_in: isBuiltInProfile(data, data.active_profile),
            entry: entry,
            review_catalog_policy: catalogPolicy,
            review_trigger_policy: reviewTriggerPolicy,
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
        lines.push(`ReviewCatalogPolicy: ${formatCatalogLaneSummary(catalogPolicy)}`);
        lines.push(`ReviewCatalogPolicySha256: ${catalogPolicy.policy_sha256}`);
        lines.push(`ReviewFindingPolicy: ${formatReviewFindingPolicy(entry.review_finding_policy)}`);
        lines.push(`ReviewFollowUpPolicy: ${formatReviewFollowUpPolicy(entry.review_follow_up_policy)}`);
        lines.push(`TokenEconomy: ${formatTokenEconomy(entry.token_economy)}`);
        lines.push(`Skills: ${formatSkills(entry.skills)}`);
        lines.push(`ReviewTriggerPolicy: ${formatReviewTriggerPolicy(reviewTriggerPolicy)}`);
        lines.push('Why: Active profile settings are used by default.');
    }
    lines.push('Tip: run "profile list" to inspect all available profiles.');
    return lines.join('\n');
}

function formatReviewTriggerPolicy(policy: ReturnType<typeof loadReviewTriggerPolicy>): string {
    return [
        `refactor_patterns=${policy.refactor_path_regexes.length}`,
        `test_patterns=${policy.test_path_regexes.length}`,
        `structural_test_patterns=${policy.test_refactor_structural_path_regexes.length}`,
        `changed_lines_threshold=${policy.test_refactor_changed_lines_threshold}`
    ].join(', ');
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

function formatReviewFindingPolicy(policy: ProfileEntry['review_finding_policy']): string {
    if (!policy) {
        return 'legacy_missing=fail_closed_to_strict';
    }
    return [
        `policy_id=${policy.policy_id}`,
        `critical=${policy.findings.critical}`,
        `high=${policy.findings.high}`,
        `medium=${policy.findings.medium}`,
        `low=${policy.findings.low}`,
        `residual_risk=${policy.residual_risk}`
    ].join(', ');
}

function formatReviewFollowUpPolicy(policy: ProfileEntry['review_follow_up_policy']): string {
    return policy ? `materialization_mode=${policy.materialization_mode}` : 'legacy_missing=per_finding';
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
