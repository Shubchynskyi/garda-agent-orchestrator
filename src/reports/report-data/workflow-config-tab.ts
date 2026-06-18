import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildDefaultWorkflowConfig, type WorkflowConfigData } from '../../core/workflow-config';
import { joinOrchestratorPath, toPosix } from '../../gates/shared/helpers';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    WORKFLOW_SETTING_DEFINITIONS,
    getWorkflowSettingDefinition,
    type WorkflowSettingOption,
    type WorkflowSettingValueType
} from '../workflow-setting-metadata';
import { readJsonObject } from './shared';
import type { ReportDataUnavailableEntry, ReportWorkflowConfigTab, ReportWorkflowSetting } from './types';

const KNOWN_REVIEW_TYPES = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];
const FALLBACK_PROFILE_IDS = ['balanced', 'fast', 'strict', 'docs-only'];

function getConfigValue(config: WorkflowConfigData, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[part];
    }, config);
}

function getRawConfigValue(rawConfig: unknown, key: string): unknown {
    return key.split('.').reduce<unknown>((current, part) => {
        if (!current || typeof current !== 'object' || Array.isArray(current)) {
            return undefined;
        }
        return (current as Record<string, unknown>)[part];
    }, rawConfig);
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    const normalized: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const text = typeof entry === 'string' ? entry.trim() : '';
        if (!text) {
            continue;
        }
        const dedupeKey = text.toLowerCase();
        if (!seen.has(dedupeKey)) {
            seen.add(dedupeKey);
            normalized.push(text);
        }
    }
    return normalized;
}

function buildReviewTypeOptions(repoRoot: string, currentValue: unknown): WorkflowSettingOption[] {
    const capabilitiesPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'review-capabilities.json'));
    const capabilities = readJsonObject(capabilitiesPath);
    const configuredReviewTypes = capabilities
        ? Object.keys(capabilities).filter((key) => typeof capabilities[key] === 'boolean')
        : [];
    const reviewTypes = [...new Set([...KNOWN_REVIEW_TYPES, ...configuredReviewTypes])].sort((a, b) => {
        const leftIndex = KNOWN_REVIEW_TYPES.indexOf(a);
        const rightIndex = KNOWN_REVIEW_TYPES.indexOf(b);
        if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
                - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return a.localeCompare(b);
    });
    const options: WorkflowSettingOption[] = reviewTypes.map((reviewType) => {
        const capabilityValue = capabilities?.[reviewType];
        const capabilityText = capabilityValue === true
            ? 'enabled'
            : capabilityValue === false
                ? 'disabled'
                : 'not configured';
        return {
            value: reviewType,
            label: reviewType,
            description: `Known review contract key; capability is ${capabilityText}.`
        };
    });
    return appendUnknownCurrentValues(options, currentValue, 'Unknown legacy review type preserved from the current config.');
}

function buildProfileOptions(repoRoot: string, currentValue: unknown): WorkflowSettingOption[] {
    const profilesPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'profiles.json'));
    const profiles = readJsonObject(profilesPath);
    const builtInProfiles = profiles?.built_in_profiles && typeof profiles.built_in_profiles === 'object' && !Array.isArray(profiles.built_in_profiles)
        ? Object.keys(profiles.built_in_profiles as Record<string, unknown>)
        : [];
    const userProfiles = profiles?.user_profiles && typeof profiles.user_profiles === 'object' && !Array.isArray(profiles.user_profiles)
        ? Object.keys(profiles.user_profiles as Record<string, unknown>)
        : [];
    const profileIds = [...new Set([...FALLBACK_PROFILE_IDS, ...builtInProfiles, ...userProfiles])].sort((a, b) => {
        const leftIndex = FALLBACK_PROFILE_IDS.indexOf(a);
        const rightIndex = FALLBACK_PROFILE_IDS.indexOf(b);
        if (leftIndex !== -1 || rightIndex !== -1) {
            return (leftIndex === -1 ? Number.MAX_SAFE_INTEGER : leftIndex)
                - (rightIndex === -1 ? Number.MAX_SAFE_INTEGER : rightIndex);
        }
        return a.localeCompare(b);
    });
    const options: WorkflowSettingOption[] = profileIds.map((profileId) => ({
        value: profileId,
        label: profileId,
        description: builtInProfiles.includes(profileId)
            ? 'Configured built-in profile.'
            : userProfiles.includes(profileId)
                ? 'Configured user profile.'
                : 'Supported built-in profile fallback.'
    }));
    return appendUnknownCurrentValues(options, currentValue, 'Unknown legacy profile preserved from the current config.');
}

