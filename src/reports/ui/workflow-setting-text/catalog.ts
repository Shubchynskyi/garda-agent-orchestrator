import { WORKFLOW_SETTING_DEFINITIONS } from '../../workflow-setting-metadata';
import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const COMPILE_GATE_COMMAND_FALLBACK_SETTING_ID = 'compile-gate-command-fallback';
export const OPTIONAL_CHECK_RULE_MANAGEMENT_SETTING_ID = 'optional-check-rule-management';

const COMPILE_GATE_COMMAND_FALLBACK_TEXT: LocalUiLocalizedText = Object.freeze({
    description: 'Not set in workflow-config; compile-gate fails closed until a project-specific command is configured.'
});

const OPTIONAL_CHECK_RULE_MANAGEMENT_TEXT: LocalUiLocalizedText = Object.freeze({
    label: 'Optional quality-check rule',
    description: 'Adds, updates, or removes one advisory optional quality-check rule through the audited workflow-setting path.'
});

export function buildWorkflowSettingTextCatalog(): Readonly<Record<string, LocalUiLocalizedText>> {
    const catalog: Record<string, LocalUiLocalizedText> = {
        [COMPILE_GATE_COMMAND_FALLBACK_SETTING_ID]: COMPILE_GATE_COMMAND_FALLBACK_TEXT,
        [OPTIONAL_CHECK_RULE_MANAGEMENT_SETTING_ID]: OPTIONAL_CHECK_RULE_MANAGEMENT_TEXT
    };

    for (const definition of WORKFLOW_SETTING_DEFINITIONS) {
        const entry: LocalUiLocalizedText = {
            label: definition.label,
            description: definition.description
        };
        if (definition.options.length > 0) {
            entry.options = {};
            for (const option of definition.options) {
                entry.options[option.value] = {
                    label: option.label,
                    description: option.description
                };
            }
        }
        catalog[definition.id] = Object.freeze(entry);
    }

    return Object.freeze(catalog);
}

export function listWorkflowSettingTextCatalogIds(catalog: Readonly<Record<string, LocalUiLocalizedText>>): string[] {
    return Object.keys(catalog).sort();
}
