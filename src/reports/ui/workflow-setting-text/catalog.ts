import { WORKFLOW_SETTING_DEFINITIONS } from '../../workflow-setting-metadata';
import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const COMPILE_GATE_COMMAND_FALLBACK_SETTING_ID = 'compile-gate-command-fallback';

const COMPILE_GATE_COMMAND_FALLBACK_TEXT: LocalUiLocalizedText = Object.freeze({
    description: 'Not set in workflow-config; compile-gate fails closed until a project-specific command is configured.'
});

export function buildWorkflowSettingTextCatalog(): Readonly<Record<string, LocalUiLocalizedText>> {
    const catalog: Record<string, LocalUiLocalizedText> = {
        [COMPILE_GATE_COMMAND_FALLBACK_SETTING_ID]: COMPILE_GATE_COMMAND_FALLBACK_TEXT
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