function appendUnknownCurrentValues(
    options: WorkflowSettingOption[],
    currentValue: unknown,
    description: string
): WorkflowSettingOption[] {
    const knownValues = new Set(options.map((option) => option.value));
    const knownValuesLower = new Set(options.map((option) => option.value.toLowerCase()));
    const unknownOptions = normalizeStringList(currentValue)
        .filter((value) => !knownValues.has(value) && !knownValuesLower.has(value.toLowerCase()))
        .map((value) => ({
            value,
            label: `${value} (legacy)`,
            description
        }));
    return unknownOptions.length > 0 ? [...options, ...unknownOptions] : options;
}

function buildWorkflowSettingOptions(repoRoot: string, key: string, currentValue: unknown, fallbackOptions: WorkflowSettingOption[]): WorkflowSettingOption[] {
    if (key === 'review_cycle_guard.excluded_review_types') {
        return buildReviewTypeOptions(repoRoot, currentValue);
    }
    if (key === 'scope_budget_guard.profiles') {
        return buildProfileOptions(repoRoot, currentValue);
    }
    return [...fallbackOptions];
}

function buildWorkflowCommand(
    flag: string,
    valueType: WorkflowSettingValueType,
    options: WorkflowSettingOption[],
    placeholder?: string
): string {
    const valueHint = flag === '--garda-self-guard'
        ? '<on|off>'
        : options.length > 0
        ? valueType === 'enum_list'
            ? `<comma-separated: ${options.map((option) => option.value).join('|')}>`
            : `<${options.map((option) => option.value).join('|')}>`
        : valueType === 'integer'
            ? '<number>'
            : valueType === 'string_list'
                ? '<comma-separated values>'
                : placeholder
                    ? `<${placeholder}>`
                    : '<value>';
    return [
        'garda workflow set',
        flag,
        valueHint,
        '--target-root "."',
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ].join(' ');
}

function resolveWorkflowSettingValue(
    config: WorkflowConfigData,
    rawConfig: unknown,
    definition: { key: string; value_type: WorkflowSettingValueType }
): unknown {
    const value = getConfigValue(config, definition.key);
    const rawValue = getRawConfigValue(rawConfig, definition.key);
    return definition.value_type === 'enum_list' && Array.isArray(rawValue)
        ? rawValue
        : value;
}

function buildWorkflowSetting(repoRoot: string, config: WorkflowConfigData, rawConfig: unknown, key: string): ReportWorkflowSetting {
    const definition = getWorkflowSettingDefinition(key);
    if (!definition) {
        throw new Error(`Missing local UI workflow setting metadata for ${key}.`);
    }
    const value = resolveWorkflowSettingValue(config, rawConfig, definition);
    const options = buildWorkflowSettingOptions(repoRoot, key, value, definition.options);
    return {
        id: definition.id,
        key,
        label: definition.label,
        value,
        value_type: definition.value_type,
        options,
        flag: definition.flag,
        command: buildWorkflowCommand(definition.flag, definition.value_type, options, definition.placeholder),
        description: definition.description,
        editable: definition.editable !== false,
        min: definition.min,
        max: definition.max,
        placeholder: definition.placeholder,
        readonly: true
    };
}

function buildWorkflowSettings(repoRoot: string, config: WorkflowConfigData, rawConfig: unknown = config): ReportWorkflowSetting[] {
    return WORKFLOW_SETTING_DEFINITIONS.map((definition) => buildWorkflowSetting(repoRoot, config, rawConfig, definition.key));
}

export function buildWorkflowConfigTab(repoRoot: string): ReportWorkflowConfigTab {
    const configPath = joinOrchestratorPath(path.resolve(repoRoot), path.join('live', 'config', 'workflow-config.json'));
    const unavailable: ReportDataUnavailableEntry[] = [];
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const config = buildDefaultWorkflowConfig();
        return {
            config_path: toPosix(configPath),
            config_exists: false,
            status: 'missing',
            settings: buildWorkflowSettings(repoRoot, config),
            unavailable: [{ scope: 'workflow-config', reason: 'Workflow config file missing; default values are shown.' }]
        };
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        const defaults = buildDefaultWorkflowConfig();
        const validated = validateWorkflowConfig(parsed) as Partial<WorkflowConfigData>;
        const config = {
            ...defaults,
            ...validated,
            compile_gate: validated.compile_gate ?? defaults.compile_gate
        } as WorkflowConfigData;
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'present',
            settings: buildWorkflowSettings(repoRoot, config, parsed),
            unavailable
        };
    } catch (error: unknown) {
        const config = buildDefaultWorkflowConfig();
        return {
            config_path: toPosix(configPath),
            config_exists: true,
            status: 'invalid',
            settings: buildWorkflowSettings(repoRoot, config),
            unavailable: [{
                scope: 'workflow-config',
                reason: error instanceof Error ? error.message : String(error)
            }]
        };
    }
}
