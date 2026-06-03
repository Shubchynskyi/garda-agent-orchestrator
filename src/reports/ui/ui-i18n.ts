import {
    loadImportedUiLanguagePacks,
    type ImportedUiLanguagePack,
    type LocalUiLocalizedText,
    type UiLanguagePackDescriptor
} from './ui-language-pack-loader';

export type { LocalUiLocalizedText };

export const DEFAULT_LOCAL_UI_LANGUAGE = 'en';

const CORE_LOCAL_UI_LANGUAGES = Object.freeze([
    { id: 'en', label: 'English', nativeLabel: 'English' }
] as const satisfies readonly UiLanguagePackDescriptor[]);

export type LocalUiLanguage = typeof CORE_LOCAL_UI_LANGUAGES[number]['id'] | string;

const ENGLISH_LOCAL_UI_TEXT = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Loading workspace report...',
    tasksTab: 'Tasks',
    workflowTab: 'Workflow Config',
    initSettingsTab: 'Init settings',
    projectMemoryTab: 'Project memory',
    backupsTab: 'Backups',
    backupsTabIntro: 'Lists rollback snapshots from the backup inventory. Guarded restore and auto-backup edits require `garda ui --actions`.',
    backupsInventoryTitle: 'Backup inventory',
    backupsEmpty: 'No backups in inventory.',
    backupsSnapshotsRoot: 'Snapshots root',
    backupRootPresent: 'present',
    backupRootMissing: 'missing',
    backupIdColumn: 'ID',
    backupCreatedColumn: 'Created',
    backupSizeColumn: 'Size',
    backupReasonColumn: 'Reason',
    backupStatusColumn: 'Health',
    backupRestoreColumn: 'Restore',
    backupReasonUpdate: 'update',
    backupReasonScheduled: 'scheduled',
    backupsActionsDisabled: 'Controlled actions are disabled.',
    backupRestoreUnavailable: 'Restore unavailable for this backup.',
    restoreBackup: 'Restore backup',
    backupsAutoBackupTitle: 'Auto-backup',
    backupAutoEnabled: 'Enabled',
    backupAutoIntervalDays: 'Interval (days)',
    backupAutoKeepLatest: 'Keep latest',
    backupsAutoBackupHelp: 'Scheduled auto-backups use audited workflow settings. Preview shows the exact command before saving.',
    backupsRestorePreviewHelp: 'Choose a backup and click Preview command to see the guarded restore command before running it.',
    instructionsTab: 'Instructions',
    actionsTab: 'Actions',
    noticeActionsEnabled: 'Task details are loaded on demand from the local server. The server is bound to 127.0.0.1 and stops when this CLI process exits. Controlled actions are enabled for allow-listed commands only.',
    noticeActionsDisabled: 'Task details are loaded on demand from the local server. The server is bound to 127.0.0.1 and stops when this CLI process exits. Controlled actions are disabled unless the server starts with --actions.',
    languageTitle: 'Language',
    languageHelp: 'UI language is local to this browser page. Commands, task IDs, config keys, enum values, file paths, and raw outputs stay unchanged.',
    serverStatusTitle: 'Server Status',
    loadingServerSession: 'Loading server session...',
    iAmHere: "I'm here",
    stopServer: 'Stop server',
    serverStoppedRerun: 'When this server stops, the page cannot relaunch it. Rerun',
    serverStoppedRerunTail: 'in a terminal.',
    gardaSwitchTitle: 'Garda switch',
    gardaSwitchState: 'State',
    gardaSwitchStateOn: 'On',
    gardaSwitchStateOff: 'Off',
    gardaSwitchStateUnknown: 'Unknown',
    gardaSwitchHelp: 'Turns root Garda instruction surfaces on or off for this workspace.',
    gardaSwitchActionsDisabled: 'Start with controlled actions to switch from this page:',
    gardaSwitchUnknownHelp: 'The switch state is unknown; choose the intended command after checking the workspace.',
    gardaSwitchUnavailable: 'Switch action is hidden until the current Garda state is known.',
    turnGardaOn: 'Turn on',
    turnGardaOff: 'Turn off',
    searchTasks: 'Search tasks',
    allStatuses: 'All statuses',
    allPriorities: 'All priorities',
    idColumn: 'ID',
    statusColumn: 'Status',
    priorityColumn: 'Priority',
    areaColumn: 'Area',
    titleColumn: 'Title',
    actionColumn: 'Action',
    dataColumn: 'Data',
    loading: 'Loading...',
    taskDetailTitle: 'Task Detail',
    chooseTask: 'Choose a task and click Load details.',
    dataCompact: 'Compact',
    dataFull: 'Full',
    dataOnDemand: 'On demand',
    dataBlockers: 'Blockers',
    compactDetailState: 'Closed task shown from the queue row; load details to inspect archived artifacts.',
    onDemandDetailState: 'Open task shown from TASK.md; load details when you need runtime events or artifacts.',
    fullDetailState: 'Full task artifacts loaded from the local server.',
    blockerDetailState: 'TASK.md marks this task as blocked.',
    runtimeDiagnosticsTitle: 'Runtime diagnostics',
    noRuntimeDiagnostics: 'No runtime diagnostics reported.',
    taskActionsTitle: 'Task commands',
    taskActionsHelp: 'Task-specific commands are shown here so the Actions tab stays focused on workspace maintenance.',
    taskCommandNextStep: 'Next lifecycle step',
    taskCommandStats: 'Task stats',
    taskCommandEvents: 'Task events',
    taskCommandReset: 'Reset task',
    taskCommandNextStepDescription: 'Asks Garda for the next required lifecycle step for this task. It can advance workflow state and requires confirmation.',
    taskCommandResetDescription: 'Reopens this task through the guarded task-reset gate. Requires task-reset to be enabled and a typed confirmation.',
    taskCommandStatsDescription: 'Shows focused counters and runtime summary for this task.',
    taskCommandEventsDescription: 'Shows the task event timeline used by gate summaries.',
    taskCommandPreviewHelp: 'Running next-step requires confirmation.',
    taskCommandUnavailable: 'Start with `garda ui --actions` to run task commands from this page.',
    taskResetUnavailable: 'Task reset is disabled. Enable workflow setting task_reset.enabled before running a confirmed reset.',
    showTaskPlan: 'Show plan',
    taskPlanTitle: 'Task plan',
    planPath: 'Plan path',
    planMetadataOnly: 'Plan metadata exists, but the markdown plan file is not available.',
    close: 'Close',
    taskQueueStatus: 'Queue status',
    overviewTasks: 'Tasks',
    overviewActive: 'Active',
    overviewDone: 'Done',
    overviewBlocked: 'Blocked',
    overviewWarnings: 'Warnings',
    metaRepo: 'Repo',
    metaTasks: 'Tasks',
    metaWarnings: 'Warnings',
    warningsTitle: 'Warnings',
    noMatchingTasks: 'No matching tasks.',
    loadDetails: 'Load details',
    noWorkflowSettings: 'No workflow settings available.',
    initBlockTitle: 'Init',
    agentInitBlockTitle: 'Agent init',
    initCommandsTitle: 'Init commands',
    initStatusPresent: 'Loaded',
    initStatusMissing: 'File missing',
    initStatusInvalid: 'File invalid',
    fieldColumn: 'Field',
    valueColumn: 'Value',
    noInitSettings: 'No settings available.',
    projectMemoryStatusTitle: 'Project memory status',
    projectMemoryFilesTitle: 'Project memory files',
    fileColumn: 'File',
    purposeColumn: 'Purpose',
    sizeColumn: 'Size',
    openColumn: 'Open',
    openMemoryFile: 'Open',
    noProjectMemoryFiles: 'No project memory files available.',
    workflowConfigPath: 'Config file',
    workflowStatus: 'Config state',
    workflowStatusPresent: 'Config loaded. Warnings are shown here only when the file cannot be read or parsed.',
    workflowStatusMissing: 'File missing; defaults shown',
    workflowStatusInvalid: 'File invalid; defaults shown',
    workflowWarningTitle: 'Config problem',
    workflowCommandPreview: 'Command preview',
    workflowCommandPreviewHelp: 'Choose a setting and click Preview command to see the exact audited command here before saving.',
    actionsPreviewHelp: 'Choose an action and click Preview command to see the exact allow-listed command here before running it.',
    resultStatusPreviewed: 'Preview only',
    resultStatusExecuted: 'Applied',
    resultStatusConfirmationRequired: 'Confirmation required',
    resultStatusDisabled: 'Disabled',
    resultStatusUnavailable: 'Unavailable',
    workflowGroupValidation: 'Validation and test lifecycle',
    workflowGroupReview: 'Review flow',
    workflowGroupScope: 'Scope limits',
    workflowGroupMemory: 'Project memory',
    workflowGroupSafety: 'Protected controls',
    configSettingColumn: 'Setting',
    descriptionColumn: 'Description',
    currentValueColumn: 'Current value',
    optionsColumn: 'Options',
    changeColumn: 'Change',
    noFixedOptions: 'No fixed options',
    freeValueHelp: 'Enter a value that matches the description.',
    reviewCycleAutoSplitDependency: 'Auto-split only affects blocking mode: review_cycle_guard.action must be BLOCK_FOR_OPERATOR_DECISION. When the action is WARN_ONLY, this setting is informational.',
    minutesLabel: 'Minutes',
    secondsLabel: 'Seconds',
    durationStoredAsMs: 'Saved as milliseconds for Garda.',
    commandColumn: 'Command',
    actionEffectColumn: 'Effect',
    actionRunColumn: 'Run',
    instructionAreaColumn: 'Area',
    instructionDescriptionColumn: 'Description',
    guardedEditor: 'Guarded editor',
    guardedEditorHelp: 'Changes use audited `garda workflow set` commands. Preview shows the exact command; Save requires confirmation.',
    settingEditsDisabled: 'Setting edits are disabled. Restart with',
    settingEditsDisabledTail: 'to enable audited workflow commands.',
    noEditableSettings: 'No editable safe settings available.',
    current: 'Current',
    newValue: 'New value',
    parameter: 'Parameter',
    availableOptions: 'Options',
    noOptions: 'No fixed options; enter a value that matches the field description.',
    save: 'Save',
    saveDisabled: 'Save disabled',
    settingReadonly: 'Read-only from this page',
    preview: 'Preview',
    previewCommand: 'Preview command',
    apply: 'Apply',
    typeToApplySetting: 'Type',
    typeToApplySettingTail: 'to apply this setting:',
    setting: 'Setting',
    changedKey: 'Changed key',
    proposed: 'Proposed',
    command: 'Command',
    audit: 'Action log',
    noInstructions: 'No instructions available.',
    noArtifacts: 'No artifacts listed.',
    missing: 'missing',
    idleShutdownDisabled: 'idle shutdown disabled.',
    stopWithCtrlC: 'Stop with Ctrl+C in the terminal.',
    shutdownIn: 'Shutdown in',
    warningIn: 'Warning in',
    idleWarning: 'Idle warning',
    stopping: 'Stopping',
    active: 'Active',
    idleThreshold: 'Idle threshold',
    lastActivity: 'Last activity',
    shutdownInPrefix: 'Shutdown in',
    shutdownInSuffix: 'seconds. Move, type, click, or press',
    shutdownInTail: 'to keep it running.',
    warningStartsInPrefix: 'Warning starts in',
    warningStartsInSuffix: 'seconds.',
    serverUnavailable: 'The local server is unavailable. Rerun',
    serverUnavailableTail: 'from a terminal.',
    actionsDisabled: 'Actions are disabled. Restart with',
    actionsDisabledTail: 'to expose allow-listed commands.',
    actionsIntro: 'Workspace actions are fixed Garda commands. Task-specific commands live in each task detail panel.',
    actionsTaskMoved: 'Open a task on the Tasks tab for next-step, stats, and events commands.',
    mutatingAction: 'Writes workspace or runtime data.',
    htmlReportMutation: 'Creates or updates an HTML report under runtime reports.',
    cleanupMutation: 'Deletes or compresses runtime artifacts according to the retention policy.',
    gardaSwitchMutation: 'Moves managed root instruction files between active and inactive switch storage.',
    safeAction: 'Read-only or dry-run command.',
    action: 'Action',
    run: 'Run',
    actionUnavailable: 'Unavailable',
    typeToRunAction: 'Type',
    typeToRunActionTail: 'to run this action:',
    noReviewAttempts: 'No review attempts recorded.',
    loadingTaskPrefix: 'Loading',
    unableToLoadDetails: 'Unable to load details: HTTP',
    events: 'Events',
    gatePass: 'Gate Pass',
    gateFail: 'Gate Fail',
    fullSuiteState: 'Full-suite state',
    fullSuiteDuration: 'Full-suite duration',
    fullSuiteTitle: 'Full-suite validation',
    fullSuiteCommand: 'Command',
    fullSuitePlacement: 'Placement',
    fullSuiteFreshness: 'Freshness',
    fullSuiteTimeoutForecast: 'Timeout forecast',
    fullSuiteArtifact: 'Evidence artifact',
    fullSuiteOutput: 'Output artifact',
    fullSuiteSummary: 'Summary',
    changedLines: 'Changed Lines',
    gateTimeline: 'Gate Timeline',
    gateTimelineHelp: 'This is the latest runtime cycle summary; the queue status above remains the TASK.md status.',
    blockers: 'Blockers',
    noBlockers: 'No blockers reported.',
    reviews: 'Reviews',
    artifacts: 'Artifacts',
    existingArtifacts: 'Existing artifacts',
    missingArtifacts: 'Missing artifacts',
    artifactPath: 'Artifact path'
} as const);

