export interface PackageJsonLike {
    name: string;
    version: string;
    [key: string]: unknown;
}

export interface HighlightedPairOptions {
    labelColor?: (text: string) => string;
    valueColor?: (text: string) => string;
    indent?: string;
}

export interface PromptSingleSelectOption {
    label: string;
    value: string;
}

export interface PromptSingleSelectConfig {
    title: string;
    defaultLabel: string;
    options: PromptSingleSelectOption[];
    defaultValue: string;
}

export interface StatusSnapshot {
    targetRoot: string;
    bundlePath: string;
    initAnswersResolvedPath: string;
    collectedVia: string | null;
    activeAgentFiles: string | null;
    assistantLanguage: string | null;
    assistantLanguageConfirmed: boolean | null;
    sourceOfTruth: string | null;
    canonicalEntrypoint: string | null;
    bundlePresent: boolean;
    primaryInitializationComplete: boolean;
    agentInitializationComplete: boolean;
    readyForTasks: boolean;
    agentInitializationPendingReason:
        | 'AGENT_HANDOFF_REQUIRED'
        | 'LANGUAGE_CONFIRMATION_PENDING'
        | 'ACTIVE_AGENT_FILES_PENDING'
        | 'AGENT_STATE_STALE'
        | 'PROJECT_RULES_PENDING'
        | 'SKILLS_PROMPT_PENDING'
        | 'ORDINARY_DOC_PATHS_PENDING'
        | 'PROJECT_MEMORY_PENDING'
        | 'VALIDATION_PENDING'
        | 'AGENT_STATE_INVALID'
        | 'PROJECT_COMMANDS_PENDING'
        | null;
    missingProjectCommands: string[];
    initAnswersError: string | null;
    liveVersionError: string | null;
    agentInitStateError: string | null;
    commandsRulePath: string;
    recommendedNextCommand: string;
    parityResult: {
        isSourceCheckout: boolean;
        isStale: boolean;
        violations: string[];
        remediation: string | null;
    };
    activeProfile: string | null;
    mandatoryFullSuiteEnabled: boolean | null;
    latestUpdateNotice: string | null;
}
