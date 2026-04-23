import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/fs';
import { getBundlePath } from './workspace-layout';

export interface ProfileHealthEvidence {
    passed: boolean;
    active_profile: string | null;
    profile_source: 'built_in' | 'user' | null;
    config_path: string;
    config_exists: boolean;
    profile_count: number;
    violations: string[];
}

export function checkProfileHealth(targetRoot: string): ProfileHealthEvidence {
    const bundlePath = getBundlePath(targetRoot);
    const configPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    const violations: string[] = [];
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let profileCount = 0;
    let configExists = false;

    if (!pathExists(configPath)) {
        violations.push('Profiles config not found: ' + configPath.replace(/\\/g, '/'));
        return { passed: false, active_profile: null, profile_source: null, config_path: configPath.replace(/\\/g, '/'), config_exists: false, profile_count: 0, violations };
    }
    configExists = true;

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const builtIn = raw.built_in_profiles && typeof raw.built_in_profiles === 'object' && !Array.isArray(raw.built_in_profiles)
            ? raw.built_in_profiles as Record<string, unknown> : {};
        const user = raw.user_profiles && typeof raw.user_profiles === 'object' && !Array.isArray(raw.user_profiles)
            ? raw.user_profiles as Record<string, unknown> : {};
        profileCount = Object.keys(builtIn).length + Object.keys(user).length;

        if (typeof raw.active_profile !== 'string' || !raw.active_profile.trim()) {
            violations.push('Profiles config has no active_profile set.');
        } else {
            activeProfile = raw.active_profile.trim();
            if (Object.hasOwn(builtIn, activeProfile)) {
                profileSource = 'built_in';
            } else if (Object.hasOwn(user, activeProfile)) {
                profileSource = 'user';
            } else {
                violations.push('Active profile \'' + activeProfile + '\' does not match any defined profile.');
            }
        }

        if (Object.keys(builtIn).length === 0) {
            violations.push('At least one built-in profile is required.');
        }
    } catch (err: unknown) {
        violations.push('Profiles config is invalid JSON: ' + getErrorMessage(err));
    }

    return {
        passed: violations.length === 0,
        active_profile: activeProfile,
        profile_source: profileSource,
        config_path: configPath.replace(/\\/g, '/'),
        config_exists: configExists,
        profile_count: profileCount,
        violations
    };
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
