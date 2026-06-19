import { buildWorkflowConfigTab } from '../../report-data-contract';
import {
    WORKFLOW_SETTING_DEFINITIONS,
    type WorkflowSettingOption,
    type WorkflowSettingValueType
} from '../../workflow-setting-metadata';
import { UI_ACTION_DEFAULT_TIMEOUT_MS, buildUiActionCommand } from './action-common';
import type { ParsedUiSettingValue, UiActionDefinition, UiSettingDefinition } from './types';

const UI_SETTING_CONFIRMATION_PHRASE = 'APPLY GARDA SETTING';

export function buildUiSettingDefinitions(repoRoot: string): UiSettingDefinition[] {
    const settings = buildWorkflowConfigTab(repoRoot).settings;
    return WORKFLOW_SETTING_DEFINITIONS
        .filter((definition) => definition.editable !== false)
        .map((definition) => {
            const reportSetting = settings.find((setting) => setting.key === definition.key);
            return {
                ...definition,
                options: reportSetting?.options ?? definition.options,
                current_value: reportSetting?.value,
                confirmation_phrase: UI_SETTING_CONFIRMATION_PHRASE,
                readiness: reportSetting?.readiness
            };
        });
}

export function findSetting(settings: UiSettingDefinition[], settingId: unknown): UiSettingDefinition | null {
    if (typeof settingId !== 'string') {
        return null;
    }
    return settings.find((setting) => setting.id === settingId) || null;
}

function normalizeEnumListValue(value: unknown): string[] {
    const rawValues = Array.isArray(value)
        ? value
        : typeof value === 'number'
            ? [String(value)]
            : typeof value === 'string'
                ? value.split(',')
                : [];
    return [...new Set(rawValues
        .map((entry) => typeof entry === 'string' ? entry.trim() : '')
        .filter(Boolean))];
}

export function parseUiSettingValue(setting: UiSettingDefinition, value: unknown): ParsedUiSettingValue {
    const raw = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (setting.value_type === 'integer') {
        if (!/^\d+$/u.test(raw)) {
            throw new Error(`${setting.label} must be an integer.`);
        }
        const parsed = Number(raw);
        const min = setting.min ?? 1;
        const max = setting.max ?? Number.MAX_SAFE_INTEGER;
        if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
            throw new Error(`${setting.label} must be an integer from ${min} to ${max}.`);
        }
        return {
            command_value: String(parsed),
            proposed_value: parsed
        };
    }
    if (setting.value_type === 'boolean') {
        const normalized = raw.toLowerCase();
        if (!['true', 'false', 'on', 'off', 'yes', 'no', '1', '0'].includes(normalized)) {
            throw new Error(`${setting.label} must be on or off.`);
        }
        const enabled = ['true', 'on', 'yes', '1'].includes(normalized);
        return {
            command_value: String(enabled),
            proposed_value: enabled
        };
    }
    if (setting.value_type === 'enum') {
        const option = setting.options.find((candidate) => candidate.value === raw);
        if (!option) {
            throw new Error(`${setting.label} must be one of: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: option.value,
            proposed_value: option.value
        };
    }
    if (setting.value_type === 'enum_list') {
        const values = normalizeEnumListValue(value);
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        const allowedValues = new Set(setting.options.map((candidate) => candidate.value));
        const invalidValues = values.filter((entry) => !allowedValues.has(entry));
        if (invalidValues.length > 0) {
            throw new Error(`${setting.label} contains unsupported value(s): ${invalidValues.join(', ')}. Allowed values: ${setting.options.map((candidate) => candidate.value).join(', ')}.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (setting.value_type === 'string_list') {
        const values = [...new Set(raw.split(',').map((entry) => entry.trim()).filter(Boolean))];
        if (values.length === 0) {
            throw new Error(`${setting.label} must contain at least one value.`);
        }
        return {
            command_value: values.join(','),
            proposed_value: values
        };
    }
    if (!raw) {
        throw new Error(`${setting.label} must not be empty.`);
    }
    return {
        command_value: raw,
        proposed_value: raw
    };
}

function buildUiSettingCommand(
    repoRoot: string,
    setting: UiSettingDefinition,
    commandValue: string,
    timestampUtc: string
): ReturnType<typeof buildUiActionCommand> {
    const args = [
        'workflow',
        'set',
        setting.flag,
        commandValue,
        '--target-root',
        repoRoot,
        '--operator-confirmed',
        'yes',
        '--operator-confirmed-at-utc',
        timestampUtc
    ];
    return buildUiActionCommand(repoRoot, args);
}

export function buildUiSettingAction(
    repoRoot: string,
    setting: UiSettingDefinition,
    commandValue: string,
    timestampUtc: string
): UiActionDefinition {
    return {
        id: `setting:${setting.id}`,
        category: 'Workflow Config',
        label: setting.label,
        description: setting.description,
        mutates: true,
        enabled: true,
        unavailable_reason: null,
        requires_confirmation: true,
        confirmation_phrase: setting.confirmation_phrase,
        timeout_ms: UI_ACTION_DEFAULT_TIMEOUT_MS,
        command: buildUiSettingCommand(repoRoot, setting, commandValue, timestampUtc)
    };
}

export type { WorkflowSettingOption, WorkflowSettingValueType };