export type LocalUiTextKey = keyof typeof ENGLISH_LOCAL_UI_TEXT;

const IMPORTED_UI_LANGUAGE_PACKS: readonly ImportedUiLanguagePack[] = loadImportedUiLanguagePacks(
    Object.keys(ENGLISH_LOCAL_UI_TEXT)
);

export const LOCAL_UI_LANGUAGES: readonly UiLanguagePackDescriptor[] = Object.freeze([
    ...CORE_LOCAL_UI_LANGUAGES,
    ...IMPORTED_UI_LANGUAGE_PACKS.map((pack) => pack.language)
]);

function buildImportedLanguageMap<T>(
    core: Readonly<Record<string, T>>,
    selector: (pack: ImportedUiLanguagePack) => T
): Readonly<Record<string, T>> {
    const merged: Record<string, T> = { ...core };
    for (const pack of IMPORTED_UI_LANGUAGE_PACKS) {
        merged[pack.language.id] = selector(pack);
    }
    return Object.freeze(merged);
}

const EMPTY_LOCALIZED_TEXT_MAP = Object.freeze({});
const EMPTY_CATEGORY_TEXT_MAP = Object.freeze({});

const CORE_LOCAL_UI_SETTING_TEXT = Object.freeze({
    en: EMPTY_LOCALIZED_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>>);

export const LOCAL_UI_SETTING_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_SETTING_TEXT,
    (pack) => pack.LOCAL_UI_SETTING_TEXT
);

