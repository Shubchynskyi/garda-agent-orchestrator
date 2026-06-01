export const DEFAULT_LOCAL_UI_LANGUAGE = 'en';

export const LOCAL_UI_LANGUAGES = Object.freeze([
    { id: 'en', label: 'English', nativeLabel: 'English' },
    { id: 'ru', label: 'Russian', nativeLabel: 'Русский' }
] as const);

export type LocalUiLanguage = typeof LOCAL_UI_LANGUAGES[number]['id'];

export interface LocalUiLocalizedText {
    label?: string;
    description?: string;
    title?: string;
    body?: string;
    options?: Record<string, {
        label: string;
        description: string;
    }>;
}

const ENGLISH_LOCAL_UI_TEXT = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Loading workspace report...',
    tasksTab: 'Tasks',
    workflowTab: 'Workflow Config',
    initSettingsTab: 'Init settings',
    projectMemoryTab: 'Project memory',
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

const RUSSIAN_LOCAL_UI_TEXT: Record<LocalUiTextKey, string> = Object.freeze({
    appTitle: 'Garda UI',
    loadingWorkspaceReport: 'Загрузка отчёта workspace...',
    tasksTab: 'Задачи',
    workflowTab: 'Рабочий конфиг',
    initSettingsTab: 'Init settings',
    projectMemoryTab: 'Память проекта',
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
    gardaSwitchTitle: 'Переключатель Garda',
    gardaSwitchState: 'Состояние',
    gardaSwitchStateOn: 'Включено',
    gardaSwitchStateOff: 'Отключено',
    gardaSwitchStateUnknown: 'Неизвестно',
    gardaSwitchHelp: 'Включает или отключает корневые Garda-инструкции для этого workspace.',
    gardaSwitchActionsDisabled: 'Чтобы переключать отсюда, запустите UI с управляемыми действиями:',
    gardaSwitchUnknownHelp: 'Состояние переключателя неизвестно; выберите нужную команду после проверки workspace.',
    gardaSwitchUnavailable: 'Переключение скрыто, пока текущее состояние Garda неизвестно.',
    turnGardaOn: 'Включить',
    turnGardaOff: 'Отключить',
    searchTasks: 'Поиск задач',
    allStatuses: 'Все статусы',
    allPriorities: 'Все приоритеты',
    idColumn: 'ID',
    statusColumn: 'Статус',
    priorityColumn: 'Приоритет',
    areaColumn: 'Область',
    titleColumn: 'Название',
    actionColumn: 'Действие',
    dataColumn: 'Данные',
    loading: 'Загрузка...',
    taskDetailTitle: 'Детали задачи',
    chooseTask: 'Выберите задачу и нажмите «Загрузить детали».',
    dataCompact: 'Компактно',
    dataFull: 'Полностью',
    dataOnDemand: 'По запросу',
    dataBlockers: 'Блокеры',
    compactDetailState: 'Закрытая задача показана по строке очереди; загрузите детали, если нужны архивные артефакты.',
    onDemandDetailState: 'Открытая задача показана из TASK.md; детали загружаются только когда нужны runtime events или артефакты.',
    fullDetailState: 'Полные артефакты задачи загружены с локального сервера.',
    blockerDetailState: 'В TASK.md задача помечена как заблокированная.',
    runtimeDiagnosticsTitle: 'Runtime-диагностика',
    noRuntimeDiagnostics: 'Runtime-диагностика не сообщает проблем.',
    taskActionsTitle: 'Команды задачи',
    taskActionsHelp: 'Команды конкретной задачи находятся здесь, чтобы вкладка действий была только про обслуживание workspace.',
    taskCommandNextStep: 'Следующий шаг lifecycle',
    taskCommandStats: 'Статистика задачи',
    taskCommandEvents: 'События задачи',
    taskCommandReset: 'Сбросить задачу',
    taskCommandNextStepDescription: 'Запрашивает у Garda следующий обязательный lifecycle-шаг для этой задачи. Может продвинуть workflow state и требует подтверждения.',
    taskCommandResetDescription: 'Переоткрывает задачу через защищённый gate task-reset. Нужно включить task-reset и ввести подтверждение.',
    taskCommandStatsDescription: 'Показывает focused counters и runtime summary для этой задачи.',
    taskCommandEventsDescription: 'Показывает timeline событий задачи, который используют gate summaries.',
    taskCommandPreviewHelp: 'Запуск next-step требует подтверждения.',
    taskCommandUnavailable: 'Запустите `garda ui --actions`, чтобы выполнять команды задачи с этой страницы.',
    taskResetUnavailable: 'Task reset отключён. Сначала включите workflow setting task_reset.enabled, затем запускайте подтверждённый reset.',
    showTaskPlan: 'Показать план',
    taskPlanTitle: 'План задачи',
    planPath: 'Путь к плану',
    planMetadataOnly: 'Метаданные плана есть, но markdown-файл плана недоступен.',
    close: 'Закрыть',
    taskQueueStatus: 'Статус в очереди',
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
    loadDetails: 'Загрузить детали',
    noWorkflowSettings: 'Настройки workflow недоступны.',
    initBlockTitle: 'Init',
    agentInitBlockTitle: 'Агентский init',
    initCommandsTitle: 'Команды init',
    initStatusPresent: 'Загружено',
    initStatusMissing: 'Файл не найден',
    initStatusInvalid: 'Файл некорректен',
    fieldColumn: 'Поле',
    valueColumn: 'Значение',
    noInitSettings: 'Настройки недоступны.',
    projectMemoryStatusTitle: 'Текущий статус памяти проекта',
    projectMemoryFilesTitle: 'Файлы памяти проекта',
    fileColumn: 'Файл',
    purposeColumn: 'Назначение',
    sizeColumn: 'Размер',
    openColumn: 'Переход',
    openMemoryFile: 'Открыть',
    noProjectMemoryFiles: 'Файлы памяти проекта недоступны.',
    workflowConfigPath: 'Файл конфига',
    workflowStatus: 'Состояние конфига',
    workflowStatusPresent: 'Конфиг загружен. Предупреждения появятся здесь только если файл нельзя прочитать или разобрать.',
    workflowStatusMissing: 'Файл не найден; показаны значения по умолчанию',
    workflowStatusInvalid: 'Файл некорректен; показаны значения по умолчанию',
    workflowWarningTitle: 'Проблема с конфигом',
    workflowCommandPreview: 'Предпросмотр команды',
    workflowCommandPreviewHelp: 'Выберите настройку и нажмите «Показать команду», чтобы увидеть точную audited-команду перед сохранением.',
    actionsPreviewHelp: 'Выберите действие и нажмите «Показать команду», чтобы увидеть точную разрешённую команду перед запуском.',
    resultStatusPreviewed: 'Только предпросмотр',
    resultStatusExecuted: 'Применено',
    resultStatusConfirmationRequired: 'Нужно подтверждение',
    resultStatusDisabled: 'Отключено',
    resultStatusUnavailable: 'Недоступно',
    workflowGroupValidation: 'Проверки и тестовый lifecycle',
    workflowGroupReview: 'Порядок review',
    workflowGroupScope: 'Лимиты размера задачи',
    workflowGroupMemory: 'Project memory',
    workflowGroupSafety: 'Защищённые режимы',
    configSettingColumn: 'Настройка',
    descriptionColumn: 'Описание',
    currentValueColumn: 'Текущее значение',
    optionsColumn: 'Опции',
    changeColumn: 'Изменить',
    noFixedOptions: 'Фиксированных опций нет',
    freeValueHelp: 'Введите значение по смыслу описания.',
    reviewCycleAutoSplitDependency: 'Auto-split влияет только на blocking mode: review_cycle_guard.action должен быть BLOCK_FOR_OPERATOR_DECISION. При WARN_ONLY эта настройка информационная.',
    minutesLabel: 'Минуты',
    secondsLabel: 'Секунды',
    durationStoredAsMs: 'Для Garda сохраняется в миллисекундах.',
    commandColumn: 'Команда',
    actionEffectColumn: 'Эффект',
    actionRunColumn: 'Запуск',
    instructionAreaColumn: 'Раздел',
    instructionDescriptionColumn: 'Описание',
    guardedEditor: 'Защищённый редактор',
    guardedEditorHelp: 'Изменения выполняются через проверяемые команды `garda workflow set`. Сначала можно посмотреть команду, затем сохранить с подтверждением.',
    settingEditsDisabled: 'Редактирование настроек отключено. Перезапустите с',
    settingEditsDisabledTail: 'чтобы включить управляемое изменение настроек.',
    noEditableSettings: 'Нет доступных безопасных настроек для редактирования.',
    current: 'Текущее',
    newValue: 'Новое значение',
    parameter: 'Параметр',
    availableOptions: 'Опции',
    noOptions: 'Фиксированных опций нет; введите значение по описанию поля.',
    save: 'Сохранить',
    saveDisabled: 'Сохранение отключено',
    settingReadonly: 'Только чтение с этой страницы',
    preview: 'Предпросмотр',
    previewCommand: 'Показать команду',
    apply: 'Применить',
    typeToApplySetting: 'Введите',
    typeToApplySettingTail: 'чтобы применить настройку:',
    setting: 'Настройка',
    changedKey: 'Изменённый параметр',
    proposed: 'Предложено',
    command: 'Команда',
    audit: 'Журнал действия',
    noInstructions: 'Инструкции недоступны.',
    noArtifacts: 'Артефакты не указаны.',
    missing: 'нет файла',
    idleShutdownDisabled: 'автоостановка отключена',
    stopWithCtrlC: 'Остановите через Ctrl+C в терминале.',
    shutdownIn: 'Выключение через',
    warningIn: 'Предупреждение через',
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
    actionsDisabledTail: 'чтобы показать разрешённые команды.',
    actionsIntro: 'Действия workspace — это фиксированные команды Garda. Команды конкретной задачи находятся в деталях этой задачи.',
    actionsTaskMoved: 'Откройте задачу на вкладке «Задачи», чтобы увидеть next-step, stats и events команды.',
    mutatingAction: 'Вносит изменения в workspace или runtime.',
    htmlReportMutation: 'Создаёт или обновляет HTML-отчёт в runtime/reports.',
    cleanupMutation: 'Удаляет или сжимает runtime-артефакты по retention policy.',
    gardaSwitchMutation: 'Перемещает управляемые корневые instruction-файлы между активным и неактивным хранилищем.',
    safeAction: 'Только читает данные или показывает dry-run.',
    action: 'Действие',
    run: 'Выполнить',
    actionUnavailable: 'Недоступно',
    typeToRunAction: 'Введите',
    typeToRunActionTail: 'чтобы выполнить действие:',
    noReviewAttempts: 'Попытки review не записаны.',
    loadingTaskPrefix: 'Загрузка',
    unableToLoadDetails: 'Не удалось загрузить детали: HTTP',
    events: 'События',
    gatePass: 'Успешные gates',
    gateFail: 'Проваленные gates',
    fullSuiteState: 'Статус full-suite',
    fullSuiteDuration: 'Длительность full-suite',
    fullSuiteTitle: 'Full-suite validation',
    fullSuiteCommand: 'Команда',
    fullSuitePlacement: 'Место',
    fullSuiteFreshness: 'Актуальность',
    fullSuiteTimeoutForecast: 'Прогноз таймаута',
    fullSuiteArtifact: 'Evidence-артефакт',
    fullSuiteOutput: 'Output-артефакт',
    fullSuiteSummary: 'Summary',
    changedLines: 'Изменённые строки',
    gateTimeline: 'Лента gates',
    gateTimelineHelp: 'Это summary последнего runtime-цикла; статус задачи выше остаётся статусом из TASK.md.',
    blockers: 'Блокеры',
    noBlockers: 'Блокеры не найдены.',
    reviews: 'Review',
    artifacts: 'Артефакты',
    existingArtifacts: 'Есть артефакты',
    missingArtifacts: 'Отсутствуют артефакты',
    artifactPath: 'Путь артефакта'
});

