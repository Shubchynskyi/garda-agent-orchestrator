import {
    LOCAL_UI_ACTION_CATEGORY_TEXT,
    LOCAL_UI_ACTION_TEXT,
    LOCAL_UI_INIT_SETTING_TEXT,
    LOCAL_UI_INSTRUCTION_TEXT,
    LOCAL_UI_LANGUAGES,
    LOCAL_UI_PROJECT_MEMORY_TEXT,
    LOCAL_UI_SETTING_TEXT,
    LOCAL_UI_TEXT,
    getLocalUiText,
    normalizeLocalUiLanguage,
    type LocalUiLanguage
} from './ui-i18n';

export function renderLocalUiHtml(actionsEnabled: boolean, actionToken: string, initialLanguage: LocalUiLanguage = 'en'): string {
    const language = normalizeLocalUiLanguage(initialLanguage);
    const text = getLocalUiText(language);
    return `<!doctype html>
<html lang="${language}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${text.appTitle}</title>
<style>
:root { color-scheme: light; --ink: #17202a; --muted: #667085; --line: #d9e0ea; --panel: #f6f8fb; --accent: #18715f; --blue: #2457a6; --warn: #9a5b00; --danger: #b42318; --danger-bg: #fff1f0; --ok: #17633a; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #fff; }
header { padding: 14px 22px 12px; border-bottom: 1px solid var(--line); background: #fbfcfe; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0; font-size: 18px; line-height: 1.25; letter-spacing: 0; }
h3 { margin: 0 0 8px; font-size: 15px; line-height: 1.3; letter-spacing: 0; }
p { margin: 0; }
button, input, select { font: inherit; }
button { display: inline-flex; align-items: center; justify-content: center; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 7px 10px; min-height: 34px; line-height: 1.15; text-align: center; cursor: pointer; }
button:hover:not(:disabled) { border-color: var(--accent); color: var(--accent); }
button:disabled { cursor: not-allowed; color: var(--muted); background: #f2f4f7; }
input, select { min-height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: #fff; color: var(--ink); }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 70vh; padding: 10px; background: #111827; color: #f9fafb; border-radius: 6px; }
.header-row { display: flex; justify-content: space-between; align-items: flex-start; gap: 18px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--muted); font-size: 13px; }
.top-controls { display: flex; justify-content: flex-end; align-items: center; flex: 0 0 180px; width: 180px; min-width: 180px; }
.language-compact { display: flex; align-items: center; justify-content: flex-end; gap: 6px; width: 180px; color: var(--muted); font-size: 13px; }
.language-compact span { flex: 0 0 56px; text-align: right; }
.language-compact select { flex: 0 0 112px; width: 112px; min-width: 112px; }
.session-compact { display: flex; align-items: center; justify-content: space-between; gap: 7px; flex: 0 0 410px; width: 410px; min-height: 34px; margin-left: auto; padding: 3px 4px 3px 9px; border: 1px solid var(--line); border-radius: 6px; background: #fff; font-size: 13px; }
.session-compact strong { color: var(--ink); }
.session-compact button { min-height: 28px; padding: 4px 7px; overflow: hidden; }
#session-activity { flex: 0 0 116px; width: 116px; }
#session-shutdown { flex: 0 0 154px; width: 154px; }
#session-summary { display: inline-block; flex: 0 0 98px; width: 98px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.session-warning { color: var(--warn); font-weight: 700; }
.session-stopping { color: var(--danger); font-weight: 700; }
nav { display: flex; align-items: flex-end; gap: 10px; padding: 10px 22px 0; border-bottom: 1px solid var(--line); background: #fbfcfe; }
.tab-buttons { display: flex; gap: 8px; flex: 0 0 856px; width: 856px; min-width: 0; overflow-x: auto; }
.tab-buttons button { flex: 0 0 136px; width: 136px; border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; overflow: hidden; white-space: nowrap; text-overflow: ellipsis; }
.tab-buttons button.active { color: #fff; background: var(--accent); border-color: var(--accent); }
main { padding: 16px 22px 26px; }
.tab[hidden] { display: none; }
.notice, .warnings, .panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.notice { padding: 12px; margin-bottom: 12px; background: #eef8f6; color: #145447; }
.warnings { padding: 12px; margin-bottom: 12px; background: #fff8e8; color: var(--warn); }
.panel { overflow: hidden; }
.panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.detail { padding: 14px; }
.tasks-layout { display: grid; grid-template-columns: minmax(460px, 1fr) minmax(380px, .8fr); gap: 14px; align-items: start; }
.task-list-panel, .task-detail-panel { min-width: 0; }
.toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(120px, 170px) minmax(120px, 170px); gap: 8px; }
.overview { display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; margin-bottom: 12px; }
.table-wrap { overflow: auto; }
.task-list-panel table { table-layout: fixed; }
.task-list-panel th:nth-child(1) { width: 118px; }
.task-list-panel th:nth-child(2) { width: 118px; }
.task-list-panel th:nth-child(3) { width: 82px; }
.task-list-panel th:nth-child(4) { width: 132px; }
.task-list-panel th:nth-child(5) { width: auto; }
.task-list-panel th:nth-child(6) { width: 102px; }
.task-list-panel th:nth-child(7) { width: 150px; }
.task-list-panel td:nth-child(2), .task-list-panel td:nth-child(3) { padding-left: 6px; padding-right: 6px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: #344054; position: sticky; top: 0; z-index: 1; }
tr.selected { background: #eef8f6; }
.task-id { font-weight: 700; color: var(--accent); }
.badge { display: inline-flex; align-items: center; justify-content: center; min-width: 72px; min-height: 24px; padding: 3px 7px; border-radius: 999px; background: #eef2f6; font-size: 12px; font-weight: 700; white-space: normal; text-align: center; line-height: 1.15; }
.task-list-panel .badge { width: 100%; }
.status-DONE { background: #e7f6ec; color: #17633a; }
.status-TODO { background: #eef2ff; color: #3442a0; }
.status-IN_PROGRESS, .status-IN_REVIEW { background: #fff4dc; color: #8a4b17; }
.status-BLOCKED { background: var(--danger-bg); color: var(--danger); }
.priority-P1 { background: #fdecec; color: #9b1c1c; }
.priority-P2 { background: #fff4dc; color: #8a4b17; }
.priority-P3 { background: #eef8f6; color: #145447; }
.data-full { background: #e7f6ec; color: var(--ok); }
.data-compact { background: #eef2f6; color: #344054; }
.data-blockers { background: var(--danger-bg); color: var(--danger); }
.empty { color: var(--muted); }
.error { color: var(--danger); }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.metric { min-height: 50px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.metric strong { overflow-wrap: anywhere; }
.kv { width: 100%; border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.kv div { display: grid; grid-template-columns: minmax(160px, .35fr) 1fr; border-bottom: 1px solid var(--line); }
.kv div:last-child { border-bottom: 0; }
.kv span, .kv strong { padding: 8px 10px; overflow-wrap: anywhere; }
.kv span { color: var(--muted); background: var(--panel); }
.list { margin: 8px 0 0; padding-left: 18px; }
.artifact-ok { color: var(--blue); }
.artifact-missing { color: var(--muted); }
.blocker-alert { padding: 10px; border: 1px solid #f3b6b1; border-radius: 6px; background: var(--danger-bg); color: var(--danger); font-weight: 700; }
.task-command-list { display: grid; gap: 10px; margin-top: 8px; }
.task-command-card { display: grid; gap: 7px; padding: 10px; border: 1px solid var(--line); border-left: 4px solid #c7d7f2; border-radius: 8px; background: #fff; }
.task-command-card p { color: var(--muted); }
.task-section-title { margin-top: 20px; }
.task-command-buttons { display: flex; flex-wrap: wrap; gap: 8px; }
.task-action-status { margin: 10px 0; }
.instruction-links { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.instruction-links button { flex: 0 0 136px; width: 136px; }
.workflow-head { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
.config-path { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; text-align: right; }
.workflow-state { margin-bottom: 12px; padding: 8px 10px; border-left: 4px solid var(--accent); background: #f3fbf8; color: #145447; }
.workflow-top-grid, .actions-top-grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(360px, .85fr); gap: 14px; align-items: start; }
.workflow-top-grid .detail, .actions-top-grid .detail { min-height: 156px; }
.workflow-group { margin-top: 16px; }
.workflow-table, .instruction-table, .action-table, .value-table, .memory-table { border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.workflow-table table, .instruction-table table, .action-table table, .value-table table, .memory-table table { table-layout: fixed; }
.workflow-table th:nth-child(1) { width: 23%; }
.workflow-table th:nth-child(2) { width: 27%; }
.workflow-table th:nth-child(3) { width: 14%; }
.workflow-table th:nth-child(4) { width: 18%; }
.workflow-table th:nth-child(5) { width: 18%; }
.workflow-table tbody tr:nth-child(even), .instruction-table tbody tr:nth-child(even), .action-table tbody tr:nth-child(even) { background: #fbfcfe; }
.workflow-table td:first-child, .instruction-table td:first-child, .action-table td:first-child { border-left: 4px solid #c7d7f2; background: #f7f9fc; }
.setting-title { display: grid; gap: 4px; }
.setting-parameter { color: var(--muted); font-size: 12px; }
.description-cell { line-height: 1.45; }
.option-list { display: grid; gap: 6px; }
.option-item { display: grid; gap: 3px; padding: 6px; border-left: 3px solid #c7d7f2; background: #f7f9fc; }
.option-item code { color: var(--blue); }
.current-value { display: inline-block; max-width: 100%; white-space: normal; overflow-wrap: anywhere; }
.setting-control { display: grid; gap: 6px; min-width: 150px; }
.setting-parameter { color: var(--muted); font-size: 12px; margin-bottom: 8px; }
.setting-options { margin: 8px 0; }
.setting-options li { margin-bottom: 5px; }
.setting-buttons, .action-buttons, .switch-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 8px; }
.setting-buttons button, .action-buttons button, .switch-buttons button, #tasks button[data-task-id] { flex: 0 0 138px; width: 138px; height: 42px; overflow: hidden; }
.setting-status, .action-status { margin-top: 12px; }
.action-section { margin-top: 12px; }
.action-table th:nth-child(1) { width: 20%; }
.action-table th:nth-child(2) { width: 30%; }
.action-table th:nth-child(3) { width: 14%; }
.action-table th:nth-child(4) { width: 20%; }
.action-table th:nth-child(5) { width: 16%; }
.action-kind { display: inline-flex; margin-top: 6px; min-width: 138px; min-height: 32px; align-items: center; justify-content: center; padding: 2px 7px; border-radius: 999px; background: var(--panel); color: var(--muted); font-size: 12px; font-weight: 700; text-align: center; }
.action-kind.mutates { background: #fff4dc; color: #8a4b17; }
.command-cell code, .description-cell code { background: #edf4ff; color: var(--blue); border: 1px solid #c7d7f2; border-radius: 4px; padding: 1px 4px; }
.command-preview { border-bottom: 1px solid var(--line); background: #f7fbfa; }
.command-preview-panel { display: grid; gap: 8px; max-width: 980px; }
.command-preview-panel h3 { color: var(--accent); }
.command-preview-main { padding: 9px 10px; border: 1px solid #b8d9d1; border-radius: 6px; background: #fff; overflow-wrap: anywhere; }
.command-preview-meta { display: grid; grid-template-columns: repeat(3, minmax(120px, 1fr)); gap: 8px; }
.command-preview-meta span { display: grid; gap: 3px; padding: 7px; background: #fff; border: 1px solid var(--line); border-radius: 6px; color: var(--muted); }
.command-preview-meta code { color: var(--ink); }
.instruction-table th:nth-child(1) { width: 24%; }
.instruction-table th:nth-child(2) { width: 76%; }
.value-table th:nth-child(1) { width: 25%; }
.value-table th:nth-child(2) { width: 45%; }
.value-table th:nth-child(3) { width: 30%; }
.memory-table th:nth-child(1) { width: 24%; }
.memory-table th:nth-child(2) { width: 36%; }
.memory-table th:nth-child(3) { width: 12%; }
.memory-table th:nth-child(4) { width: 14%; }
.memory-section { margin-top: 16px; }
.memory-file-content { margin-top: 10px; }
.memory-file-content h3 { margin-top: 18px; }
.memory-file-content pre { max-height: 55vh; }
.duration-control { display: grid; grid-template-columns: 1fr 1fr; gap: 6px; }
.duration-control label { display: grid; gap: 3px; color: var(--muted); font-size: 12px; }
.duration-help { display: block; color: var(--muted); font-size: 12px; margin-top: 4px; }
.modal-backdrop { position: fixed; inset: 0; z-index: 20; display: grid; place-items: center; padding: 24px; background: rgba(15, 23, 42, .45); }
.modal-backdrop[hidden] { display: none; }
.modal { width: min(960px, 96vw); max-height: 88vh; display: grid; grid-template-rows: auto 1fr; border-radius: 8px; border: 1px solid var(--line); background: #fff; box-shadow: 0 20px 80px rgba(15, 23, 42, .25); overflow: hidden; }
.modal-head { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.modal-body { padding: 14px; overflow: auto; }
.plan-meta { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 12px; }
.plan-meta div { padding: 8px; border: 1px solid var(--line); border-radius: 6px; background: var(--panel); }
.plan-meta span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 3px; }
.plan-content { color: var(--ink); background: #fff; border: 1px solid var(--line); max-height: none; }
.switch-strip { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; margin-bottom: 12px; border: 1px solid var(--line); border-radius: 8px; background: #f7fbfa; }
.switch-strip > div { min-width: 0; }
.switch-strip p { margin-top: 3px; color: var(--muted); font-size: 13px; }
.switch-strip .badge { margin-left: 6px; }
.switch-strip .badge { min-width: 156px; }
@media (max-width: 1060px) { .tasks-layout { grid-template-columns: 1fr; } .header-row { display: grid; grid-template-columns: 1fr 180px; } }
@media (max-width: 1160px) { nav { flex-wrap: wrap; } .session-compact { margin-left: 0; } }
@media (max-width: 860px) { .command-preview-meta, .workflow-top-grid, .actions-top-grid, .plan-meta { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .overview { grid-template-columns: repeat(2, minmax(120px, 1fr)); } .toolbar { grid-template-columns: 1fr; } .session-compact { flex: 1 1 100%; width: 100%; min-width: 0; } #session-summary { flex: 1 1 auto; width: auto; white-space: normal; } .switch-strip { align-items: flex-start; flex-direction: column; } }
@media (max-width: 640px) { header, main, nav { padding-left: 14px; padding-right: 14px; } th, td { padding: 8px; } .tab-buttons { flex: 1 1 100%; width: 100%; } .metrics { grid-template-columns: 1fr; } .header-row { grid-template-columns: 1fr; } .top-controls { justify-content: flex-end; justify-self: end; } }
</style>
</head>
<body>
<header>
<div class="header-row">
<div>
<h1 data-i18n="appTitle">${text.appTitle}</h1>
<div class="meta" id="meta" data-i18n="loadingWorkspaceReport">${text.loadingWorkspaceReport}</div>
</div>
<div class="top-controls" id="top-controls">
<label class="language-compact"><span data-i18n="languageTitle">${text.languageTitle}</span><select id="language-select"></select></label>
</div>
</div>
</header>
<nav>
<div class="tab-buttons">
<button type="button" class="active" data-tab="tasks-tab" data-i18n="tasksTab">${text.tasksTab}</button>
<button type="button" data-tab="workflow-tab" data-i18n="workflowTab">${text.workflowTab}</button>
<button type="button" data-tab="init-settings-tab" data-i18n="initSettingsTab">${text.initSettingsTab}</button>
<button type="button" data-tab="project-memory-tab" data-i18n="projectMemoryTab">${text.projectMemoryTab}</button>
<button type="button" data-tab="instructions-tab" data-i18n="instructionsTab">${text.instructionsTab}</button>
<button type="button" data-tab="actions-tab" data-i18n="actionsTab">${text.actionsTab}</button>
</div>
<div class="session-compact" id="server-status-panel">
<span id="session-summary" data-i18n="loadingServerSession">${text.loadingServerSession}</span>
<input id="session-countdown" type="range" min="0" max="60" value="60" disabled hidden>
<button type="button" id="session-activity" data-i18n="iAmHere">${text.iAmHere}</button>
<button type="button" id="session-shutdown" data-i18n="stopServer">${text.stopServer}</button>
</div>
</nav>
<main>
<section class="notice" id="ui-notice">${actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled}</section>
<section class="warnings" id="warnings" hidden></section>
<section class="switch-strip" id="garda-switch-panel" hidden></section>
<section class="tab" id="tasks-tab">
<div class="overview" id="overview"></div>
<div class="tasks-layout">
<section class="panel task-list-panel">
<div class="panel-head"><h2 data-i18n="tasksTab">${text.tasksTab}</h2></div>
<div class="panel-head">
<div class="toolbar">
<input id="task-search" type="search" placeholder="${text.searchTasks}" data-i18n-placeholder="searchTasks">
<select id="status-filter"><option value="">${text.allStatuses}</option></select>
<select id="priority-filter"><option value="">${text.allPriorities}</option></select>
</div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th data-i18n="idColumn">${text.idColumn}</th><th data-i18n="statusColumn">${text.statusColumn}</th><th data-i18n="priorityColumn">${text.priorityColumn}</th><th data-i18n="areaColumn">${text.areaColumn}</th><th data-i18n="titleColumn">${text.titleColumn}</th><th data-i18n="dataColumn">${text.dataColumn}</th><th data-i18n="actionColumn">${text.actionColumn}</th></tr></thead>
<tbody id="tasks"><tr><td colspan="7" class="empty" data-i18n="loading">${text.loading}</td></tr></tbody>
</table>
</div>
</section>
<section class="panel task-detail-panel" id="task-detail-panel">
<div class="panel-head"><h2 data-i18n="taskDetailTitle">${text.taskDetailTitle}</h2></div>
<div class="detail" id="detail"><p class="empty" data-i18n="chooseTask">${text.chooseTask}</p></div>
</section>
</div>
</section>
<section class="panel tab" id="workflow-tab" hidden>
<div class="panel-head workflow-head"><h2 data-i18n="workflowTab">${text.workflowTab}</h2><span class="config-path" id="workflow-config-path"></span></div>
<div class="workflow-top-grid">
<div class="detail" id="workflow"><p class="empty" data-i18n="loading">${text.loading}</p></div>
<div class="detail setting-status" id="setting-status"></div>
</div>
<div class="detail" id="settings-editor"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="init-settings-tab" hidden>
<div class="panel-head"><h2 data-i18n="initSettingsTab">${text.initSettingsTab}</h2></div>
<div class="detail" id="init-settings"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="project-memory-tab" hidden>
<div class="panel-head"><h2 data-i18n="projectMemoryTab">${text.projectMemoryTab}</h2></div>
<div class="detail" id="project-memory"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="instructions-tab" hidden>
<div class="panel-head"><h2 data-i18n="instructionsTab">${text.instructionsTab}</h2></div>
<div class="detail" id="instructions"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="actions-tab" hidden>
<div class="panel-head"><h2 data-i18n="actionsTab">${text.actionsTab}</h2></div>
<div class="detail">
<div class="actions-top-grid">
<p class="empty" data-i18n="actionsIntro">${text.actionsIntro}</p>
<div id="action-status" class="action-status empty"></div>
</div>
<div id="actions"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</div>
</section>
</main>
<div class="modal-backdrop" id="plan-modal" hidden>
<section class="modal" role="dialog" aria-modal="true" aria-labelledby="plan-modal-title">
<div class="modal-head"><h2 id="plan-modal-title" data-i18n="taskPlanTitle">${text.taskPlanTitle}</h2><button type="button" id="plan-modal-close" data-i18n="close">${text.close}</button></div>
<div class="modal-body" id="plan-modal-body"></div>
</section>
</div>
<script>
const languagePacks = ${JSON.stringify(LOCAL_UI_TEXT)};
const settingTextPacks = ${JSON.stringify(LOCAL_UI_SETTING_TEXT)};
const actionTextPacks = ${JSON.stringify(LOCAL_UI_ACTION_TEXT)};
const initSettingTextPacks = ${JSON.stringify(LOCAL_UI_INIT_SETTING_TEXT)};
const projectMemoryTextPacks = ${JSON.stringify(LOCAL_UI_PROJECT_MEMORY_TEXT)};
const actionCategoryTextPacks = ${JSON.stringify(LOCAL_UI_ACTION_CATEGORY_TEXT)};
const instructionTextPacks = ${JSON.stringify(LOCAL_UI_INSTRUCTION_TEXT)};
const languageMetadata = ${JSON.stringify(LOCAL_UI_LANGUAGES)};
const fallbackLanguage = 'en';
const initialLanguage = ${JSON.stringify(language)};
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
function normalizeLanguage(value) {
  return Object.prototype.hasOwnProperty.call(languagePacks, value) ? value : fallbackLanguage;
}
function readStoredLanguage() {
  try {
    return window.localStorage ? window.localStorage.getItem('garda.ui.language') : null;
  } catch {
    return null;
  }
}
let currentLanguage = normalizeLanguage(readStoredLanguage() || initialLanguage);
function t(key) {
  return (languagePacks[currentLanguage] && languagePacks[currentLanguage][key]) || languagePacks[fallbackLanguage][key] || key;
}
function localizedEntry(pack, id) {
  return (pack[currentLanguage] && pack[currentLanguage][id]) || (pack[fallbackLanguage] && pack[fallbackLanguage][id]) || null;
}
function localizedField(pack, id, field, fallback) {
  const entry = localizedEntry(pack, id);
  return entry && entry[field] ? entry[field] : fallback;
}
function localizedOption(pack, id, option, field, fallback) {
  const entry = localizedEntry(pack, id);
  if (entry && entry.options && entry.options[option.value] && entry.options[option.value][field]) {
    return entry.options[option.value][field];
  }
  if (option.value === 'true') {
    return field === 'label' ? (currentLanguage === 'ru' ? 'Включено' : option.label) : (currentLanguage === 'ru' ? 'Включает этот режим или guard.' : option.description);
  }
  if (option.value === 'false') {
    return field === 'label' ? (currentLanguage === 'ru' ? 'Отключено' : option.label) : (currentLanguage === 'ru' ? 'Отключает этот режим или guard.' : option.description);
  }
  return fallback;
}
function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function inlineText(value) {
  const tick = String.fromCharCode(96);
  const parts = String(value ?? '').split(new RegExp('(' + tick + '[^' + tick + ']*' + tick + ')', 'gu'));
  return parts.map(part => part.length >= 2 && part.startsWith(tick) && part.endsWith(tick)
    ? '<code>' + safe(part.slice(1, -1)) + '</code>'
    : safe(part)).join('');
}
function classToken(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9_-]+/g, '_');
}
function badge(value, prefix, extraClass) {
  const text = String(value || 'unknown');
  const css = extraClass || (safe(prefix || 'status') + '-' + classToken(text));
  return '<span class="badge ' + css + '">' + safe(text) + '</span>';
}
function metric(label, value) {
  return '<div class="metric"><span>' + safe(label) + '</span><strong>' + safe(value ?? '-') + '</strong></div>';
}
function workflowStatusText(status) {
  if (status === 'present') return t('workflowStatusPresent');
  if (status === 'missing') return t('workflowStatusMissing');
  if (status === 'invalid') return t('workflowStatusInvalid');
  return String(status || 'unknown');
}
function resultStatusText(status) {
  if (status === 'previewed') return t('resultStatusPreviewed');
  if (status === 'executed') return t('resultStatusExecuted');
  if (status === 'confirmation_required') return t('resultStatusConfirmationRequired');
  if (status === 'disabled') return t('resultStatusDisabled');
  return String(status || '-');
}
function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean).map(value => String(value)))).sort((a, b) => a.localeCompare(b));
}
function setOptions(select, values, allLabel) {
  const previous = select.value;
  select.innerHTML = '<option value="">' + safe(allLabel) + '</option>' + values.map(value => '<option value="' + safe(value) + '">' + safe(value) + '</option>').join('');
  select.value = values.includes(previous) ? previous : '';
}
function renderLanguageSelector() {
  languageSelectNode.innerHTML = languageMetadata.map(language => '<option value="' + safe(language.id) + '">' + safe(language.nativeLabel) + '</option>').join('');
  languageSelectNode.value = currentLanguage;
}
function applyLanguage() {
  if (document.documentElement) {
    document.documentElement.lang = currentLanguage;
  }
  for (const element of document.querySelectorAll('[data-i18n]')) {
    element.textContent = t(element.getAttribute('data-i18n'));
  }
  for (const element of document.querySelectorAll('[data-i18n-placeholder]')) {
    element.setAttribute('placeholder', t(element.getAttribute('data-i18n-placeholder')));
  }
  uiNoticeNode.textContent = actionsEnabled ? t('noticeActionsEnabled') : t('noticeActionsDisabled');
  renderLanguageSelector();
  if (currentReport) {
    renderTasks(currentReport);
  }
  if (currentSession) {
    renderSession(currentSession);
  }
  if (currentActionsPayload) {
    renderActions(currentActionsPayload);
  }
  if (currentSettingsPayload) {
    renderSettingsEditor(currentSettingsPayload);
  }
  if (currentSettingResult) {
    renderSettingResult(currentSettingResult);
  }
  if (currentActionResult) {
    renderActionResult(currentActionResult);
  }
  if (currentTaskDetail) {
    renderTaskDetail(currentTaskDetail);
  }
}
function formatSeconds(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value)) {
    return '-';
  }
  const normalized = Math.max(0, Math.ceil(value));
  if (normalized < 60) {
    return normalized + 's';
  }
  return Math.ceil(normalized / 60) + 'm';
}
function formatDurationMs(value) {
  const ms = Number(value);
  if (!Number.isFinite(ms)) {
    return '-';
  }
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes + 'm ' + seconds + 's (' + Math.trunc(ms) + ' ms)';
}
function durationPartsFromMs(value) {
  const ms = Number(value);
  const totalSeconds = Number.isFinite(ms) ? Math.max(0, Math.round(ms / 1000)) : 0;
  return {
    minutes: Math.floor(totalSeconds / 60),
    seconds: totalSeconds % 60
  };
}
function isDurationMsSetting(setting) {
  return setting && setting.value_type === 'integer' && String(setting.key || '').endsWith('_ms');
}
function renderOverview(report) {
  const rows = report.tasks_tab.rows;
  const active = rows.filter(task => !['DONE', 'BLOCKED', 'DECOMPOSED'].includes(task.status_token || '')).length;
  const done = rows.filter(task => (task.status_token || '') === 'DONE').length;
  const blocked = rows.filter(task => (task.status_token || '') === 'BLOCKED').length;
  overviewNode.innerHTML = metric(t('overviewTasks'), rows.length)
    + metric(t('overviewActive'), active)
    + metric(t('overviewDone'), done)
    + metric(t('overviewBlocked'), blocked)
    + metric(t('overviewWarnings'), report.unavailable.length);
}
function matchesFilters(task) {
  const query = String(searchNode.value || '').trim().toLowerCase();
  const status = statusFilterNode.value;
  const priority = priorityFilterNode.value;
  const haystack = [task.task_id, task.status, task.priority, task.area, task.title, task.owner, task.notes].join(' ').toLowerCase();
  return (!query || haystack.includes(query))
    && (!status || (task.status_token || task.status) === status)
    && (!priority || task.priority === priority);
}
function findReportTask(taskId) {
  return currentReport ? currentReport.tasks_tab.rows.find(task => task.task_id === taskId) || null : null;
}
function isTerminalTask(task) {
  return ['DONE', 'DECOMPOSED'].includes(task && (task.status_token || task.status));
}
function taskDataBadge(task) {
  const detail = loadedTaskDetails[task.task_id];
  if (detail || task.detail.detail_status === 'loaded') {
    return badge(t('dataFull'), 'data', 'data-full');
  }
  return isTerminalTask(task)
    ? badge(t('dataCompact'), 'data', 'data-compact')
    : badge(t('dataOnDemand'), 'data', 'data-compact');
}
function renderTasks(report) {
  currentReport = report;
  metaNode.textContent = t('metaRepo') + ': ' + report.repo_root + ' | ' + t('metaTasks') + ': ' + report.tasks_tab.rows.length + ' | ' + t('metaWarnings') + ': ' + report.unavailable.length;
  if (report.unavailable.length > 0) {
    warningsNode.hidden = false;
    warningsNode.innerHTML = '<strong>' + safe(t('warningsTitle')) + '</strong><ul>' + report.unavailable.map(item => '<li><code>' + safe(item.scope) + '</code>: ' + safe(item.reason) + '</li>').join('') + '</ul>';
  } else {
    warningsNode.hidden = true;
    warningsNode.innerHTML = '';
  }
  renderOverview(report);
  setOptions(statusFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.status_token || task.status)), t('allStatuses'));
  setOptions(priorityFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.priority)), t('allPriorities'));
  renderTaskRows();
  renderWorkflow(report);
  renderInitSettings(report);
  renderProjectMemory(report);
  renderInstructions(report);
}
function renderTaskRows() {
  const rows = currentReport ? currentReport.tasks_tab.rows.filter(matchesFilters) : [];
  if (rows.length === 0) {
    tasksNode.innerHTML = '<tr><td colspan="7" class="empty">' + safe(t('noMatchingTasks')) + '</td></tr>';
    return;
  }
  tasksNode.innerHTML = rows.map(task => {
    const selected = task.task_id === selectedTaskId ? ' class="selected"' : '';
    return '<tr data-task-id="' + safe(task.task_id) + '"' + selected + '><td><span class="task-id">' + safe(task.task_id) + '</span></td><td>' + badge(task.status_token || task.status, 'status') + '</td><td>' + badge(task.priority, 'priority') + '</td><td>' + safe(task.area) + '</td><td>' + safe(task.title) + '</td><td>' + taskDataBadge(task) + '</td><td><button type="button" data-task-id="' + safe(task.task_id) + '">' + safe(t('loadDetails')) + '</button></td></tr>';
  }).join('');
  for (const button of tasksNode.querySelectorAll('button[data-task-id]')) {
    button.addEventListener('click', () => loadDetail(button.dataset.taskId));
  }
}
function renderWorkflow(report) {
  const tab = report.workflow_config_tab;
  workflowConfigPathNode.textContent = tab && tab.config_path ? '(' + tab.config_path + ')' : '';
  const unavailable = tab && tab.unavailable ? tab.unavailable : [];
  if (unavailable.length > 0) {
    workflowNode.innerHTML = '<div class="blocker-alert"><strong>' + safe(t('workflowWarningTitle')) + ':</strong> ' + safe(unavailable.map(item => item.reason).join(' ')) + '</div>';
    return;
  }
  workflowNode.innerHTML = '<p class="workflow-state">' + safe(workflowStatusText(tab ? tab.status : 'missing')) + '</p>';
}
function renderSettingResult(result) {
  currentSettingResult = result;
  const label = localizedField(settingTextPacks, result.setting_id, 'label', result.label || result.key || result.setting_id || t('setting'));
  settingStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3>'
    + '<p class="empty">' + safe(t('workflowCommandPreviewHelp')) + '</p>'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong><br><code>' + safe(result.command || '-') + '</code></div>'
    + '<div class="command-preview-meta">'
    + '<span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span>'
    + '<span>' + safe(t('current')) + '<code>' + safe(JSON.stringify(result.current_value)) + '</code></span>'
    + '<span>' + safe(t('proposed')) + '<code>' + safe(JSON.stringify(result.proposed_value)) + '</code></span>'
    + '</div>'
    + (result.changed_keys && result.changed_keys.length > 0 ? '<p><strong>' + safe(t('changedKey')) + ':</strong> <code>' + safe(result.changed_keys.join(', ')) + '</code></p>' : '')
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
}
async function submitSetting(settingId, mode, value, confirmation) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ setting_id: settingId, mode, value, confirmation })
  });
  const result = await response.json();
  renderSettingResult(result);
  if (result && result.status === 'executed') {
    await refreshSettingsPayload();
    if (currentReport) {
      fetch('/api/report').then(reportResponse => reportResponse.json()).then(report => {
        currentReport = report;
        renderWorkflow(report);
      }).catch(() => undefined);
    }
  }
}
function settingInputValue(setting) {
  if (Array.isArray(setting.current_value)) {
    return setting.current_value.join(',');
  }
  if (typeof setting.current_value === 'boolean') {
    return String(setting.current_value);
  }
  return setting.current_value === null || setting.current_value === undefined ? '' : String(setting.current_value);
}
function renderSettingOptions(setting) {
  if (!setting.options || setting.options.length === 0) {
    return '<div class="option-item"><strong>' + safe(t('noFixedOptions')) + '</strong><span>' + safe(t('freeValueHelp')) + '</span></div>';
  }
  return '<div class="option-list">' + setting.options.map(option => '<div class="option-item"><strong>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' <code>' + safe(option.value) + '</code></strong><span>' + inlineText(localizedOption(settingTextPacks, setting.id, option, 'description', option.description)) + '</span></div>').join('') + '</div>';
}
function renderSettingControl(setting, disabled) {
  const inputValue = settingInputValue(setting);
  const disabledAttr = disabled ? ' disabled' : '';
  const controlId = 'setting-input-' + safe(setting.id);
  if (isDurationMsSetting(setting)) {
    const parts = durationPartsFromMs(setting.current_value);
    return '<div class="duration-control" data-setting-id="' + safe(setting.id) + '"><label>' + safe(t('minutesLabel')) + '<input id="' + controlId + '-minutes" type="number" min="0" value="' + safe(parts.minutes) + '"' + disabledAttr + '></label><label>' + safe(t('secondsLabel')) + '<input id="' + controlId + '-seconds" type="number" min="0" max="59" value="' + safe(parts.seconds) + '"' + disabledAttr + '></label></div><span class="duration-help">' + safe(t('durationStoredAsMs')) + '</span>';
  }
  if (setting.options && setting.options.length > 0) {
    return '<select id="' + controlId + '"' + disabledAttr + '>' + setting.options.map(option => '<option value="' + safe(option.value) + '"' + (String(option.value) === inputValue ? ' selected' : '') + '>' + safe(localizedOption(settingTextPacks, setting.id, option, 'label', option.label)) + ' (' + safe(option.value) + ')</option>').join('') + '</select>';
  }
  if (setting.value_type === 'integer') {
    return '<input id="' + controlId + '" type="number" min="' + safe(setting.min || 1) + '" max="' + safe(setting.max || '') + '" value="' + safe(inputValue) + '"' + disabledAttr + '>';
  }
  return '<input id="' + controlId + '" type="text" value="' + safe(inputValue) + '" placeholder="' + safe(setting.placeholder || '') + '"' + disabledAttr + '>';
}
function settingGroupId(setting) {
  const key = String(setting.key || '');
  if (key.startsWith('full_suite_validation.')) return 'validation';
  if (key.startsWith('review_execution_policy.') || key.startsWith('review_cycle_guard.')) return 'review';
  if (key.startsWith('scope_budget_guard.')) return 'scope';
  if (key.startsWith('project_memory_maintenance.')) return 'memory';
  return 'safety';
}
function settingGroupLabel(groupId) {
  if (groupId === 'validation') return t('workflowGroupValidation');
  if (groupId === 'review') return t('workflowGroupReview');
  if (groupId === 'scope') return t('workflowGroupScope');
  if (groupId === 'memory') return t('workflowGroupMemory');
  return t('workflowGroupSafety');
}
function renderSettingRow(setting, disabled) {
  const label = localizedField(settingTextPacks, setting.id, 'label', setting.label);
  const description = localizedField(settingTextPacks, setting.id, 'description', setting.description);
  return '<tr>'
    + '<td><div class="setting-title"><strong>' + safe(label) + '</strong><code>(' + safe(setting.key) + ')</code><span class="setting-parameter"><code>' + safe(setting.flag) + '</code></span></div></td>'
    + '<td class="description-cell">' + inlineText(description) + '</td>'
    + '<td><code class="current-value">' + safe(isDurationMsSetting(setting) ? formatDurationMs(setting.current_value) : JSON.stringify(setting.current_value)) + '</code></td>'
    + '<td>' + renderSettingOptions(setting) + '</td>'
    + '<td><label class="setting-control"><span>' + safe(t('newValue')) + '</span>' + renderSettingControl(setting, disabled) + '</label><div class="setting-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="preview"' + (disabled ? ' disabled' : '') + '>' + safe(t('previewCommand')) + '</button><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="execute"' + (disabled ? ' disabled' : '') + '>' + safe(disabled ? t('saveDisabled') : t('save')) + '</button></div></td>'
    + '</tr>';
}
function renderSettingsEditor(payload) {
  currentSettingsPayload = payload;
  const settings = payload.settings || [];
  if (settings.length === 0) {
    settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3><p class="empty">' + safe(t('noEditableSettings')) + '</p>';
    return;
  }
  const disabled = !payload.enabled;
  const disabledNotice = disabled
    ? '<p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>'
    : '<p class="empty">' + safe(t('guardedEditorHelp')) + '</p>';
  const groupOrder = ['validation', 'review', 'scope', 'memory', 'safety'];
  if (!currentSettingResult) {
    settingStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3><p class="empty">' + safe(t('workflowCommandPreviewHelp')) + '</p></section>';
  }
  settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3>' + disabledNotice
    + groupOrder.map(groupId => {
      const groupSettings = settings.filter(setting => settingGroupId(setting) === groupId);
      if (groupSettings.length === 0) return '';
      return '<section class="workflow-group"><h3>' + safe(settingGroupLabel(groupId)) + '</h3><div class="workflow-table"><table><thead><tr><th>' + safe(t('configSettingColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('currentValueColumn')) + '</th><th>' + safe(t('optionsColumn')) + '</th><th>' + safe(t('changeColumn')) + '</th></tr></thead><tbody>' + groupSettings.map(setting => renderSettingRow(setting, disabled)).join('') + '</tbody></table></div></section>';
    }).join('');
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const input = document.getElementById('setting-input-' + button.dataset.settingId);
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, settingSubmitValue(setting, input), confirmation);
    });
  }
}
async function refreshSettingsPayload() {
  const response = await fetch('/api/settings');
  renderSettingsEditor(await response.json());
}
function settingSubmitValue(setting, fallbackInput) {
  if (isDurationMsSetting(setting)) {
    const minutesInput = document.getElementById('setting-input-' + setting.id + '-minutes');
    const secondsInput = document.getElementById('setting-input-' + setting.id + '-seconds');
    const minutes = Math.max(0, Math.trunc(Number(minutesInput ? minutesInput.value : 0) || 0));
    const seconds = Math.max(0, Math.min(59, Math.trunc(Number(secondsInput ? secondsInput.value : 0) || 0)));
    return String((minutes * 60 + seconds) * 1000);
  }
  return fallbackInput ? fallbackInput.value : '';
}
function localizedValueRow(row) {
  return {
    label: localizedField(initSettingTextPacks, row.id, 'label', row.label),
    description: localizedField(initSettingTextPacks, row.id, 'description', row.description)
  };
}
function renderJsonValue(value) {
  if (Array.isArray(value)) {
    return value.length === 0 ? '-' : value.join(', ');
  }
  if (value === null || value === undefined || value === '') {
    return '-';
  }
  if (typeof value === 'object') {
    return JSON.stringify(value);
  }
  return String(value);
}
function renderValueTable(rows) {
  if (!rows || rows.length === 0) {
    return '<p class="empty">' + safe(t('noInitSettings')) + '</p>';
  }
  return '<div class="value-table"><table><thead><tr><th>' + safe(t('fieldColumn')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('valueColumn')) + '</th></tr></thead><tbody>'
    + rows.map(row => {
      const localized = localizedValueRow(row);
      return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(row.id) + '</code></td><td class="description-cell">' + inlineText(localized.description) + '</td><td><code class="current-value">' + safe(renderJsonValue(row.value)) + '</code></td></tr>';
    }).join('')
    + '</tbody></table></div>';
}
function initStatusText(status) {
  if (status === 'present') return t('initStatusPresent');
  if (status === 'missing') return t('initStatusMissing');
  if (status === 'invalid') return t('initStatusInvalid');
  return String(status || 'unknown');
}
function renderInitSettings(report) {
  const tab = report.init_settings_tab || {};
  const commands = tab.commands || [];
  initSettingsNode.innerHTML = '<section class="workflow-group"><h3>' + safe(t('initBlockTitle')) + ' <span class="config-path">(' + safe(tab.init_answers_path || '-') + ')</span></h3>'
    + '<p class="workflow-state">' + safe(initStatusText(tab.init_answers_status)) + '</p>' + renderValueTable(tab.init_answers || []) + '</section>'
    + '<section class="workflow-group"><h3>' + safe(t('agentInitBlockTitle')) + ' <span class="config-path">(' + safe(tab.agent_init_state_path || '-') + ')</span></h3>'
    + '<p class="workflow-state">' + safe(initStatusText(tab.agent_init_state_status)) + '</p>' + renderValueTable(tab.agent_init_state || []) + '</section>'
    + '<section class="workflow-group"><h3>' + safe(t('initCommandsTitle')) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th></tr></thead><tbody>'
    + commands.map(command => '<tr><td><strong>' + safe(localizedField(initSettingTextPacks, command.id, 'title', command.title)) + '</strong></td><td class="description-cell">' + inlineText(localizedField(initSettingTextPacks, command.id, 'description', command.description)) + '</td><td class="command-cell"><code>' + safe(command.command) + '</code></td></tr>').join('')
    + '</tbody></table></div></section>';
}
function localizedMemoryFile(file) {
  return {
    label: localizedField(projectMemoryTextPacks, file.path, 'label', file.path),
    description: localizedField(projectMemoryTextPacks, file.path, 'description', file.purpose)
  };
}
function renderProjectMemory(report) {
  const tab = report.project_memory_tab || {};
  const files = tab.files || [];
  projectMemoryNode.innerHTML = '<section class="memory-section"><h3>' + safe(t('projectMemoryStatusTitle')) + '</h3>' + renderValueTable(tab.status || []) + '</section>'
    + '<section class="memory-section"><h3>' + safe(t('projectMemoryFilesTitle')) + '</h3>'
    + (files.length === 0 ? '<p class="empty">' + safe(t('noProjectMemoryFiles')) + '</p>' : '<div class="memory-table"><table><thead><tr><th>' + safe(t('fileColumn')) + '</th><th>' + safe(t('purposeColumn')) + '</th><th>' + safe(t('sizeColumn')) + '</th><th>' + safe(t('openColumn')) + '</th></tr></thead><tbody>'
      + files.map(file => {
        const localized = localizedMemoryFile(file);
        return '<tr><td><strong>' + safe(localized.label) + '</strong><br><code>' + safe(file.path) + '</code></td><td class="description-cell">' + safe(localized.description) + '</td><td><code>' + safe(file.size_bytes === null ? '-' : file.size_bytes) + '</code></td><td>' + (file.exists ? '<a href="#memory-' + safe(file.id) + '">' + safe(t('openMemoryFile')) + '</a>' : '<span class="empty">' + safe(t('missing')) + '</span>') + '</td></tr>';
      }).join('') + '</tbody></table></div>')
    + '</section><section class="memory-file-content">'
    + files.filter(file => file.exists).map(file => '<h3 id="memory-' + safe(file.id) + '">' + safe(file.path) + '</h3><pre>' + safe(file.content || '') + '</pre>').join('')
    + '</section>';
}
function renderInstructions(report) {
  const entries = report.instructions_tab.entries || [];
  instructionsNode.innerHTML = entries.length === 0
    ? '<p class="empty">' + safe(t('noInstructions')) + '</p>'
    : '<div class="instruction-table"><table><thead><tr><th>' + safe(t('instructionAreaColumn')) + '</th><th>' + safe(t('instructionDescriptionColumn')) + '</th></tr></thead><tbody>' + entries.map(entry => {
      const id = entry.id || entry.title;
      const title = localizedField(instructionTextPacks, id, 'title', entry.title);
      const body = localizedField(instructionTextPacks, id, 'body', entry.body);
      return '<tr><td><strong>' + safe(title) + '</strong></td><td class="description-cell">' + inlineText(body) + instructionLinks(id) + '</td></tr>';
    }).join('') + '</tbody></table></div>';
  for (const button of instructionsNode.querySelectorAll('button[data-instruction-tab]')) {
    button.addEventListener('click', () => {
      const target = button.dataset.instructionTab;
      const tabButton = Array.from(document.querySelectorAll('nav button[data-tab]')).find(candidate => candidate.dataset.tab === target);
      if (tabButton) {
        tabButton.click();
      }
    });
  }
}
function instructionLinks(id) {
  const links = [];
  if (id === 'task-inspection' || id === 'task-execution') {
    links.push(['tasks-tab', t('tasksTab')]);
  }
  if (id === 'workflow-configuration' || id === 'review-execution-modes' || id === 'workflow-guards') {
    links.push(['workflow-tab', t('workflowTab')]);
  }
  if (id === 'workspace-actions') {
    links.push(['actions-tab', t('actionsTab')]);
  }
  if (id === 'init-settings') {
    links.push(['init-settings-tab', t('initSettingsTab')]);
  }
  if (id === 'project-memory') {
    links.push(['project-memory-tab', t('projectMemoryTab')]);
  }
  if (links.length === 0) {
    return '';
  }
  return '<div class="instruction-links">' + links.map(([tabId, label]) => '<button type="button" data-instruction-tab="' + safe(tabId) + '">' + safe(label) + '</button>').join('') + '</div>';
}
function artifactList(links) {
  if (!links || links.length === 0) {
    return '<p class="empty">' + safe(t('noArtifacts')) + '</p>';
  }
  const existing = links.filter(link => link.exists).length;
  const missing = links.length - existing;
  return '<p class="empty">' + safe(t('existingArtifacts')) + ': ' + safe(existing) + ' | ' + safe(t('missingArtifacts')) + ': ' + safe(missing) + '</p><ul class="list">' + links.map(link => '<li class="' + (link.exists ? 'artifact-ok' : 'artifact-missing') + '"><code>' + safe(link.kind) + '</code>: ' + safe(link.path) + (link.exists ? '' : ' (' + safe(t('missing')) + ')') + '</li>').join('') + '</ul>';
}
async function postSession(path) {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({})
  });
  return response.json();
}
function renderSession(session) {
  currentSession = session;
  if (!session || !session.enabled) {
    sessionSummaryNode.innerHTML = safe(t('idleShutdownDisabled'));
    sessionCountdownNode.max = '1';
    sessionCountdownNode.value = '1';
    return;
  }
  const warningSeconds = Number(session.seconds_until_warning || 0);
  const shutdownSeconds = Number(session.seconds_until_shutdown || 0);
  const totalShutdownSeconds = session.state === 'active'
    ? warningSeconds
    : shutdownSeconds;
  sessionCountdownNode.max = String(Math.max(1, Number(session.warning_seconds || 1)));
  sessionCountdownNode.value = String(session.state === 'warning' ? Math.max(0, shutdownSeconds) : Number(session.warning_seconds || 1));
  if (session.state === 'stopping') {
    sessionSummaryNode.innerHTML = '<span class="session-stopping">' + safe(t('stopping')) + '</span>';
    return;
  }
  if (session.state === 'warning') {
    sessionSummaryNode.innerHTML = '<strong class="session-warning">' + safe(t('shutdownIn')) + ':</strong> ' + safe(formatSeconds(totalShutdownSeconds));
    return;
  }
  sessionSummaryNode.innerHTML = '<strong>' + safe(t('shutdownIn')) + ':</strong> ' + safe(formatSeconds(totalShutdownSeconds));
}
async function refreshSession() {
  try {
    const response = await fetch('/api/session');
    renderSession(await response.json());
  } catch (error) {
    sessionSummaryNode.innerHTML = '<span class="session-stopping">' + safe(t('serverUnavailable')) + ' <code>garda ui</code> ' + safe(t('serverUnavailableTail')) + '</span>';
    if (sessionPollTimer) {
      clearInterval(sessionPollTimer);
      sessionPollTimer = null;
    }
  }
}
async function markActivity(force) {
  const now = Date.now();
  if (!force && now - lastActivityPingAt < 10000) {
    return;
  }
  lastActivityPingAt = now;
  try {
    renderSession(await postSession('/api/session/activity'));
  } catch {
    await refreshSession();
  }
}
function renderActionResult(result) {
  currentActionResult = result;
  const actionId = result.action_id || '';
  const label = localizedField(actionTextPacks, actionId, 'label', actionId || t('action'));
  actionStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3>'
    + '<div class="command-preview-main"><strong>' + safe(label) + '</strong><br><code>' + safe(result.command || '-') + '</code></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
}
function outputBlock(label, value) {
  if (!value) {
    return '';
  }
  return '<details open><summary>' + safe(label) + ' (' + safe(String(value.length)) + ' chars)</summary><pre>' + safe(value) + '</pre></details>';
}
async function runAction(actionId, mode, confirmation) {
  const response = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  renderActionResult(result);
  if (actionId === 'garda-on' || actionId === 'garda-off') {
    await refreshActionsPayload();
  }
}
function actionLabel(action) {
  return localizedField(actionTextPacks, action.id, 'label', action.label);
}
function actionDescription(action) {
  return localizedField(actionTextPacks, action.id, 'description', action.description);
}
function actionCategoryLabel(category) {
  return (actionCategoryTextPacks[currentLanguage] && actionCategoryTextPacks[currentLanguage][category])
    || (actionCategoryTextPacks[fallbackLanguage] && actionCategoryTextPacks[fallbackLanguage][category])
    || category;
}
function actionChangeLabel(action) {
  if (!action.mutates) return t('safeAction');
  if (action.id === 'html-report') return t('htmlReportMutation');
  if (action.id === 'cleanup-apply') return t('cleanupMutation');
  if (action.id === 'garda-on' || action.id === 'garda-off') return t('gardaSwitchMutation');
  return t('mutatingAction');
}
function switchStateText(state) {
  if (state === 'on') return t('gardaSwitchStateOn');
  if (state === 'off') return t('gardaSwitchStateOff');
  return t('gardaSwitchStateUnknown');
}
function wireActionButtons(rootNode, actions) {
  for (const button of rootNode.querySelectorAll('button[data-action-id]')) {
    button.addEventListener('click', () => {
      const action = actions.find(item => item.id === button.dataset.actionId);
      const mode = button.dataset.actionMode;
      const confirmation = mode === 'execute' && action && action.requires_confirmation
        ? window.prompt(t('typeToRunAction') + ' "' + action.confirmation_phrase + '" ' + t('typeToRunActionTail'))
        : null;
      if (mode === 'execute' && action && action.requires_confirmation && confirmation === null) {
        return;
      }
      runAction(button.dataset.actionId, mode, confirmation);
    });
  }
}
function renderGardaSwitch(payload) {
  const state = payload.switch_state || 'unknown';
  const stateClass = state === 'on' ? 'data-full' : state === 'off' ? 'data-compact' : 'data-blockers';
  const actions = payload.actions || [];
  const desiredActionIds = state === 'off' ? ['garda-on'] : state === 'on' ? ['garda-off'] : ['garda-on', 'garda-off'];
  const buttons = !payload.enabled
    ? '<span class="empty">' + safe(t('gardaSwitchActionsDisabled')) + ' <code>garda ui --actions</code></span>'
    : state === 'unknown'
      ? '<span class="empty">' + safe(t('gardaSwitchUnavailable')) + '</span>'
      : desiredActionIds.map(actionId => {
        const action = actions.find(item => item.id === actionId);
        if (!action) return '';
        const label = actionId === 'garda-on' ? t('turnGardaOn') : t('turnGardaOff');
        return '<button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(label) + '</button>';
      }).join('');
  const help = state === 'unknown' ? t('gardaSwitchUnknownHelp') : t('gardaSwitchHelp');
  gardaSwitchNode.hidden = false;
  gardaSwitchNode.innerHTML = '<div><strong>' + safe(t('gardaSwitchTitle')) + '</strong><span class="badge ' + stateClass + '">' + safe(t('gardaSwitchState')) + ': ' + safe(switchStateText(state)) + '</span><p>' + safe(help) + '</p></div><div class="switch-buttons">' + buttons + '</div>';
  if (payload.enabled && state !== 'unknown') {
    wireActionButtons(gardaSwitchNode, actions);
  }
}
function renderActions(payload) {
  currentActionsPayload = payload;
  renderGardaSwitch(payload);
  if (!payload.enabled) {
    actionsNode.innerHTML = '<p class="empty">' + safe(t('actionsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('actionsDisabledTail')) + '</p><p class="empty">' + safe(t('actionsTaskMoved')) + '</p>';
    return;
  }
  if (!currentActionResult) {
    actionStatusNode.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3><p class="empty">' + safe(t('actionsPreviewHelp')) + '</p></section>';
  }
  const categories = uniqueSorted(payload.actions.map(action => action.category || 'Workspace'));
  actionsNode.innerHTML = categories.map(category => {
    const actions = payload.actions.filter(action => (action.category || 'Workspace') === category);
    return '<section class="action-section"><h3>' + safe(actionCategoryLabel(category)) + '</h3><div class="action-table"><table><thead><tr><th>' + safe(t('action')) + '</th><th>' + safe(t('descriptionColumn')) + '</th><th>' + safe(t('actionEffectColumn')) + '</th><th>' + safe(t('commandColumn')) + '</th><th>' + safe(t('actionRunColumn')) + '</th></tr></thead><tbody>'
      + actions.map(action => '<tr><td><strong>' + safe(actionLabel(action)) + '</strong></td><td class="description-cell">' + inlineText(actionDescription(action)) + '</td><td><span class="action-kind' + (action.mutates ? ' mutates' : '') + '">' + safe(actionChangeLabel(action)) + '</span></td><td class="command-cell"><code>' + safe(action.command) + '</code></td><td><div class="action-buttons"><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="preview">' + safe(t('previewCommand')) + '</button><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(t('run')) + '</button></div></td></tr>').join('')
      + '</tbody></table></div></section>';
  }).join('');
  wireActionButtons(actionsNode, payload.actions);
}
async function refreshActionsPayload() {
  const response = await fetch('/api/actions');
  renderActions(await response.json());
}
function reviewSummary(audit) {
  const summary = audit && audit.review_attempt_summary && (audit.review_attempt_summary.by_type || audit.review_attempt_summary.review_types);
  if (!summary || summary.length === 0) {
    return '<p class="empty">' + safe(t('noReviewAttempts')) + '</p>';
  }
  return '<ul class="list">' + summary.map(item => '<li><code>' + safe(item.review_type) + '</code>: pass=' + safe(item.pass_count) + ', fail=' + safe(item.fail_count) + ', reused=' + safe(item.reused_count) + '</li>').join('') + '</ul>';
}
function taskCommandList(taskId) {
  const commands = [
    ['task-next-step', t('taskCommandNextStep'), t('taskCommandNextStepDescription'), 'garda next-step "' + taskId + '" --repo-root "."', true],
    ['task-stats', t('taskCommandStats'), t('taskCommandStatsDescription'), 'garda task "' + taskId + '" stats --target-root "."', false],
    ['task-events', t('taskCommandEvents'), t('taskCommandEventsDescription'), 'garda task "' + taskId + '" events --target-root "."', false]
  ];
  return '<div class="task-command-list">' + commands.map(([id, label, description, command, mutates]) => '<section class="task-command-card"><strong>' + safe(label) + '</strong><p>' + safe(description) + '</p><code>' + safe(command) + '</code>'
    + (actionsEnabled
      ? '<div class="task-command-buttons"><button type="button" data-task-action-id="' + safe(id) + '" data-task-action-mode="execute">' + safe(t('run')) + '</button>' + (mutates ? '<span class="action-kind mutates">' + safe(t('mutatingAction')) + '</span>' : '<span class="action-kind">' + safe(t('safeAction')) + '</span>') + '</div>'
      : '<p class="empty">' + inlineText(t('taskCommandUnavailable')) + '</p>')
    + '</section>').join('') + '</div>';
}
function blockerText(item) {
  if (typeof item === 'string') {
    return item;
  }
  if (item && typeof item === 'object') {
    const gate = item.gate ? String(item.gate) : '';
    const reason = item.reason ? String(item.reason) : JSON.stringify(item);
    return gate ? gate + ': ' + reason : reason;
  }
  return String(item ?? '');
}
function auditDiagnosticsList(blockers) {
  if (!blockers || blockers.length === 0) {
    return '<p class="empty">' + safe(t('noRuntimeDiagnostics')) + '</p>';
  }
  return '<ul class="list">' + blockers.map(item => '<li>' + safe(blockerText(item)) + '</li>').join('') + '</ul>';
}
function wireTaskActionButtons(taskId) {
  for (const button of detailNode.querySelectorAll('button[data-task-action-id]')) {
    button.addEventListener('click', async () => {
      const actionId = button.dataset.taskActionId;
      const mode = button.dataset.taskActionMode;
      const confirmation = mode === 'execute' && actionId === 'task-next-step'
        ? window.prompt(t('typeToRunAction') + ' "RUN TASK NEXT STEP" ' + t('typeToRunActionTail'))
        : null;
      if (mode === 'execute' && actionId === 'task-next-step' && confirmation === null) {
        return;
      }
      await runTaskAction(taskId, actionId, mode, confirmation);
    });
  }
}
async function runTaskAction(taskId, actionId, mode, confirmation) {
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  const node = document.getElementById('task-action-status');
  if (!node) {
    return;
  }
  node.innerHTML = '<section class="command-preview-panel"><h3>' + safe(t('workflowCommandPreview')) + '</h3>'
    + '<div class="command-preview-main"><strong>' + safe(result.task_id || taskId) + '</strong><br><code>' + safe(result.command || '-') + '</code></div>'
    + '<div class="command-preview-meta"><span>' + safe(t('statusColumn')) + '<code>' + safe(resultStatusText(result.status)) + '</code></span></div>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + outputBlock('stdout', result.stdout)
    + outputBlock('stderr', result.stderr)
    + '</section>';
}
function planButton(detail) {
  return detail.plan && detail.plan.available
    ? '<button type="button" id="show-task-plan">' + safe(t('showTaskPlan')) + '</button>'
    : '';
}
function renderTaskPlanModal(detail) {
  const plan = detail.plan || {};
  const task = findReportTask(detail.task_id);
  planModalBodyNode.innerHTML = '<div class="plan-meta">'
    + '<div><span>' + safe(t('idColumn')) + '</span><strong>' + safe(detail.task_id) + '</strong></div>'
    + '<div><span>' + safe(t('titleColumn')) + '</span><strong>' + safe(plan.task_title || (task && task.title) || '-') + '</strong></div>'
    + '<div><span>' + safe(t('taskQueueStatus')) + '</span><strong>' + safe(plan.task_status || (task && (task.status_token || task.status)) || '-') + '</strong></div>'
    + '</div>'
    + (plan.summary ? '<p class="empty">' + safe(plan.summary) + '</p>' : '')
    + (plan.markdown_path ? '<p><strong>' + safe(t('planPath')) + ':</strong> <code>' + safe(plan.markdown_path) + '</code></p>' : '')
    + '<pre class="plan-content">' + safe(plan.markdown || t('planMetadataOnly')) + '</pre>';
  planModalNode.hidden = false;
}
function closeTaskPlanModal() {
  planModalNode.hidden = true;
  planModalBodyNode.innerHTML = '';
}
async function loadDetail(taskId) {
  selectedTaskId = taskId;
  detailNode.innerHTML = '<p class="empty">' + safe(t('loadingTaskPrefix')) + ' ' + safe(taskId) + '...</p>';
  renderTaskRows();
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/detail');
  if (!response.ok) {
    detailNode.innerHTML = '<p class="error">' + safe(t('unableToLoadDetails')) + ' ' + response.status + '</p>';
    return;
  }
  const detail = await response.json();
  currentTaskDetail = detail;
  loadedTaskDetails[detail.task_id] = detail;
  renderTaskDetail(detail);
  renderTaskRows();
}
function renderTaskDetail(detail) {
  const task = findReportTask(detail.task_id);
  const stats = detail.stats || {};
  const audit = detail.audit || {};
  const blockers = audit.blockers || [];
  const queueStatus = task ? (task.status_token || task.status) : '';
  const queueBlocked = queueStatus === 'BLOCKED';
  const dataState = queueBlocked ? t('blockerDetailState') : t('fullDetailState');
  detailNode.innerHTML = '<h2>' + safe(detail.task_id) + (task ? ' - ' + safe(task.title) : '') + '</h2>'
    + '<p class="empty">' + safe(dataState) + '</p>'
    + (queueBlocked ? '<div class="blocker-alert">' + safe(t('blockerDetailState')) + '</div>' : '')
    + '<div class="metrics">'
    + metric(t('taskQueueStatus'), queueStatus || '-')
    + metric(t('events'), stats.events_count)
    + metric(t('gatePass'), stats.gate_pass_count)
    + metric(t('gateFail'), stats.gate_fail_count)
    + metric(t('changedLines'), stats.changed_lines_total)
    + metric(t('dataColumn'), t('dataFull'))
    + '</div>'
    + '<h3 class="task-section-title">' + safe(t('taskActionsTitle')) + '</h3><p class="empty">' + safe(t('taskActionsHelp')) + '</p><div class="task-command-buttons">' + planButton(detail) + '</div><div id="task-action-status" class="task-action-status"></div>' + taskCommandList(detail.task_id)
    + '<h3 class="task-section-title">' + safe(t('gateTimeline')) + '</h3><p class="empty">' + safe(t('gateTimelineHelp')) + '</p><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>'
    + (blockers.length > 0 ? '<h3 class="task-section-title">' + safe(t('runtimeDiagnosticsTitle')) + '</h3>' + auditDiagnosticsList(blockers) : '')
    + '<h3 class="task-section-title">' + safe(t('reviews')) + '</h3>' + reviewSummary(audit)
    + '<h3 class="task-section-title">' + safe(t('artifacts')) + '</h3>' + artifactList(detail.artifact_links);
  wireTaskActionButtons(detail.task_id);
  const showPlanButton = document.getElementById('show-task-plan');
  if (showPlanButton) {
    showPlanButton.addEventListener('click', () => renderTaskPlanModal(detail));
  }
}
for (const tabButton of document.querySelectorAll('nav button[data-tab]')) {
  tabButton.addEventListener('click', () => {
    for (const button of document.querySelectorAll('nav button[data-tab]')) {
      button.classList.toggle('active', button === tabButton);
    }
    for (const tab of document.querySelectorAll('.tab')) {
      tab.hidden = tab.id !== tabButton.dataset.tab;
    }
  });
}
languageSelectNode.addEventListener('change', () => {
  currentLanguage = normalizeLanguage(languageSelectNode.value);
  try {
    if (window.localStorage) {
      window.localStorage.setItem('garda.ui.language', currentLanguage);
    }
  } catch {}
  applyLanguage();
});
searchNode.addEventListener('input', renderTaskRows);
statusFilterNode.addEventListener('change', renderTaskRows);
priorityFilterNode.addEventListener('change', renderTaskRows);
for (const eventName of ['pointerdown', 'keydown', 'wheel', 'touchstart']) {
  window.addEventListener(eventName, () => markActivity(false), { passive: true });
}
sessionActivityNode.addEventListener('click', () => markActivity(true));
sessionShutdownNode.addEventListener('click', async () => {
  renderSession(await postSession('/api/session/shutdown'));
});
planModalCloseNode.addEventListener('click', closeTaskPlanModal);
planModalNode.addEventListener('click', event => {
  if (event.target === planModalNode) {
    closeTaskPlanModal();
  }
});
refreshSession();
applyLanguage();
sessionPollTimer = setInterval(refreshSession, 1000);
fetch('/api/report').then(response => response.json()).then(renderTasks).catch(error => {
  tasksNode.innerHTML = '<tr><td colspan="7" class="error">' + safe(error && error.message ? error.message : error) + '</td></tr>';
});
refreshActionsPayload().catch(error => {
  actionsNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
refreshSettingsPayload().catch(error => {
  settingsEditorNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
</script>
</body>
</html>`;
}