const CORE_LOCAL_UI_INIT_SETTING_TEXT = Object.freeze({
    en: EMPTY_LOCALIZED_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>>);

export const LOCAL_UI_INIT_SETTING_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_INIT_SETTING_TEXT,
    (pack) => pack.LOCAL_UI_INIT_SETTING_TEXT
);

const CORE_LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {
        'garda-agent-orchestrator/live/docs/project-memory/README.md': { label: 'README.md', description: 'Memory index, ownership rules, and reading order.' },
        'garda-agent-orchestrator/live/docs/project-memory/compact.md': { label: 'compact.md', description: 'Short project map and routing hints for task start.' },
        'garda-agent-orchestrator/live/docs/project-memory/context.md': { label: 'context.md', description: 'Domain, project goals, and overall scope.' },
        'garda-agent-orchestrator/live/docs/project-memory/stack.md': { label: 'stack.md', description: 'Languages, frameworks, infrastructure, dependencies, and fallbacks for custom stacks.' },
        'garda-agent-orchestrator/live/docs/project-memory/architecture.md': { label: 'architecture.md', description: 'Architecture, component boundaries, and integration points.' },
        'garda-agent-orchestrator/live/docs/project-memory/module-map.md': { label: 'module-map.md', description: 'Repository areas, path ownership, and where to look for typical changes.' },
        'garda-agent-orchestrator/live/docs/project-memory/commands.md': { label: 'commands.md', description: 'Build, test, dev, release, and verification commands.' },
        'garda-agent-orchestrator/live/docs/project-memory/conventions.md': { label: 'conventions.md', description: 'Coding standards, naming rules, and workflow conventions outside agent-rules.' },
        'garda-agent-orchestrator/live/docs/project-memory/decisions.md': { label: 'decisions.md', description: 'Architectural and process decisions with rationale.' },
        'garda-agent-orchestrator/live/docs/project-memory/risks.md': { label: 'risks.md', description: 'Known risks, fragile paths, security notes, and compatibility constraints.' }
    }
});