export const LOCAL_UI_SETTING_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {},
    ru: {
        'full-suite-enabled': {
            label: 'Обязательная полная проверка',
            description: 'Определяет, должна ли команда полного тестового набора быть обязательной частью lifecycle задачи.'
        },
        'full-suite-command': {
            label: 'Команда полной проверки',
            description: 'Команда, которую запускает full-suite gate, когда обязательная полная проверка включена.'
        },
        'full-suite-timeout-ms': {
            label: 'Таймаут полной проверки',
            description: 'Максимальное время выполнения команды полной проверки в миллисекундах.'
        },
        'full-suite-green-summary-max-lines': {
            label: 'Размер успешного отчёта full-suite',
            description: 'Сколько строк успешного вывода full-suite сохранять в компактных evidence задачи.'
        },
        'full-suite-red-failure-chunk-lines': {
            label: 'Размер блока ошибки full-suite',
            description: 'Сколько строк неуспешного вывода сохранять в одном компактном блоке ошибки.'
        },
        'full-suite-out-of-scope-failure-policy': {
            label: 'Ошибки вне scope задачи',
            description: 'Что делать, если full-suite нашёл проблему за пределами текущей задачи.',
            options: {
                AUDIT_AND_BLOCK: {
                    label: 'Записать и заблокировать',
                    description: 'Записывает проблему и останавливает workflow до решения.'
                },
                AUDIT_AND_WARN: {
                    label: 'Записать и предупредить',
                    description: 'Записывает проблему, но разрешает продолжить с предупреждением.'
                }
            }
        },
        'full-suite-placement': {
            label: 'Место full-suite в lifecycle',
            description: 'На каком этапе lifecycle задачи запускать обязательный full-suite gate.',
            options: {
                after_compile_before_reviews: {
                    label: 'После compile, перед review',
                    description: 'Запускает full-suite после успешной компиляции и до старта review.'
                },
                before_test_review: {
                    label: 'Перед test review',
                    description: 'Запускает full-suite прямо перед тем, как test review нужен evidence.'
                },
                before_completion: {
                    label: 'Перед завершением',
                    description: 'Откладывает full-suite до финального completion path.'
                }
            }
        },
        'review-execution-policy': {
            label: 'Режим запуска review',
            description: 'Определяет, какие review могут идти параллельно, а какие должны ждать code review.',
            options: {
                parallel_all: {
                    label: 'Все параллельно',
                    description: 'Все review lanes можно готовить независимо; upstream-зависимостей нет.'
                },
                test_after_code: {
                    label: 'Test после code',
                    description: 'Только test ждёт текущий code PASS; остальные review независимы.'
                },
                code_first_optional: {
                    label: 'Code сначала для optional',
                    description: 'API, performance, infra и dependency ждут code PASS; test остаётся downstream.'
                },
                strict_sequential: {
                    label: 'Строго по очереди',
                    description: 'Обязательные review lanes идут по одному в каноническом порядке.'
                }
            }
        },
        'scope-budget-enabled': {
            label: 'Контроль размера задачи',
            description: 'Включает предупреждение или блокировку, когда задача становится больше лимита выбранного профиля.'
        },
        'scope-budget-action': {
            label: 'Реакция на превышение scope',
            description: 'Что делать, когда задача превысила настроенный scope budget.',
            options: {
                BLOCK_FOR_SPLIT: {
                    label: 'Блокировать до разбиения',
                    description: 'Останавливает слишком большую задачу и требует разбиения.'
                },
                WARN_ONLY: {
                    label: 'Только предупредить',
                    description: 'Показывает предупреждение, но не останавливает lifecycle.'
                }
            }
        },
        'scope-budget-profiles': {
            label: 'Профили для scope budget',
            description: 'Task profiles, для которых действует контроль размера. Unknown legacy values показываются явно и не удаляются молча.'
        },
        'scope-budget-max-files': {
            label: 'Лимит файлов',
            description: 'Максимальное число изменённых файлов до реакции scope budget guard.'
        },
        'scope-budget-max-changed-lines': {
            label: 'Лимит изменённых строк',
            description: 'Максимальное число изменённых строк до реакции scope budget guard.'
        },
        'scope-budget-max-required-reviews': {
            label: 'Лимит review lanes',
            description: 'Максимальное число обязательных review lanes до реакции scope budget guard.'
        },
        'scope-budget-max-review-tokens': {
            label: 'Лимит review tokens',
            description: 'Максимальная оценка токенов на review до реакции scope budget guard.'
        },
        'review-cycle-enabled': {
            label: 'Контроль review-циклов',
            description: 'Отслеживает повторяющиеся не-test review loops, чтобы они не съели слишком много работы.'
        },
        'review-cycle-action': {
            label: 'Реакция на review-loop',
            description: 'Что делать, если повторные review attempts превысили лимиты.',
            options: {
                BLOCK_FOR_OPERATOR_DECISION: {
                    label: 'Ждать решение оператора',
                    description: 'Останавливает повторяющиеся review loops до выбора recovery path.'
                },
                WARN_ONLY: {
                    label: 'Только предупредить',
                    description: 'Показывает давление review-cycle, но не останавливает workflow.'
                }
            }
        },
        'review-cycle-max-failed-non-test-reviews': {
            label: 'Лимит проваленных non-test review',
            description: 'Сколько проваленных non-test review attempts допускается до реакции guard.'
        },
        'review-cycle-max-total-non-test-reviews': {
            label: 'Общий лимит non-test review',
            description: 'Сколько всего non-test review attempts допускается до реакции guard.'
        },
        'review-cycle-excluded-review-types': {
            label: 'Исключённые review types',
            description: 'Review lanes, которые review-cycle guard игнорирует. Значения выбираются из известных review contract keys и текущего capability config.'
        },
        'review-cycle-auto-split-enabled': {
            label: 'Авто-предложение split',
            description: 'Разрешает auto-split prompt только когда review-cycle action блокирует до решения оператора.'
        },
        'project-memory-enabled': {
            label: 'Проверка project memory',
            description: 'Включает closeout-проверку того, нужно ли обновить durable project memory.'
        },
        'project-memory-mode': {
            label: 'Режим project memory',
            description: 'Насколько строго workflow требует работу с project memory.',
            options: {
                off: {
                    label: 'Выключено',
                    description: 'Не запускать project-memory maintenance во время closeout.'
                },
                check: {
                    label: 'Проверить',
                    description: 'Проверять, нужны ли memory updates, но не писать файлы.'
                },
                update: {
                    label: 'Обновлять',
                    description: 'Разрешить workflow обновлять focused project-memory файлы при необходимости.'
                },
                strict: {
                    label: 'Строго',
                    description: 'Требовать memory evidence до успешного closeout.'
                }
            }
        },
        'project-memory-run-before-final-closeout': {
            label: 'Запускать memory check до closeout',
            description: 'Запускает project-memory maintenance перед финальным completion step.'
        },
        'project-memory-require-user-approval-for-writes': {
            label: 'Подтверждение записи memory',
            description: 'Требует явного согласия пользователя перед записью project-memory файлов.'
        },
        'project-memory-max-compact-summary-chars': {
            label: 'Размер compact memory summary',
            description: 'Максимальный размер generated compact project-memory summary в символах.'
        },
        'project-memory-read-strategy': {
            label: 'Стратегия чтения memory',
            description: 'Как агент должен читать durable memory на старте задачи.',
            options: {
                index_first: {
                    label: 'Сначала индекс',
                    description: 'Сначала читать memory index и открывать подробные файлы только по ссылкам из индекса.'
                }
            }
        },
        'project-memory-impact-retention-days': {
            label: 'Хранение memory impact artifacts',
            description: 'Сколько дней хранить артефакты project-memory impact.'
        },
        'task-reset-enabled': {
            label: 'Команды reset/discard задач',
            description: 'Разрешает подтверждённые мутации reset или discard для задач.'
        },
        'garda-self-guard': {
            label: 'Защита control-plane Garda',
            description: 'Определяет, могут ли агенты напрямую входить в защищённую control-plane работу Garda.',
            options: {
                deny_agent_entry: {
                    label: 'Включено',
                    description: 'Агенты не могут входить в protected control-plane work без operator-owned path.'
                },
                require_operator_confirmation: {
                    label: 'Требовать подтверждение',
                    description: 'Protected control-plane entry требует явного подтверждения оператора.'
                }
            }
        }
    }
});

