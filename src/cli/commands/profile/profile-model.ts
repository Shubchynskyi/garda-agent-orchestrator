import { getAllProfileNames, getProfileEntry } from './profile-data';
import { ProfileEntry, ProfilesData } from './profile-types';

export const KNOWN_REVIEW_TYPES = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
]);

export const TOKEN_ECONOMY_FIELDS = Object.freeze([
    'enabled',
    'strip_examples',
    'strip_code_blocks',
    'scoped_diffs',
    'compact_reviewer_output'
]);

const PROFILE_NAME_PATTERN = /^\p{L}(?:[\p{L}\p{Nd}-]*[\p{L}\p{Nd}])?$/u;
const PROFILE_NAME_UPPERCASE_PATTERN = /[\p{Lu}\p{Lt}]/u;

export function validateProfilesIntegrity(data: ProfilesData): string[] {
    const issues: string[] = [];
    const allNames = getAllProfileNames(data);
    if (allNames.length === 0) {
        issues.push('No profiles defined.');
    }
    if (!getProfileEntry(data, data.active_profile)) {
        issues.push(`Active profile '${data.active_profile}' does not match any defined profile.`);
    }
    if (Object.keys(data.built_in_profiles).length === 0) {
        issues.push('At least one built-in profile is required.');
    }
    for (const name of Object.keys(data.user_profiles)) {
        if (Object.hasOwn(data.built_in_profiles, name)) {
            issues.push(`User profile '${name}' conflicts with a built-in profile name.`);
        }
    }
    for (const name of allNames) {
        const entry = getProfileEntry(data, name)!;
        if (entry.depth < 1 || entry.depth > 3) {
            issues.push(`Profile '${name}' has invalid depth ${entry.depth}; must be 1–3.`);
        }
    }
    return issues;
}

export function assertValidProfileName(name: string): void {
    if (!PROFILE_NAME_PATTERN.test(name) || PROFILE_NAME_UPPERCASE_PATTERN.test(name) || Array.from(name).length > 64) {
        throw new Error(
            `Invalid profile name '${name}'. ` +
            'Profile names must start with a lowercase or uncased Unicode letter, contain only lowercase or uncased Unicode letters, digits, and hyphens, ' +
            'must not end with a hyphen, and be 1–64 characters.'
        );
    }
}

export function parseStrictDepth(value: string): number {
    if (!/^[123]$/.test(value.trim())) {
        throw new Error('--depth must be 1, 2, or 3.');
    }
    return Number(value.trim());
}

export function normalizeReviewPromptValue(value: boolean | 'auto' | undefined): boolean | 'auto' {
    return value === true || value === false ? value : 'auto';
}

export function cloneProfileEntry(entry: ProfileEntry): ProfileEntry {
    return JSON.parse(JSON.stringify(entry)) as ProfileEntry;
}

export function buildDefaultProfileEntry(description: string, depth: number): ProfileEntry {
    return {
        description,
        depth,
        review_policy: {
            code: true,
            db: 'auto',
            security: 'auto',
            refactor: 'auto',
            api: 'auto',
            test: 'auto',
            performance: 'auto',
            infra: 'auto',
            dependency: 'auto'
        },
        token_economy: { enabled: true, strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true },
        skills: { auto_suggest: true }
    };
}

export function buildPromptReadyProfileEntry(entry: ProfileEntry): ProfileEntry {
    const baseline = buildDefaultProfileEntry(entry.description, entry.depth);
    return {
        description: entry.description,
        depth: entry.depth,
        review_policy: {
            ...baseline.review_policy,
            ...entry.review_policy
        },
        token_economy: {
            ...baseline.token_economy,
            ...entry.token_economy
        },
        skills: {
            ...baseline.skills,
            ...entry.skills
        }
    };
}

export function buildSuggestedProfileName(data: ProfilesData): string {
    const base = 'custom-profile';
    let candidate = base;
    let suffix = 2;
    while (getProfileEntry(data, candidate)) {
        candidate = `${base}-${suffix}`;
        suffix += 1;
    }
    return candidate;
}