export const LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_PROJECT_MEMORY_TEXT,
    (pack) => pack.LOCAL_UI_PROJECT_MEMORY_TEXT
);

const CORE_LOCAL_UI_ACTION_TEXT = Object.freeze({
    en: EMPTY_LOCALIZED_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>>);

export const LOCAL_UI_ACTION_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_ACTION_TEXT,
    (pack) => pack.LOCAL_UI_ACTION_TEXT
);

const CORE_LOCAL_UI_ACTION_CATEGORY_TEXT = Object.freeze({
    en: EMPTY_CATEGORY_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, string>>>>);

export const LOCAL_UI_ACTION_CATEGORY_TEXT: Readonly<Record<string, Readonly<Record<string, string>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_ACTION_CATEGORY_TEXT,
    (pack) => pack.LOCAL_UI_ACTION_CATEGORY_TEXT
);

const CORE_LOCAL_UI_INSTRUCTION_TEXT = Object.freeze({
    en: EMPTY_LOCALIZED_TEXT_MAP
} satisfies Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>>);

export const LOCAL_UI_INSTRUCTION_TEXT: Readonly<Record<string, Readonly<Record<string, LocalUiLocalizedText>>>> = buildImportedLanguageMap(
    CORE_LOCAL_UI_INSTRUCTION_TEXT,
    (pack) => pack.LOCAL_UI_INSTRUCTION_TEXT
);