export const LOCAL_UI_INIT_SETTING_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {},
    ru: {
        AssistantLanguage: { label: 'Язык ассистента', description: 'На каком языке агент должен общаться с оператором.' },
        AssistantBrevity: { label: 'Подробность ответов', description: 'Насколько подробно агент отвечает в обычных сообщениях.' },
        SourceOfTruth: { label: 'Главный файл инструкций', description: 'Какой provider-файл считается каноническим источником инструкций.' },
        EnforceNoAutoCommit: { label: 'Запрет auto-commit', description: 'Не даёт агенту делать commit без явного разрешения оператора.' },
        ClaudeOrchestratorFullAccess: { label: 'Claude full access', description: 'Настройка для Claude-oriented инструкций про полный доступ к оркестратору.' },
        TokenEconomyEnabled: { label: 'Экономия токенов', description: 'Делает generated instructions компактнее и уменьшает лишний контекст.' },
        ProviderMinimalism: { label: 'Минимализм provider-файлов', description: 'Оставляет неканонические provider entrypoints редиректами, когда это возможно.' },
        CollectedVia: { label: 'Как собраны ответы', description: 'Каким способом были получены init answers.' },
        ActiveAgentFiles: { label: 'Активные agent files', description: 'Root/provider instruction files, выбранные при инициализации.' },
        UpdatedAt: { label: 'Последнее обновление', description: 'Когда hard agent-init state был записан последний раз.' },
        OrchestratorVersion: { label: 'Версия оркестратора', description: 'Версия Garda, которая записала состояние.' },
        AssistantLanguageConfirmed: { label: 'Язык подтверждён', description: 'Пройден ли checkpoint языка ассистента.' },
        ActiveAgentFilesConfirmed: { label: 'Agent files подтверждены', description: 'Был ли явно подтверждён набор active agent files.' },
        ProjectRulesUpdated: { label: 'Project rules подтверждены', description: 'Были ли project rules просмотрены или приняты во время agent init.' },
        SkillsPromptCompleted: { label: 'Skills prompt завершён', description: 'Пройден ли checkpoint с подсказкой по skills.' },
        OrdinaryDocPathsConfirmed: { label: 'Обычные docs подтверждены', description: 'Подтверждены ли user-owned docs, которые не считаются generated rules.' },
        OrdinaryDocPaths: { label: 'Обычные docs', description: 'User-owned documentation paths, которые Garda может упоминать как обычную документацию.' },
        VerificationPassed: { label: 'Verification прошёл', description: 'Прошла ли post-init проверка workspace.' },
        ManifestValidationPassed: { label: 'Manifest валиден', description: 'Прошла ли проверка protected control-plane manifest.' },
        LastSeededFullSuiteCommand: { label: 'Seeded full-suite command', description: 'Тестовая команда, записанная в workflow config во время init.' },
        ProjectMemoryInitialized: { label: 'Project memory initialized', description: 'Зафиксировал ли agent-init инициализацию project memory.' },
        ProjectMemoryValidated: { label: 'Project memory validated', description: 'Зафиксировал ли agent-init успешную проверку project memory.' },
        ProjectMemoryMode: { label: 'Project memory mode', description: 'Режим bootstrap project memory, записанный agent init.' },
        ProjectMemoryDir: { label: 'Папка project memory', description: 'Директория с durable project memory.' },
        ProjectMemoryReadFirst: { label: 'Project memory read-first files', description: 'Файлы, которые агент читает перед focused memory files.' },
        ProjectMemorySummaryRule: { label: 'Project memory summary rule', description: 'Generated rule file со summary project memory.' },
        ProjectMemoryBootstrapReport: { label: 'Project memory bootstrap report', description: 'Runtime report от bootstrap project memory.' },
        ProjectMemoryWarnings: { label: 'Project memory warnings', description: 'Предупреждения bootstrap или validation project memory.' },
        'memory-enabled': { label: 'Memory maintenance включён', description: 'Проверяет ли workflow durable project memory перед closeout.' },
        'memory-mode': { label: 'Режим memory maintenance', description: 'Текущий режим: off, check, update или strict.' },
        'memory-run-before-closeout': { label: 'Запуск до final closeout', description: 'Запускается ли project-memory gate перед завершением задачи.' },
        'memory-require-approval': { label: 'Подтверждение записи', description: 'Нужно ли согласие пользователя перед записью project-memory файлов.' },
        'memory-read-strategy': { label: 'Стратегия чтения', description: 'Как агент должен читать project memory на старте задачи.' },
        'memory-initialized': { label: 'Initialized в agent init', description: 'Зафиксировал ли agent-init инициализацию памяти проекта.' },
        'memory-validated': { label: 'Validated в agent init', description: 'Зафиксировал ли agent-init успешную проверку памяти проекта.' },
        'memory-dir': { label: 'Папка памяти', description: 'Директория с user-owned durable memory files.' },
        'memory-read-first': { label: 'Читать первыми', description: 'Файлы, которые агент должен читать перед focused memory files.' },
        'memory-summary-rule': { label: 'Generated summary rule', description: 'Generated rule file со summary project memory для старта агента.' },
        'memory-bootstrap-report': { label: 'Bootstrap report', description: 'Runtime report от bootstrap или проверки project memory.' },
        reinit: { title: 'Re-init workspace', description: 'Пересобирает generated Garda files из текущих init answers. Используется после изменения choices инициализации.' },
        'agent-init': { title: 'Агентский init', description: 'Записывает hard onboarding checkpoints: active agent files, project rules, skills prompt и готовность project memory.' }
    }
});

