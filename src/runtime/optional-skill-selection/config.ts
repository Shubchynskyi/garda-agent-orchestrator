import * as path from 'node:path';
import { pathExists } from '../../core/filesystem';
import { readJsonFile } from '../../core/json';
import { validateManagedConfigByName } from '../../schemas/config-artifacts';
import {
    type OptionalSkillSelectionPolicyConfig,
    DEFAULT_POLICY_CONFIG,
    toPortableBundlePath
} from './types';

export function readValidatedConfig(configPath: string): Record<string, unknown> {
    const raw = readJsonFile(configPath);
    return validateManagedConfigByName('optional-skill-selection-policy', raw);
}

export function isManagedConfigMapped(bundleRoot: string, configName: string): boolean {
    const rootConfigPath = path.join(bundleRoot, 'live', 'config', 'garda.config.json');
    if (!pathExists(rootConfigPath)) {
        return false;
    }
    try {
        const raw = readJsonFile(rootConfigPath) as Record<string, unknown>;
        const configs = raw.configs;
        if (!configs || typeof configs !== 'object' || Array.isArray(configs)) {
            return false;
        }
        const mappedPath = (configs as Record<string, unknown>)[configName];
        return typeof mappedPath === 'string' && mappedPath.trim().length > 0;
    } catch {
        return false;
    }
}

export function getOptionalSkillSelectionConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'optional-skill-selection-policy.json');
}

export function isOptionalSkillSelectionPolicyConfigured(bundleRoot: string): boolean {
    return isManagedConfigMapped(bundleRoot, 'optional-skill-selection-policy');
}

export function readOptionalSkillSelectionPolicyConfig(bundleRoot: string): OptionalSkillSelectionPolicyConfig {
    const configPath = getOptionalSkillSelectionConfigPath(bundleRoot);
    if (!pathExists(configPath)) {
        if (isOptionalSkillSelectionPolicyConfigured(bundleRoot)) {
            throw new Error(
                `Managed optional skill selection policy config is missing: ${toPortableBundlePath(bundleRoot, configPath)}`
            );
        }
        return { ...DEFAULT_POLICY_CONFIG };
    }

    const validated = readValidatedConfig(configPath) as Record<string, unknown>;
    return {
        version: Number(validated.version || DEFAULT_POLICY_CONFIG.version),
        mode: String(validated.mode || DEFAULT_POLICY_CONFIG.mode) as OptionalSkillSelectionPolicyConfig['mode']
    };
}
