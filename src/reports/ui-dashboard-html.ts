export function renderLocalUiHtml(actionsEnabled: boolean, actionToken: string): string {
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garda UI</title>
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
@media (max-width: 980px) { main { grid-template-columns: 1fr; } }
@media (max-width: 760px) { .overview { grid-template-columns: repeat(2, minmax(120px, 1fr)); } .toolbar { grid-template-columns: 1fr; } }
@media (max-width: 640px) { header, main, nav { padding-left: 14px; padding-right: 14px; } th, td { padding: 8px; } }
</style>
</head>
<body>
<header>
<h1>Garda UI</h1>
<div class="meta" id="meta">Loading workspace report...</div>
</header>
<nav>
<button type="button" class="active" data-tab="tasks-tab">Tasks</button>
<button type="button" data-tab="workflow-tab">Workflow Config</button>
<button type="button" data-tab="instructions-tab">Instructions</button>
<button type="button" data-tab="actions-tab">Actions</button>
</nav>
<main>
<section class="notice">Task details are loaded on demand from the local server. The server is bound to 127.0.0.1 and stops when this CLI process exits. Controlled actions are ${actionsEnabled ? 'enabled for allow-listed commands only.' : 'disabled unless the server starts with --actions.'}</section>
<section class="warnings" id="warnings" hidden></section>
<section class="overview" id="overview"></section>
<section class="panel tab" id="tasks-tab">
<div class="panel-head"><h2>Tasks</h2></div>
<div class="panel-head">
<div class="toolbar">
<input id="task-search" type="search" placeholder="Search tasks">
<select id="status-filter"><option value="">All statuses</option></select>
<select id="priority-filter"><option value="">All priorities</option></select>
</div>
</div>
<div class="table-wrap">
<table>
<thead><tr><th>ID</th><th>Status</th><th>Priority</th><th>Area</th><th>Title</th><th>Action</th></tr></thead>
<tbody id="tasks"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
</table>
</div>
</section>
<section class="panel tab" id="workflow-tab" hidden>
<div class="panel-head"><h2>Workflow Config</h2></div>
<div class="detail" id="workflow"><p class="empty">Loading workflow settings...</p></div>
<div class="detail" id="settings-editor"><p class="empty">Loading guarded setting controls...</p></div>
</section>
<section class="panel tab" id="instructions-tab" hidden>
<div class="panel-head"><h2>Instructions</h2></div>
<div class="detail" id="instructions"><p class="empty">Loading instructions...</p></div>
</section>
<section class="panel tab" id="actions-tab" hidden>
<div class="panel-head"><h2>Actions</h2></div>
<div class="detail">
<div id="actions"><p class="empty">Loading actions...</p></div>
<div id="action-status" class="empty"></div>
</div>
</section>
<section class="panel tab" id="task-detail-panel">
<div class="panel-head"><h2>Task Detail</h2></div>
<div class="detail" id="detail"><p class="empty">Choose a task and click Load details.</p></div>
</section>
</main>
<script>
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
const searchNode = document.getElementById('task-search');
const statusFilterNode = document.getElementById('status-filter');
const priorityFilterNode = document.getElementById('priority-filter');
const actionToken = ${JSON.stringify(actionToken)};
let currentReport = null;
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
function renderOverview(report) {
  const rows = report.tasks_tab.rows;
  const active = rows.filter(task => !['DONE', 'BLOCKED', 'DECOMPOSED'].includes(task.status_token || '')).length;
  const done = rows.filter(task => (task.status_token || '') === 'DONE').length;
  const blocked = rows.filter(task => (task.status_token || '') === 'BLOCKED').length;
  overviewNode.innerHTML = metric('Tasks', rows.length)
    + metric('Active', active)
    + metric('Done', done)
    + metric('Blocked', blocked)
    + metric('Warnings', report.unavailable.length);
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
  metaNode.textContent = 'Repo: ' + report.repo_root + ' | Tasks: ' + report.tasks_tab.rows.length + ' | Warnings: ' + report.unavailable.length;
  if (report.unavailable.length > 0) {
    warningsNode.hidden = false;
    warningsNode.innerHTML = '<strong>Warnings</strong><ul>' + report.unavailable.map(item => '<li><code>' + safe(item.scope) + '</code>: ' + safe(item.reason) + '</li>').join('') + '</ul>';
  }
  renderOverview(report);
  setOptions(statusFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.status_token || task.status)), 'All statuses');
  setOptions(priorityFilterNode, uniqueSorted(report.tasks_tab.rows.map(task => task.priority)), 'All priorities');
  renderTaskRows();
  renderWorkflow(report);
  renderInstructions(report);
}
function renderTaskRows() {
  const rows = currentReport ? currentReport.tasks_tab.rows.filter(matchesFilters) : [];
  if (rows.length === 0) {
    tasksNode.innerHTML = '<tr><td colspan="6" class="empty">No matching tasks.</td></tr>';
    return;
  }
  tasksNode.innerHTML = rows.map(task => '<tr><td><span class="task-id">' + safe(task.task_id) + '</span></td><td>' + badge(task.status_token || task.status, 'status') + '</td><td>' + badge(task.priority, 'priority') + '</td><td>' + safe(task.area) + '</td><td>' + safe(task.title) + '</td><td><button type="button" data-task-id="' + safe(task.task_id) + '">Load details</button></td></tr>').join('');
  for (const button of tasksNode.querySelectorAll('button[data-task-id]')) {
    button.addEventListener('click', () => loadDetail(button.dataset.taskId));
  }
}
function renderWorkflow(report) {
  const settings = report.workflow_config_tab.settings || [];
  if (settings.length === 0) {
    workflowNode.innerHTML = '<p class="empty">No workflow settings available.</p>';
    return;
  }
  workflowNode.innerHTML = '<div class="kv">' + settings.map(setting => '<div><span>' + safe(setting.key) + '</span><strong><code>' + safe(JSON.stringify(setting.value)) + '</code><br>' + safe(setting.description) + '<br><code>' + safe(setting.command) + '</code></strong></div>').join('') + '</div>';
}
function renderSettingResult(result) {
  actionStatusNode.innerHTML = '<h3>' + safe(result.key || result.setting_id || 'Setting') + '</h3>'
    + '<p><strong>Status:</strong> ' + safe(result.status) + '</p>'
    + '<p><strong>Changed key:</strong> <code>' + safe((result.changed_keys || []).join(', ')) + '</code></p>'
    + '<p><strong>Current:</strong> <code>' + safe(JSON.stringify(result.current_value)) + '</code></p>'
    + '<p><strong>Proposed:</strong> <code>' + safe(JSON.stringify(result.proposed_value)) + '</code></p>'
    + '<p><strong>Command:</strong> <code>' + safe(result.command) + '</code></p>'
    + (result.audit_path ? '<p><strong>Audit:</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
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
  if (!payload.enabled) {
    settingsEditorNode.innerHTML = '<h3>Guarded editor</h3><p class="empty">Setting edits are disabled. Restart with <code>garda ui --actions</code> to enable audited workflow commands.</p>';
    return;
  }
  if (!payload.settings || payload.settings.length === 0) {
    settingsEditorNode.innerHTML = '<h3>Guarded editor</h3><p class="empty">No editable safe settings available.</p>';
    return;
  }
  settingsEditorNode.innerHTML = '<h3>Guarded editor</h3><div class="action-grid">' + payload.settings.map(setting => '<div class="action-item"><h3>' + safe(setting.label) + '</h3><p>' + safe(setting.description) + '</p><p><code>' + safe(setting.key) + '</code></p><p>Current: <code>' + safe(JSON.stringify(setting.current_value)) + '</code></p><input id="setting-input-' + safe(setting.id) + '" type="number" min="' + safe(setting.min) + '" max="' + safe(setting.max) + '" value="' + safe(setting.current_value) + '"><div class="action-buttons"><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="preview">Preview</button><button type="button" data-setting-id="' + safe(setting.id) + '" data-setting-mode="execute">Apply</button></div></div>').join('') + '</div>';
  for (const button of settingsEditorNode.querySelectorAll('button[data-setting-id]')) {
    button.addEventListener('click', () => {
      const setting = payload.settings.find(item => item.id === button.dataset.settingId);
      const mode = button.dataset.settingMode;
      const input = document.getElementById('setting-input-' + button.dataset.settingId);
      const confirmation = mode === 'execute' && setting
        ? window.prompt('Type "' + setting.confirmation_phrase + '" to apply this setting:')
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
    ? '<p class="empty">No instructions available.</p>'
    : entries.map(entry => '<h3>' + safe(entry.title) + '</h3><p>' + safe(entry.body) + '</p>').join('');
}
function artifactList(links) {
  if (!links || links.length === 0) {
    return '<p class="empty">No artifacts listed.</p>';
  }
  return '<ul class="list">' + links.map(link => '<li class="' + (link.exists ? 'artifact-ok' : 'artifact-missing') + '"><code>' + safe(link.kind) + '</code>: ' + safe(link.path) + (link.exists ? '' : ' (missing)') + '</li>').join('') + '</ul>';
}
function renderActionResult(result) {
  actionStatusNode.innerHTML = '<h3>' + safe(result.action_id || 'Action') + '</h3>'
    + '<p><strong>Status:</strong> ' + safe(result.status) + '</p>'
    + '<p><strong>Command:</strong> <code>' + safe(result.command) + '</code></p>'
    + (result.audit_path ? '<p><strong>Audit:</strong> <code>' + safe(result.audit_path) + '</code></p>' : '')
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
  if (!payload.enabled) {
    actionsNode.innerHTML = '<p class="empty">Actions are disabled. Restart with <code>garda ui --actions</code> to expose allow-listed commands.</p>';
    return;
  }
  actionsNode.innerHTML = '<div class="action-grid">' + payload.actions.map(action => '<div class="action-item"><h3>' + safe(action.label) + '</h3><p>' + safe(action.description) + '</p><p><code>' + safe(action.command) + '</code></p><div class="action-buttons"><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="preview">Preview</button><button type="button" data-action-id="' + safe(action.id) + '" data-action-mode="execute">Run</button></div></div>').join('') + '</div>';
  for (const button of actionsNode.querySelectorAll('button[data-action-id]')) {
    button.addEventListener('click', () => {
      const action = payload.actions.find(item => item.id === button.dataset.actionId);
      const mode = button.dataset.actionMode;
      const confirmation = mode === 'execute' && action && action.requires_confirmation
        ? window.prompt('Type "' + action.confirmation_phrase + '" to run this action:')
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
    return '<p class="empty">No review attempts recorded.</p>';
  }
  return '<ul class="list">' + summary.map(item => '<li><code>' + safe(item.review_type) + '</code>: pass=' + safe(item.pass_count) + ', fail=' + safe(item.fail_count) + ', reused=' + safe(item.reused_count) + '</li>').join('') + '</ul>';
}
async function loadDetail(taskId) {
  detailNode.innerHTML = '<p class="empty">Loading ' + safe(taskId) + '...</p>';
  const response = await fetch('/api/tasks/' + encodeURIComponent(taskId) + '/detail');
  if (!response.ok) {
    detailNode.innerHTML = '<p class="error">Unable to load details: HTTP ' + response.status + '</p>';
    return;
  }
  const detail = await response.json();
  const stats = detail.stats || {};
  const audit = detail.audit || {};
  detailNode.innerHTML = '<h2>' + safe(detail.task_id) + '</h2>'
    + '<div class="metrics">'
    + metric('Events', stats.events_count)
    + metric('Gate Pass', stats.gate_pass_count)
    + metric('Gate Fail', stats.gate_fail_count)
    + metric('Changed Lines', stats.changed_lines_total)
    + '</div>'
    + '<h3>Gate Timeline</h3><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>'
    + '<h3>Blockers</h3>' + ((audit.blockers || []).length > 0 ? '<ul class="list">' + audit.blockers.map(item => '<li>' + safe(item) + '</li>').join('') + '</ul>' : '<p class="empty">No blockers reported.</p>')
    + '<h3>Reviews</h3>' + reviewSummary(audit)
    + '<h3>Artifacts</h3>' + artifactList(detail.artifact_links)
    + '<h3>Audit</h3><pre>' + safe(JSON.stringify(audit, null, 2)) + '</pre>';
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
searchNode.addEventListener('input', renderTaskRows);
statusFilterNode.addEventListener('change', renderTaskRows);
priorityFilterNode.addEventListener('change', renderTaskRows);
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