export const LOCAL_UI_PROJECT_MEMORY_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {},
    ru: {
        'garda-agent-orchestrator/live/docs/project-memory/README.md': { label: 'README.md', description: 'Индекс памяти, правила владения и порядок чтения.' },
        'garda-agent-orchestrator/live/docs/project-memory/compact.md': { label: 'compact.md', description: 'Короткая карта проекта и routing hints для старта задачи.' },
        'garda-agent-orchestrator/live/docs/project-memory/context.md': { label: 'context.md', description: 'Домен, цели проекта и общий scope.' },
        'garda-agent-orchestrator/live/docs/project-memory/stack.md': { label: 'stack.md', description: 'Языки, frameworks, инфраструктура, зависимости и fallback для custom stack.' },
        'garda-agent-orchestrator/live/docs/project-memory/architecture.md': { label: 'architecture.md', description: 'Архитектура, границы компонентов и integration points.' },
        'garda-agent-orchestrator/live/docs/project-memory/module-map.md': { label: 'module-map.md', description: 'Области репозитория, path ownership и где смотреть типовые изменения.' },
        'garda-agent-orchestrator/live/docs/project-memory/commands.md': { label: 'commands.md', description: 'Build, test, dev, release и verification команды.' },
        'garda-agent-orchestrator/live/docs/project-memory/conventions.md': { label: 'conventions.md', description: 'Coding standards, naming rules и workflow conventions вне agent-rules.' },
        'garda-agent-orchestrator/live/docs/project-memory/decisions.md': { label: 'decisions.md', description: 'Архитектурные и процессные решения с rationale.' },
        'garda-agent-orchestrator/live/docs/project-memory/risks.md': { label: 'risks.md', description: 'Known risks, fragile paths, security notes и compatibility constraints.' }
    }
});

