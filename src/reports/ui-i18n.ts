export const DEFAULT_LOCAL_UI_LANGUAGE = 'en';

export const LOCAL_UI_LANGUAGES = Object.freeze([
    { id: 'en', label: 'English', nativeLabel: 'English' },
    { id: 'ru', label: 'Russian', nativeLabel: 'Русский' }
] as const);

export type LocalUiLanguage = typeof LOCAL_UI_LANGUAGES[number]['id'];

const ENGLISH_LOCAL_UI_TEXT = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Loading workspace report...',
    tasksTab: 'Tasks',
    workflowTab: 'Workflow Config',
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
    searchTasks: 'Search tasks',
    allStatuses: 'All statuses',
    allPriorities: 'All priorities',
    idColumn: 'ID',
    statusColumn: 'Status',
    priorityColumn: 'Priority',
    areaColumn: 'Area',
    titleColumn: 'Title',
    actionColumn: 'Action',
    loading: 'Loading...',
    taskDetailTitle: 'Task Detail',
    chooseTask: 'Choose a task and click Load details.',
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
    guardedEditor: 'Guarded editor',
    settingEditsDisabled: 'Setting edits are disabled. Restart with',
    settingEditsDisabledTail: 'to enable audited workflow commands.',
    noEditableSettings: 'No editable safe settings available.',
    current: 'Current',
    preview: 'Preview',
    apply: 'Apply',
    typeToApplySetting: 'Type',
    typeToApplySettingTail: 'to apply this setting:',
    setting: 'Setting',
    changedKey: 'Changed key',
    proposed: 'Proposed',
    command: 'Command',
    audit: 'Audit',
    noInstructions: 'No instructions available.',
    noArtifacts: 'No artifacts listed.',
    missing: 'missing',
    idleShutdownDisabled: 'idle shutdown disabled.',
    stopWithCtrlC: 'Stop with Ctrl+C in the terminal.',
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
    action: 'Action',
    run: 'Run',
    typeToRunAction: 'Type',
    typeToRunActionTail: 'to run this action:',
    noReviewAttempts: 'No review attempts recorded.',
    loadingTaskPrefix: 'Loading',
    unableToLoadDetails: 'Unable to load details: HTTP',
    events: 'Events',
    gatePass: 'Gate Pass',
    gateFail: 'Gate Fail',
    changedLines: 'Changed Lines',
    gateTimeline: 'Gate Timeline',
    blockers: 'Blockers',
    noBlockers: 'No blockers reported.',
    reviews: 'Reviews',
    artifacts: 'Artifacts',
    auditTitle: 'Audit'
} as const);

export type LocalUiTextKey = keyof typeof ENGLISH_LOCAL_UI_TEXT;

