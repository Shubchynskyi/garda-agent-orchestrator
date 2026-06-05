import { MANAGED_CONFIG_NAMES } from '../core/constants';
import { normalizeNonEmptyString } from './shared';
import {
    validateIsolationModeConfig,
    validateOptionalSkillSelectionPolicyConfig,
    validateOutputFiltersConfig,
    validatePathsConfig,
    validateProfilesConfig,
    validateReviewArtifactStorageConfig,
    validateReviewCapabilitiesConfig,
    validateRuntimeRetentionConfig,
    validateSkillPacksConfig,
    validateTokenEconomyConfig
} from './config-artifacts-core';
import { validateWorkflowConfig } from './config-artifacts-workflow';

export * from './config-artifacts-core';
export * from './config-artifacts-workflow';

const MANAGED_CONFIG_VALIDATORS = Object.freeze({
    'review-capabilities': validateReviewCapabilitiesConfig,
    paths: validatePathsConfig,
    'token-economy': validateTokenEconomyConfig,
    'output-filters': validateOutputFiltersConfig,
    'skill-packs': validateSkillPacksConfig,
    'optional-skill-selection-policy': validateOptionalSkillSelectionPolicyConfig,
    'isolation-mode': validateIsolationModeConfig,
    profiles: validateProfilesConfig,
    'review-artifact-storage': validateReviewArtifactStorageConfig,
    'runtime-retention': validateRuntimeRetentionConfig,
    'workflow-config': validateWorkflowConfig
});

function normalizeManagedConfigName(configName: unknown): string {
    const normalized = normalizeNonEmptyString(configName, 'configName').toLowerCase();
    const match = MANAGED_CONFIG_NAMES.find((candidate) => candidate.toLowerCase() === normalized);

    if (!match) {
        throw new Error(`Unsupported managed config '${configName}'.`);
    }

    return match;
}

export function validateManagedConfigByName(configName: unknown, input: unknown): Record<string, unknown> {
    const normalizedName = normalizeManagedConfigName(configName);
    const validators = MANAGED_CONFIG_VALIDATORS as Record<string, (input: unknown) => Record<string, unknown>>;
    return validators[normalizedName](input);
}

export function getManagedConfigValidators() {
    return MANAGED_CONFIG_VALIDATORS;
}