export const LOCAL_UI_ACTION_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {},
    ru: {
        status: {
            label: 'Статус',
            description: 'Запускает команду статуса Garda для этого workspace.'
        },
        doctor: {
            label: 'Диагностика',
            description: 'Проверяет init answers, manifest, generated files, locks и bundle health. Команда только читает данные и не чистит workspace.'
        },
        'html-report': {
            label: 'Сгенерировать HTML-отчёт',
            description: 'Создаёт или обновляет HTML-отчёт Garda с ленивой загрузкой деталей задач.'
        },
        'cleanup-preview': {
            label: 'Предпросмотр очистки runtime',
            description: 'Dry-run очистки runtime. Показывает кандидатов из task events, reviews, reports, backups, rollbacks, metrics и working plans по retention limits. Ничего не удаляет.'
        },
        'cleanup-apply': {
            label: 'Применить очистку runtime',
            description: 'Применяет ту же retention cleanup, которую показывает preview. Риск: старые runtime evidence могут быть удалены или сжаты, поэтому сначала проверьте preview и не запускайте во время активной задачи.'
        },
        'garda-on': {
            label: 'Включить Garda',
            description: 'Восстанавливает управляемые Garda root instruction файлы после `garda off`.'
        },
        'garda-off': {
            label: 'Отключить Garda',
            description: 'Убирает управляемые Garda root instruction файлы в runtime/switch/off и включает off-mode ignore block.'
        }
    }
});