const RUSSIAN_LOCAL_UI_TEXT: Record<LocalUiTextKey, string> = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Загрузка отчёта workspace...',
    tasksTab: 'Задачи',
    workflowTab: 'Workflow Config',
    instructionsTab: 'Инструкции',
    actionsTab: 'Действия',
    noticeActionsEnabled: 'Детали задач загружаются по запросу с локального сервера. Сервер привязан к 127.0.0.1 и останавливается при завершении этого CLI-процесса. Управляемые действия включены только для allow-listed команд.',
    noticeActionsDisabled: 'Детали задач загружаются по запросу с локального сервера. Сервер привязан к 127.0.0.1 и останавливается при завершении этого CLI-процесса. Управляемые действия отключены, если сервер не запущен с --actions.',
    languageTitle: 'Язык',
    languageHelp: 'Язык UI хранится локально в этой странице браузера. Команды, task IDs, config keys, enum values, file paths и raw outputs не переводятся.',
    serverStatusTitle: 'Статус сервера',
    loadingServerSession: 'Загрузка сессии сервера...',
    iAmHere: 'Я здесь',
    stopServer: 'Остановить сервер',
    serverStoppedRerun: 'Когда сервер остановится, страница не сможет запустить его снова. Выполните',
    serverStoppedRerunTail: 'в терминале.',
    searchTasks: 'Поиск задач',
    allStatuses: 'Все статусы',
    allPriorities: 'Все приоритеты',
    idColumn: 'ID',
    statusColumn: 'Статус',
    priorityColumn: 'Приоритет',
    areaColumn: 'Area',
    titleColumn: 'Название',
    actionColumn: 'Действие',
    loading: 'Загрузка...',
    taskDetailTitle: 'Детали задачи',
    chooseTask: 'Выберите задачу и нажмите Load details.',
    overviewTasks: 'Задачи',
    overviewActive: 'Активные',
    overviewDone: 'Готовые',
    overviewBlocked: 'Заблокированные',
    overviewWarnings: 'Предупреждения',
    metaRepo: 'Repo',
    metaTasks: 'Задачи',
    metaWarnings: 'Предупреждения',
    warningsTitle: 'Предупреждения',
    noMatchingTasks: 'Нет подходящих задач.',
    loadDetails: 'Load details',
    noWorkflowSettings: 'Настройки workflow недоступны.',
    guardedEditor: 'Защищённый редактор',
    settingEditsDisabled: 'Редактирование настроек отключено. Перезапустите с',
    settingEditsDisabledTail: 'чтобы включить audited workflow commands.',
    noEditableSettings: 'Нет доступных безопасных настроек для редактирования.',
    current: 'Текущее',
    preview: 'Preview',
    apply: 'Apply',
    typeToApplySetting: 'Введите',
    typeToApplySettingTail: 'чтобы применить настройку:',
    setting: 'Настройка',
    changedKey: 'Changed key',
    proposed: 'Предложено',
    command: 'Command',
    audit: 'Audit',
    noInstructions: 'Инструкции недоступны.',
    noArtifacts: 'Артефакты не указаны.',
    missing: 'missing',
    idleShutdownDisabled: 'idle shutdown отключён.',
    stopWithCtrlC: 'Остановите через Ctrl+C в терминале.',
    idleWarning: 'Предупреждение простоя',
    stopping: 'Останавливается',
    active: 'Активен',
    idleThreshold: 'Порог простоя',
    lastActivity: 'Последняя активность',
    shutdownInPrefix: 'Остановка через',
    shutdownInSuffix: 'секунд. Двигайте мышью, печатайте, кликайте или нажмите',
    shutdownInTail: 'чтобы оставить сервер включённым.',
    warningStartsInPrefix: 'Предупреждение начнётся через',
    warningStartsInSuffix: 'секунд.',
    serverUnavailable: 'Локальный сервер недоступен. Выполните',
    serverUnavailableTail: 'в терминале.',
    actionsDisabled: 'Действия отключены. Перезапустите с',
    actionsDisabledTail: 'чтобы показать allow-listed команды.',
    action: 'Действие',
    run: 'Run',
    typeToRunAction: 'Введите',
    typeToRunActionTail: 'чтобы выполнить действие:',
    noReviewAttempts: 'Попытки review не записаны.',
    loadingTaskPrefix: 'Загрузка',
    unableToLoadDetails: 'Не удалось загрузить детали: HTTP',
    events: 'События',
    gatePass: 'Gate Pass',
    gateFail: 'Gate Fail',
    changedLines: 'Changed Lines',
    gateTimeline: 'Gate Timeline',
    blockers: 'Blockers',
    noBlockers: 'Блокеры не найдены.',
    reviews: 'Reviews',
    artifacts: 'Artifacts',
    auditTitle: 'Audit'
});

export const LOCAL_UI_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<LocalUiTextKey, string>>>> = Object.freeze({
    en: ENGLISH_LOCAL_UI_TEXT,
    ru: RUSSIAN_LOCAL_UI_TEXT
});

export function isLocalUiLanguage(value: unknown): value is LocalUiLanguage {
    return typeof value === 'string'
        && LOCAL_UI_LANGUAGES.some((language) => language.id === value);
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
