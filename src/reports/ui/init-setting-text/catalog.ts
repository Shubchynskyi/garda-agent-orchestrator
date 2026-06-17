import type { LocalUiLocalizedText } from '../ui-language-pack-loader';

export const INIT_SETTING_TEXT_IDS = Object.freeze([
    'AssistantLanguage',
    'AssistantBrevity',
    'SourceOfTruth',
    'ActiveAgentFiles',
    'EnforceNoAutoCommit',
    'ClaudeOrchestratorFullAccess',
    'TokenEconomyEnabled',
    'ProviderMinimalism',
    'OrchestratorVersion',
    'AssistantLanguageConfirmed',
    'ActiveAgentFilesConfirmed',
    'ProjectRulesUpdated',
    'SkillsPromptCompleted',
    'OrdinaryDocPathsConfirmed',
    'VerificationPassed',
    'ManifestValidationPassed',
    'LastSeededCompileGateCommand',
    'LastSeededFullSuiteCommand',
    'reinit',
    'agent-init'
] as const);

export type InitSettingTextId = typeof INIT_SETTING_TEXT_IDS[number];

export function buildInitSettingTextCatalog(): Readonly<Record<InitSettingTextId, LocalUiLocalizedText>> {
    return Object.freeze({
        AssistantLanguage: {
            label: 'Assistant language',
            description: 'Language the assistant should use with the operator.'
        },
        AssistantBrevity: {
            label: 'Assistant verbosity',
            description: 'How detailed normal assistant answers should be.'
        },
        SourceOfTruth: {
            label: 'Instruction owner',
            description: 'Canonical provider file that owns generated agent instructions.'
        },
        ActiveAgentFiles: {
            label: 'Active agent files',
            description: 'Agent entrypoint files currently included in this project.'
        },
        EnforceNoAutoCommit: {
            label: 'No automatic commits',
            description: 'Prevents agents from committing without explicit operator approval (at least it tries).'
        },
        ClaudeOrchestratorFullAccess: {
            label: 'Claude full access mode',
            description: 'Whether Claude-oriented instructions assume full orchestrator access.'
        },
        TokenEconomyEnabled: {
            label: 'Token economy',
            description: 'Keeps generated instructions compact and avoids unnecessary context.'
        },
        ProviderMinimalism: {
            label: 'Provider minimalism',
            description: 'Keeps non-canonical provider entrypoints as redirects when possible.'
        },
        OrchestratorVersion: {
            label: 'Orchestrator version',
            description: 'Garda version that wrote the state.'
        },
        AssistantLanguageConfirmed: {
            label: 'Language confirmed',
            description: 'Whether the assistant language checkpoint passed.'
        },
        ActiveAgentFilesConfirmed: {
            label: 'Agent files confirmed',
            description: 'Whether selected active agent files were explicitly confirmed.'
        },
        ProjectRulesUpdated: {
            label: 'Project rules updated',
            description: 'Whether project rules were reviewed or accepted during agent init.'
        },
        SkillsPromptCompleted: {
            label: 'Skills prompted',
            description: 'Whether the skills prompt checkpoint completed.'
        },
        OrdinaryDocPathsConfirmed: {
            label: 'Ordinary docs confirmed',
            description: 'Whether ordinary documentation paths were confirmed.'
        },
        VerificationPassed: {
            label: 'Verification passed',
            description: 'Whether post-init verification passed.'
        },
        ManifestValidationPassed: {
            label: 'Manifest valid',
            description: 'Whether protected control-plane manifest validation passed.'
        },
        LastSeededCompileGateCommand: {
            label: 'Seeded compile command',
            description: 'Compile/build/type-check command seeded into workflow config during initialization.'
        },
        LastSeededFullSuiteCommand: {
            label: 'Seeded full-suite command',
            description: 'Test command seeded into workflow config during initialization.'
        },
        reinit: {
            title: 'Re-initialize workspace',
            description: 'Re-materializes Garda generated files from the current init answers. Use it after changing initialization choices.'
        },
        'agent-init': {
            title: 'Agent prompt handoff',
            description: 'Give AGENT_INIT_PROMPT.md to the agent and ask it to complete the agent-init flow; the hard command only works after the agent has performed those checks.'
        }
    });
}

export function listInitSettingTextCatalogIds(
    catalog: Readonly<Record<string, LocalUiLocalizedText>> = buildInitSettingTextCatalog()
): string[] {
    return Object.keys(catalog).sort();
}