export const LOCAL_UI_ACTION_CATEGORY_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, string>>>> = Object.freeze({
    en: {},
    ru: {
        Inspection: 'Проверка',
        Export: 'Экспорт',
        Maintenance: 'Обслуживание',
        'Garda switch': 'Переключатель Garda',
        Workspace: 'Workspace'
    }
});

export const LOCAL_UI_INSTRUCTION_TEXT: Readonly<Record<LocalUiLanguage, Readonly<Record<string, LocalUiLocalizedText>>>> = Object.freeze({
    en: {},
    ru: {
        'task-execution': {
            title: 'Выполнение задачи',
            body: 'Начинайте и продолжайте задачу через `garda next-step "<task-id>" --repo-root "."`. Напечатанная команда считается текущим router result; после каждого gate возвращайтесь к next-step.'
        },
        'task-inspection': {
            title: 'Просмотр задачи',
            body: 'Детали конкретной задачи открываются только на вкладке «Задачи». Компактные строки берутся из TASK.md; загрузка деталей читает events, blockers, reviews и artifact links только для выбранной задачи.'
        },
        'review-execution-modes': {
            title: 'Режимы запуска review',
            body: '`parallel_all` запускает lanes независимо. `test_after_code` заставляет test ждать code. `code_first_optional` заставляет выбранные specialist reviews ждать code и оставляет test downstream. `strict_sequential` запускает обязательные review lanes по очереди.'
        },
        'workflow-guards': {
            title: 'Workflow guards',
            body: 'Scope budget guards ловят слишком большие задачи. Review-cycle guards ловят повторяющиеся failed review loops. Project-memory maintenance проверяет, нужен ли focused update durable memory перед closeout.'
        },
        'workflow-configuration': {
            title: 'Рабочий конфиг',
            body: 'Вкладка «Рабочий конфиг» показывает человеческое название, реальный параметр в скобках, понятные опции и команду изменения. Сохранение запускает audited `garda workflow set`, если UI стартовал с `--actions`.'
        },
        'init-settings': {
            title: 'Init settings',
            body: 'Вкладка «Init settings» показывает текущие init answers, hard checkpoints агентского init и две основные команды: re-init для пересборки generated files и agent-init для завершения onboarding.'
        },
        'project-memory': {
            title: 'Память проекта',
            body: 'Вкладка «Память проекта» показывает текущий режим memory maintenance, состояние project memory из agent-init, read-first файлы и содержимое durable memory files.'
        },
        'workspace-actions': {
            title: 'Действия workspace',
            body: 'Вкладка «Действия» содержит фиксированные workspace-команды: status, doctor, генерацию HTML-отчёта, очистку runtime и переключение Garda. Команды конкретной задачи находятся в деталях выбранной задачи.'
        }
    }
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
