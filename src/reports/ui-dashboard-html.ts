import {
    LOCAL_UI_LANGUAGES,
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
:root { color-scheme: light; --ink: #17202a; --muted: #667085; --line: #d9e0ea; --panel: #f6f8fb; --accent: #18715f; --blue: #2457a6; --warn: #9a5b00; --danger: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #fff; }
header { padding: 18px 22px 12px; border-bottom: 1px solid var(--line); background: #fbfcfe; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0 0 10px; font-size: 18px; letter-spacing: 0; }
button, input, select { font: inherit; }
button { border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
input, select { min-height: 34px; border: 1px solid var(--line); border-radius: 6px; padding: 6px 8px; background: #fff; color: var(--ink); }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 320px; padding: 10px; background: #111827; color: #f9fafb; border-radius: 6px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--muted); font-size: 13px; }
nav { display: flex; gap: 8px; padding: 10px 22px 0; border-bottom: 1px solid var(--line); background: #fbfcfe; }
nav button { border-bottom-left-radius: 0; border-bottom-right-radius: 0; border-bottom-color: transparent; }
nav button.active { color: #fff; background: var(--accent); border-color: var(--accent); }
.action-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 10px; }
.action-item { border: 1px solid var(--line); border-radius: 8px; padding: 10px; }
.action-item h3 { margin: 0 0 6px; font-size: 15px; }
.action-buttons { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
main { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, .85fr); gap: 16px; padding: 16px 22px 26px; }
.tab[hidden] { display: none; }
.notice, .panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.notice { grid-column: 1 / -1; padding: 12px; background: #eef8f6; color: #145447; }
.warnings { grid-column: 1 / -1; padding: 12px; background: #fff8e8; color: var(--warn); }
.panel { overflow: hidden; }
.panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.toolbar { display: grid; grid-template-columns: minmax(160px, 1fr) minmax(120px, 170px) minmax(120px, 170px); gap: 8px; margin-top: 10px; }
.overview { grid-column: 1 / -1; display: grid; grid-template-columns: repeat(5, minmax(120px, 1fr)); gap: 8px; }
.table-wrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: #344054; position: sticky; top: 0; z-index: 1; }
.task-id { font-weight: 700; color: var(--accent); }
.badge { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 7px; border-radius: 999px; background: #eef2f6; font-size: 12px; font-weight: 700; white-space: nowrap; }
.status-DONE { background: #e7f6ec; color: #17633a; }
.status-TODO { background: #eef2ff; color: #3442a0; }
.status-IN_PROGRESS, .status-IN_REVIEW { background: #fff4dc; color: #8a4b17; }
.priority-P1 { background: #fdecec; color: #9b1c1c; }
.priority-P2 { background: #fff4dc; color: #8a4b17; }
.priority-P3 { background: #eef8f6; color: #145447; }
.detail { padding: 14px; }
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
.language-panel { grid-column: 1; }
.language-panel label { display: grid; gap: 6px; font-weight: 700; }
.session-panel { grid-column: 2; }
.session-state { display: grid; gap: 8px; }
.session-countdown { width: 100%; accent-color: var(--warn); }
.session-warning { color: var(--warn); font-weight: 700; }
.session-stopping { color: var(--danger); font-weight: 700; }
.session-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
@media (max-width: 980px) { main { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .overview { grid-template-columns: repeat(2, minmax(120px, 1fr)); } .toolbar { grid-template-columns: 1fr; } }
@media (max-width: 640px) { header, main, nav { padding-left: 14px; padding-right: 14px; } th, td { padding: 8px; } }
</style>
</head>
<body>
<header>
<h1 data-i18n="appTitle">${text.appTitle}</h1>
<div class="meta" id="meta" data-i18n="loadingWorkspaceReport">${text.loadingWorkspaceReport}</div>
</header>
<nav>
<button type="button" class="active" data-tab="tasks-tab" data-i18n="tasksTab">${text.tasksTab}</button>
<button type="button" data-tab="workflow-tab" data-i18n="workflowTab">${text.workflowTab}</button>
<button type="button" data-tab="instructions-tab" data-i18n="instructionsTab">${text.instructionsTab}</button>
<button type="button" data-tab="actions-tab" data-i18n="actionsTab">${text.actionsTab}</button>
</nav>
<main>
<section class="notice" id="ui-notice">${actionsEnabled ? text.noticeActionsEnabled : text.noticeActionsDisabled}</section>
<section class="warnings" id="warnings" hidden></section>
<section class="overview" id="overview"></section>
<section class="panel language-panel" id="language-panel">
<div class="panel-head"><h2 data-i18n="languageTitle">${text.languageTitle}</h2></div>
<div class="detail">
<label><span data-i18n="languageTitle">${text.languageTitle}</span><select id="language-select"></select></label>
<p class="empty" data-i18n="languageHelp">${text.languageHelp}</p>
</div>
</section>
<section class="panel session-panel" id="server-status-panel">
<div class="panel-head"><h2 data-i18n="serverStatusTitle">${text.serverStatusTitle}</h2></div>
<div class="detail session-state">
<div id="server-status"><p class="empty" data-i18n="loadingServerSession">${text.loadingServerSession}</p></div>
<input id="session-countdown" class="session-countdown" type="range" min="0" max="60" value="60" disabled>
<div class="session-actions">
<button type="button" id="session-activity" data-i18n="iAmHere">${text.iAmHere}</button>
<button type="button" id="session-shutdown" data-i18n="stopServer">${text.stopServer}</button>
</div>
<p class="empty"><span data-i18n="serverStoppedRerun">${text.serverStoppedRerun}</span> <code>garda ui --target-root "."</code> <span data-i18n="serverStoppedRerunTail">${text.serverStoppedRerunTail}</span></p>
</div>
</section>
<section class="panel tab" id="tasks-tab">
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
<thead><tr><th data-i18n="idColumn">${text.idColumn}</th><th data-i18n="statusColumn">${text.statusColumn}</th><th data-i18n="priorityColumn">${text.priorityColumn}</th><th data-i18n="areaColumn">${text.areaColumn}</th><th data-i18n="titleColumn">${text.titleColumn}</th><th data-i18n="actionColumn">${text.actionColumn}</th></tr></thead>
<tbody id="tasks"><tr><td colspan="6" class="empty" data-i18n="loading">${text.loading}</td></tr></tbody>
</table>
</div>
</section>
<section class="panel tab" id="workflow-tab" hidden>
<div class="panel-head"><h2 data-i18n="workflowTab">${text.workflowTab}</h2></div>
<div class="detail" id="workflow"><p class="empty" data-i18n="loading">${text.loading}</p></div>
<div class="detail" id="settings-editor"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="instructions-tab" hidden>
<div class="panel-head"><h2 data-i18n="instructionsTab">${text.instructionsTab}</h2></div>
<div class="detail" id="instructions"><p class="empty" data-i18n="loading">${text.loading}</p></div>
</section>
<section class="panel tab" id="actions-tab" hidden>
<div class="panel-head"><h2 data-i18n="actionsTab">${text.actionsTab}</h2></div>
<div class="detail">
<div id="actions"><p class="empty" data-i18n="loading">${text.loading}</p></div>
<div id="action-status" class="empty"></div>
</div>
</section>
<section class="panel tab" id="task-detail-panel">
<div class="panel-head"><h2 data-i18n="taskDetailTitle">${text.taskDetailTitle}</h2></div>
<div class="detail" id="detail"><p class="empty" data-i18n="chooseTask">${text.chooseTask}</p></div>
</section>
</main>
<script>
const languagePacks = ${JSON.stringify(LOCAL_UI_TEXT)};
const languageMetadata = ${JSON.stringify(LOCAL_UI_LANGUAGES)};
const fallbackLanguage = 'en';
const initialLanguage = ${JSON.stringify(language)};
const tasksNode = document.getElementById('tasks');
const detailNode = document.getElementById('detail');
const metaNode = document.getElementById('meta');
const warningsNode = document.getElementById('warnings');
const overviewNode = document.getElementById('overview');
const workflowNode = document.getElementById('workflow');
const settingsEditorNode = document.getElementById('settings-editor');
const instructionsNode = document.getElementById('instructions');
const actionsNode = document.getElementById('actions');
const actionStatusNode = document.getElementById('action-status');
const serverStatusNode = document.getElementById('server-status');
const sessionCountdownNode = document.getElementById('session-countdown');
const sessionActivityNode = document.getElementById('session-activity');
const sessionShutdownNode = document.getElementById('session-shutdown');
const languageSelectNode = document.getElementById('language-select');
const uiNoticeNode = document.getElementById('ui-notice');
const searchNode = document.getElementById('task-search');
const statusFilterNode = document.getElementById('status-filter');
const priorityFilterNode = document.getElementById('priority-filter');
const actionToken = ${JSON.stringify(actionToken)};
const actionsEnabled = ${JSON.stringify(actionsEnabled)};
let currentReport = null;
let currentSession = null;
let currentActionsPayload = null;
let currentSettingsPayload = null;
let currentTaskDetail = null;
let lastActivityPingAt = 0;
let sessionPollTimer = null;
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
function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function badge(value, prefix) {
  const text = String(value || 'unknown');
  return '<span class="badge ' + safe(prefix || 'status') + '-' + safe(text) + '">' + safe(text) + '</span>';
}
function metric(label, value) {
  return '<div class="metric"><span>' + safe(label) + '</span><strong>' + safe(value ?? '-') + '</strong></div>';
}
function uniqueSorted(values) {
  return Array.from(new Set(values.filter(Boolean).map(value => String(value)))).sort((a, b) => a.localeCompare(b));
}
function setOptions(select, values, allLabel) {
  select.innerHTML = '<option value="">' + safe(allLabel) + '</option>' + values.map(value => '<option value="' + safe(value) + '">' + safe(value) + '</option>').join('');
}
function renderLanguageSelector() {
  languageSelectNode.innerHTML = languageMetadata.map(language => '<option value="' + safe(language.id) + '">' + safe(language.nativeLabel) + ' / ' + safe(language.label) + '</option>').join('');
  languageSelectNode.value = currentLanguage;
}
function applyLanguage() {
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
  if (currentTaskDetail) {
    renderTaskDetail(currentTaskDetail);
  }
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
function renderTasks(report) {
  currentReport = report;
  metaNode.textContent = t('metaRepo') + ': ' + report.repo_root + ' | ' + t('metaTasks') + ': ' + report.tasks_tab.rows.length + ' | ' + t('metaWarnings') + ': ' + report.unavailable.length;
  if (report.unavailable.length > 0) {
    warningsNode.hidden = false;
    warningsNode.innerHTML = '<strong>' + safe(t('warningsTitle')) + '</strong><ul>' + report.unavailable.map(item => '<li><code>' + safe(item.scope) + '</code>: ' + safe(item.reason) + '</li>').join('') + '</ul>';
  }
  renderOverview(report);
  setOptions(statusFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.status_token || task.status)), t('allStatuses'));
  setOptions(priorityFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.priority)), t('allPriorities'));
  renderTaskRows();
  renderWorkflow(report);
  renderInstructions(report);
}
function renderTaskRows() {
  const rows = currentReport ? currentReport.tasks_tab.rows.filter(matchesFilters) : [];
  if (rows.length === 0) {
    tasksNode.innerHTML = '<tr><td colspan="6" class="empty">' + safe(t('noMatchingTasks')) + '</td></tr>';
    return;
  }
  tasksNode.innerHTML = rows.map(task => '<tr><td><span class="task-id">' + safe(task.task_id) + '</span></td><td>' + badge(task.status_token || task.status, 'status') + '</td><td>' + badge(task.priority, 'priority') + '</td><td>' + safe(task.area) + '</td><td>' + safe(task.title) + '</td><td><button type="button" data-task-id="' + safe(task.task_id) + '">' + safe(t('loadDetails')) + '</button></td></tr>').join('');
  for (const button of tasksNode.querySelectorAll('button[data-task-id]')) {
    button.addEventListener('click', () => loadDetail(button.dataset.taskId));
  }
}
function renderWorkflow(report) {
  const settings = report.workflow_config_tab.settings || [];
  if (settings.length === 0) {
    workflowNode.innerHTML = '<p class="empty">' + safe(t('noWorkflowSettings')) + '</p>';
    return;
  }
  workflowNode.innerHTML = '<div class="kv">' + settings.map(setting => '<div><span>' + safe(setting.key) + '</span><strong><code>' + safe(JSON.stringify(setting.value)) + '</code><br>' + safe(setting.description) + '<br><code>' + safe(setting.command) + '</code></strong></div>').join('') + '</div>';
}
function renderSettingResult(result) {
  actionStatusNode.innerHTML = '<h3>' + safe(result.key || result.setting_id || t('setting')) + '</h3>'
    + '<p><strong>' + safe(t('statusColumn')) + ':</strong> ' + safe(result.status) + '</p>'
    + '<p><strong>' + safe(t('changedKey')) + ':</strong> <code>' + safe((result.changed_keys || []).join(', ')) + '</code></p>'
    + '<p><strong>' + safe(t('current')) + ':</strong> <code>' + safe(JSON.stringify(result.current_value)) + '</code></p>'
    + '<p><strong>' + safe(t('proposed')) + ':</strong> <code>' + safe(JSON.stringify(result.proposed_value)) + '</code></p>'
    + '<p><strong>' + safe(t('command')) + ':</strong> <code>' + safe(result.command) + '</code></p>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + (result.stdout ? '<h3>stdout</h3><pre>' + safe(result.stdout) + '</pre>' : '')
    + (result.stderr ? '<h3>stderr</h3><pre>' + safe(result.stderr) + '</pre>' : '');
}
async function submitSetting(settingId, mode, value, confirmation) {
  const response = await fetch('/api/settings', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ setting_id: settingId, mode, value, confirmation })
  });
  const result = await response.json();
  renderSettingResult(result);
}
function renderSettingsEditor(payload) {
  currentSettingsPayload = payload;
  if (!payload.enabled) {
    settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3><p class="empty">' + safe(t('settingEditsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('settingEditsDisabledTail')) + '</p>';
    return;
  }
  if (!payload.settings || payload.settings.length === 0) {
    settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3><p class="empty">' + safe(t('noEditableSettings')) + '</p>';
    return;
  }
  settingsEditorNode.innerHTML = '<h3>' + safe(t('guardedEditor')) + '</h3><div class="action-grid">' + payload.settings.map(setting => '<div class="action-item"><h3>' + safe(setting.label) + '</h3><p>' + safe(setting.description) + '</p><p><code>' + safe(setting.key) + '</code></p><p>' + safe(t('current')) + ': <code>' + safe(JSON.stringify(setting.current_value)) + '</code></p><input id="setting-input-' + safe(setting.id) + '" type="number" min="' + safe(setting.min) + '" max="' + safe(setting.max) + '" value="' + safe(setting.current_value) + '"><div class="action-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="preview">' + safe(t('preview')) + '</button><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="execute">' + safe(t('apply')) + '</button></div></div>').join('') + '</div>';
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = payload.settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const input = document.getElementById('setting-input-' + button.dataset.settingId);
      const confirmation = mode === 'execute' && setting
        ? window.prompt(t('typeToApplySetting') + ' "' + setting.confirmation_phrase + '" ' + t('typeToApplySettingTail'))
        : null;
      if (mode === 'execute' && confirmation === null) {
        return;
      }
      submitSetting(button.dataset.settingId, mode, input ? input.value : '', confirmation);
    });
  }
}
function renderInstructions(report) {
  const entries = report.instructions_tab.entries || [];
  instructionsNode.innerHTML = entries.length === 0
    ? '<p class="empty">' + safe(t('noInstructions')) + '</p>'
    : entries.map(entry => '<h3>' + safe(entry.title) + '</h3><p>' + safe(entry.body) + '</p>').join('');
}
function artifactList(links) {
  if (!links || links.length === 0) {
    return '<p class="empty">' + safe(t('noArtifacts')) + '</p>';
  }
  return '<ul class="list">' + links.map(link => '<li class="' + (link.exists ? 'artifact-ok' : 'artifact-missing') + '"><code>' + safe(link.kind) + '</code>: ' + safe(link.path) + (link.exists ? '' : ' (' + safe(t('missing')) + ')') + '</li>').join('') + '</ul>';
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
    serverStatusNode.innerHTML = '<p><strong>' + safe(t('statusColumn')) + ':</strong> ' + safe(t('idleShutdownDisabled')) + '</p><p class="empty">' + safe(t('stopWithCtrlC')) + '</p>';
    sessionCountdownNode.max = '1';
    sessionCountdownNode.value = '1';
    return;
  }
  const stateClass = session.state === 'warning' ? 'session-warning' : session.state === 'stopping' ? 'session-stopping' : '';
  const stateLabel = session.state === 'warning'
    ? t('idleWarning')
    : session.state === 'stopping'
      ? t('stopping')
      : t('active');
  const warningSeconds = session.seconds_until_warning;
  const shutdownSeconds = session.seconds_until_shutdown;
  sessionCountdownNode.max = String(Math.max(1, Number(session.warning_seconds || 1)));
  sessionCountdownNode.value = String(session.state === 'warning' ? Math.max(0, Number(shutdownSeconds || 0)) : Number(session.warning_seconds || 1));
  serverStatusNode.innerHTML = '<p><strong>' + safe(t('statusColumn')) + ':</strong> <span class="' + stateClass + '">' + safe(stateLabel) + '</span></p>'
    + '<p><strong>' + safe(t('idleThreshold')) + ':</strong> ' + safe(session.idle_minutes) + ' min</p>'
    + '<p><strong>' + safe(t('lastActivity')) + ':</strong> <code>' + safe(session.last_activity_at) + '</code></p>'
    + (session.state === 'warning'
      ? '<p class="session-warning">' + safe(t('shutdownInPrefix')) + ' ' + safe(shutdownSeconds) + ' ' + safe(t('shutdownInSuffix')) + ' "' + safe(t('iAmHere')) + '" ' + safe(t('shutdownInTail')) + '</p>'
      : '<p>' + safe(t('warningStartsInPrefix')) + ' ' + safe(warningSeconds) + ' ' + safe(t('warningStartsInSuffix')) + '</p>')
    + (session.state === 'stopping' ? '<p class="session-stopping">' + safe(session.stop_message) + '</p>' : '');
}
async function refreshSession() {
  try {
    const response = await fetch('/api/session');
    renderSession(await response.json());
  } catch (error) {
    serverStatusNode.innerHTML = '<p class="session-stopping">' + safe(t('serverUnavailable')) + ' <code>garda ui --target-root "."</code> ' + safe(t('serverUnavailableTail')) + '</p>';
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
  actionStatusNode.innerHTML = '<h3>' + safe(result.action_id || t('action')) + '</h3>'
    + '<p><strong>' + safe(t('statusColumn')) + ':</strong> ' + safe(result.status) + '</p>'
    + '<p><strong>' + safe(t('command')) + ':</strong> <code>' + safe(result.command) + '</code></p>'
    + (result.audit_path ? '<p><strong>' + safe(t('audit')) + ':</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
    + (result.stdout ? '<h3>stdout</h3><pre>' + safe(result.stdout) + '</pre>' : '')
    + (result.stderr ? '<h3>stderr</h3><pre>' + safe(result.stderr) + '</pre>' : '');
}
async function runAction(actionId, mode, confirmation) {
  const response = await fetch('/api/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-garda-action-token': actionToken },
    body: JSON.stringify({ action_id: actionId, mode, confirmation })
  });
  const result = await response.json();
  renderActionResult(result);
}
function renderActions(payload) {
  currentActionsPayload = payload;
  if (!payload.enabled) {
    actionsNode.innerHTML = '<p class="empty">' + safe(t('actionsDisabled')) + ' <code>garda ui --actions</code> ' + safe(t('actionsDisabledTail')) + '</p>';
    return;
  }
  actionsNode.innerHTML = '<div class="action-grid">' + payload.actions.map(action => '<div class="action-item"><h3>' + safe(action.label) + '</h3><p>' + safe(action.description) + '</p><p><code>' + safe(action.command) + '</code></p><div class="action-buttons"><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="preview">' + safe(t('preview')) + '</button><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">' + safe(t('run')) + '</button></div></div>').join('') + '</div>';
  for (const button of actionsNode.querySelectorAll('button[data-action-id]')) {
    button.addEventListener('click', () => {
      const action = payload.actions.find(item => item.id === button.dataset.actionId);
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
function reviewSummary(audit) {
  const summary = audit && audit.review_attempt_summary && audit.review_attempt_summary.by_type;
  if (!summary || summary.length === 0) {
    return '<p class="empty">' + safe(t('noReviewAttempts')) + '</p>';
  }
  return '<ul class="list">' + summary.map(item => '<li><code>' + safe(item.review_type) + '</code>: pass=' + safe(item.pass_count) + ', fail=' + safe(item.fail_count) + ', reused=' + safe(item.reused_count) + '</li>').join('') + '</ul>';
}
async function loadDetail(taskId) {
  detailNode.innerHTML = '<p class="empty">' + safe(t('loadingTaskPrefix')) + ' ' + safe(taskId) + '...</p>';
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/detail');
  if (!response.ok) {
    detailNode.innerHTML = '<p class="error">' + safe(t('unableToLoadDetails')) + ' ' + response.status + '</p>';
    return;
  }
  const detail = await response.json();
  currentTaskDetail = detail;
  renderTaskDetail(detail);
}
function renderTaskDetail(detail) {
  const stats = detail.stats || {};
  const audit = detail.audit || {};
  detailNode.innerHTML = '<h2>' + safe(detail.task_id) + '</h2>'
    + '<div class="metrics">'
    + metric(t('events'), stats.events_count)
    + metric(t('gatePass'), stats.gate_pass_count)
    + metric(t('gateFail'), stats.gate_fail_count)
    + metric(t('changedLines'), stats.changed_lines_total)
    + '</div>'
    + '<h3>' + safe(t('gateTimeline')) + '</h3><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>'
    + '<h3>' + safe(t('blockers')) + '</h3>' + ((audit.blockers || []).length > 0 ? '<ul class="list">' + audit.blockers.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>' : '<p class="empty">' + safe(t('noBlockers')) + '</p>')
    + '<h3>' + safe(t('reviews')) + '</h3>' + reviewSummary(audit)
    + '<h3>' + safe(t('artifacts')) + '</h3>' + artifactList(detail.artifact_links)
    + '<h3>' + safe(t('auditTitle')) + '</h3><pre>' + safe(JSON.stringify(audit, null, 2)) + '</pre>';
}
for (const tabButton of document.querySelectorAll('nav button[data-tab]')) {
  tabButton.addEventListener('click', () => {
    for (const button of document.querySelectorAll('nav button[data-tab]')) {
      button.classList.toggle('active', button === tabButton);
    }
    for (const tab of document.querySelectorAll('.tab')) {
      tab.hidden = tab.id !== tabButton.dataset.tab && tab.id !== 'task-detail-panel';
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
refreshSession();
applyLanguage();
sessionPollTimer = setInterval(refreshSession, 1000);
fetch('/api/report').then(response => response.json()).then(renderTasks).catch(error => {
  tasksNode.innerHTML = '<tr><td colspan="6" class="error">' + safe(error && error.message ? error.message : error) + '</td></tr>';
});
fetch('/api/actions').then(response => response.json()).then(renderActions).catch(error => {
  actionsNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
fetch('/api/settings').then(response => response.json()).then(renderSettingsEditor).catch(error => {
  settingsEditorNode.innerHTML = '<p class="error">' + safe(error && error.message ? error.message : error) + '</p>';
});
</script>
</body>
</html>`;
}
