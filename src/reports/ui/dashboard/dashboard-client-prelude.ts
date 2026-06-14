import {
    LOCAL_UI_ACTION_CATEGORY_TEXT,
    LOCAL_UI_ACTION_TEXT,
    LOCAL_UI_INIT_SETTING_TEXT,
    LOCAL_UI_INSTRUCTION_TEXT,
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_PROJECT_MEMORY_TEXT,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT,
    type LocalUiLanguage
} from '../ui-i18n';

export interface DashboardClientPreludeOptions {
    actionToken: string;
    actionsEnabled: boolean;
    initialLanguage: LocalUiLanguage;
}

/** Browser-side dashboard DOM bindings and i18n pack constants. */
export function buildDashboardClientPrelude(options: DashboardClientPreludeOptions): string {
    const { actionToken, actionsEnabled, initialLanguage } = options;
    return `const languagePacks = ${JSON.stringify(LOCAL_UI_TEXT)};
const settingTextPacks = ${JSON.stringify(LOCAL_UI_SETTING_TEXT)};
const actionTextPacks = ${JSON.stringify(LOCAL_UI_ACTION_TEXT)};
const initSettingTextPacks = ${JSON.stringify(LOCAL_UI_INIT_SETTING_TEXT)};
const projectMemoryTextPacks = ${JSON.stringify(LOCAL_UI_PROJECT_MEMORY_TEXT)};
const actionCategoryTextPacks = ${JSON.stringify(LOCAL_UI_ACTION_CATEGORY_TEXT)};
const instructionTextPacks = ${JSON.stringify(LOCAL_UI_INSTRUCTION_TEXT)};
const languageMetadata = ${JSON.stringify(LOCAL_UI_LANGUAGES)};
const fallbackLanguage = 'en';
const initialLanguage = ${JSON.stringify(initialLanguage)};
const tasksNode = document.getElementById('tasks');
const detailNode = document.getElementById('detail');
const metaNode = document.getElementById('meta');
const warningsNode = document.getElementById('warnings');
const overviewNode = document.getElementById('overview');
const gardaSwitchNode = document.getElementById('garda-switch-panel');
const workflowNode = document.getElementById('workflow');
const workflowConfigPathNode = document.getElementById('workflow-config-path');
const settingsEditorNode = document.getElementById('settings-editor');
const settingStatusNode = document.getElementById('setting-status');
const instructionsNode = document.getElementById('instructions');
const initSettingsNode = document.getElementById('init-settings');
const projectMemoryNode = document.getElementById('project-memory');
const actionsNode = document.getElementById('actions');
const actionStatusNode = document.getElementById('action-status');
const cleanupSettingsNode = document.getElementById('cleanup-settings');
const cleanupStatusNode = document.getElementById('cleanup-status');
const sessionSummaryNode = document.getElementById('session-summary');
const sessionCountdownNode = document.getElementById('session-countdown');
const sessionActivityNode = document.getElementById('session-activity');
const sessionShutdownNode = document.getElementById('session-shutdown');
const languageSelectNode = document.getElementById('language-select');
const uiNoticeNode = document.getElementById('ui-notice');
const searchNode = document.getElementById('task-search');
const statusFilterNode = document.getElementById('status-filter');
const priorityFilterNode = document.getElementById('priority-filter');
const planModalNode = document.getElementById('plan-modal');
const planModalBodyNode = document.getElementById('plan-modal-body');
const planModalCloseNode = document.getElementById('plan-modal-close');
const actionToken = ${JSON.stringify(actionToken)};
const actionsEnabled = ${JSON.stringify(actionsEnabled)};
let currentReport = null;
let currentSession = null;
let currentActionsPayload = null;
let currentActionResult = null;
let currentSettingsPayload = null;
let currentSettingResult = null;
let currentTaskDetail = null;
let selectedTaskId = null;
let lastActivityPingAt = 0;
let sessionPollTimer = null;
const loadedTaskDetails = {};
`;
}
