import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName } from '../../../core/constants';
import { validateProfilesConfig } from '../../../schemas/config-artifacts';
import { normalizePathValue } from '../cli-helpers';
import { ParsedOptionsRecord, ProfileEntry, ProfilesData } from './profile-types';

export function resolveBundleRoot(options: ParsedOptionsRecord): { targetRoot: string; bundleRoot: string } {
    const targetRoot = normalizePathValue(typeof options.targetRoot === 'string' ? options.targetRoot : '.');
    const bundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : path.join(targetRoot, resolveBundleName());
    return { targetRoot, bundleRoot };
}

export function resolveProfilesPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'profiles.json');
}

export function readProfilesData(profilesPath: string): ProfilesData {
    if (!fs.existsSync(profilesPath)) {
        throw new Error(`Profiles config not found: ${profilesPath}`);
    }
    const raw = fs.readFileSync(profilesPath, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const validated = validateProfilesConfig(parsed) as unknown as ProfilesData;
    return validated;
}

export function writeProfilesData(profilesPath: string, data: ProfilesData): void {
    fs.writeFileSync(profilesPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

export function isBuiltInProfile(data: ProfilesData, name: string): boolean {
    return Object.hasOwn(data.built_in_profiles, name);
}

export function getAllProfileNames(data: ProfilesData): string[] {
    return [
        ...Object.keys(data.built_in_profiles),
        ...Object.keys(data.user_profiles)
    ];
}

export function getProfileEntry(data: ProfilesData, name: string): ProfileEntry | null {
    if (Object.hasOwn(data.built_in_profiles, name)) return data.built_in_profiles[name];
    if (Object.hasOwn(data.user_profiles, name)) return data.user_profiles[name];
    return null;
}