export const LOCAL_UI_TEXT: Readonly<Record<string, Readonly<Record<LocalUiTextKey, string>>>> = buildImportedLanguageMap(
    {
        en: ENGLISH_LOCAL_UI_TEXT
    },
    (pack) => pack.LOCAL_UI_TEXT as Readonly<Record<LocalUiTextKey, string>>
);

export function formatLocalUiLanguageCliChoices(): string {
    return LOCAL_UI_LANGUAGES.map((language) => language.id).join('|');
}

export function isLocalUiLanguage(value: unknown): value is LocalUiLanguage {
    return typeof value === 'string'
        && LOCAL_UI_LANGUAGES.some((language) => language.id === value);
}

export function findLocalUiLanguage(value: unknown): LocalUiLanguage | null {
    if (typeof value !== 'string') {
        return null;
    }
    const normalized = value.trim();
    const match = LOCAL_UI_LANGUAGES.find((language) => language.id.toLowerCase() === normalized.toLowerCase());
    return match?.id ?? null;
}

export function normalizeLocalUiLanguage(value: unknown): LocalUiLanguage {
    return isLocalUiLanguage(value)
        ? value
        : DEFAULT_LOCAL_UI_LANGUAGE;
}

export function getLocalUiText(language: unknown): Readonly<Record<LocalUiTextKey, string>> {
    return LOCAL_UI_TEXT[normalizeLocalUiLanguage(language)] || LOCAL_UI_TEXT[DEFAULT_LOCAL_UI_LANGUAGE];
}

export function assertLocalUiLanguagePacksComplete(): void {
    const englishKeys = Object.keys(LOCAL_UI_TEXT.en).sort();
    for (const language of LOCAL_UI_LANGUAGES) {
        const keys = Object.keys(LOCAL_UI_TEXT[language.id]).sort();
        const missingKeys = englishKeys.filter((key) => !keys.includes(key));
        const extraKeys = keys.filter((key) => !englishKeys.includes(key));
        if (missingKeys.length > 0 || extraKeys.length > 0) {
            throw new Error(`Local UI language pack '${language.id}' is incomplete. Missing: ${missingKeys.join(', ') || 'none'}; extra: ${extraKeys.join(', ') || 'none'}.`);
        }
    }
}

assertLocalUiLanguagePacksComplete();
