import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { URL } from 'node:url';
import { isCanonicalTaskId } from '../core/task-ids';
import {
    buildReportDataContract,
    buildReportTaskDetail,
    type ReportDataContract,
    type ReportTaskDetail
} from './report-data-contract';

export const DEFAULT_UI_HOST = '127.0.0.1';
export const DEFAULT_UI_PORT_START = 17340;
export const DEFAULT_UI_PORT_END = 17359;

export interface StartLocalUiServerOptions {
    repoRoot: string;
    host?: string;
    port?: number | null;
    portStart?: number;
    portEnd?: number;
}

export interface LocalUiServer {
    server: http.Server;
    host: string;
    port: number;
    url: string;
    close: () => Promise<void>;
}

interface ReportSnapshotCache {
    fingerprint: string | null;
    report: ReportDataContract | null;
}

function sendJson(response: http.ServerResponse, statusCode: number, payload: unknown): void {
    response.writeHead(statusCode, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(JSON.stringify(payload, null, 2));
}

function sendApiError(response: http.ServerResponse, statusCode: number, error: string, code: string): void {
    sendJson(response, statusCode, { error, code });
}

function sendHtml(response: http.ServerResponse, html: string): void {
    response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(html);
}

function sendText(response: http.ServerResponse, statusCode: number, body: string): void {
    response.writeHead(statusCode, {
        'content-type': 'text/plain; charset=utf-8',
        'cache-control': 'no-store'
    });
    response.end(body);
}

function buildReport(repoRoot: string): ReportDataContract {
    return buildReportDataContract({
        repoRoot,
        maxDetailedTasks: 0
    });
}

function statFingerprint(filePath: string): string {
    try {
        const stat = fs.statSync(filePath);
        return `${filePath}:${stat.mtimeMs}:${stat.size}`;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return `${filePath}:missing`;
        }
        throw error;
    }
}

function buildSnapshotFingerprint(repoRoot: string): string {
    return [
        statFingerprint(path.join(repoRoot, 'TASK.md')),
        statFingerprint(path.join(repoRoot, 'garda-agent-orchestrator', 'live', 'config', 'workflow-config.json'))
    ].join('|');
}

function getCachedReport(repoRoot: string, cache: ReportSnapshotCache): ReportDataContract {
    const fingerprint = buildSnapshotFingerprint(repoRoot);
    if (cache.report && cache.fingerprint === fingerprint) {
        return cache.report;
    }
    const report = buildReport(repoRoot);
    cache.fingerprint = fingerprint;
    cache.report = report;
    return report;
}

function findTask(report: ReportDataContract, taskId: string): boolean {
    return report.tasks_tab.rows.some((row) => row.task_id === taskId);
}

function renderLocalUiHtml(): string {
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
</nav>
<main>
<section class="notice">Task details are loaded on demand from the local read-only server. The server is bound to 127.0.0.1 and stops when this CLI process exits.</section>
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
</section>
<section class="panel tab" id="instructions-tab" hidden>
<div class="panel-head"><h2>Instructions</h2></div>
<div class="detail" id="instructions"><p class="empty">Loading instructions...</p></div>
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
const instructionsNode = document.getElementById('instructions');
const searchNode = document.getElementById('task-search');
const statusFilterNode = document.getElementById('status-filter');
const priorityFilterNode = document.getElementById('priority-filter');
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
</script>
</body>
</html>`;
}

export function createLocalUiServer(repoRoot: string): http.Server {
    const resolvedRepoRoot = path.resolve(repoRoot);
    const reportCache: ReportSnapshotCache = {
        fingerprint: null,
        report: null
    };
    return http.createServer((request, response) => {
        if (!request.url) {
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        const parsedUrl = new URL(request.url, `http://${DEFAULT_UI_HOST}`);
        const pathname = parsedUrl.pathname;
        if (request.method !== 'GET') {
            if (pathname.startsWith('/api/')) {
                sendApiError(response, 405, 'Only GET is supported.', 'method_not_allowed');
                return;
            }
            sendText(response, 405, 'Only GET is supported.');
            return;
        }
        if (pathname === '/') {
            sendHtml(response, renderLocalUiHtml());
            return;
        }
        if (pathname === '/api/report') {
            sendJson(response, 200, getCachedReport(resolvedRepoRoot, reportCache));
            return;
        }
        const detailMatch = pathname.match(/^\/api\/tasks\/([^/]+)\/detail$/u);
        if (detailMatch) {
            const taskId = decodeTaskIdSegment(detailMatch[1]);
            if (taskId === null) {
                sendApiError(response, 400, 'Invalid task id.', 'invalid_task_id');
                return;
            }
            if (!isCanonicalTaskId(taskId)) {
                sendApiError(response, 400, 'Invalid task id.', 'invalid_task_id');
                return;
            }
            const report = getCachedReport(resolvedRepoRoot, reportCache);
            if (!findTask(report, taskId)) {
                sendApiError(response, 404, 'Task not found.', 'task_not_found');
                return;
            }
            const detail: ReportTaskDetail = buildReportTaskDetail({
                repoRoot: resolvedRepoRoot,
                taskId
            });
            sendJson(response, 200, detail);
            return;
        }
        if (pathname.startsWith('/api/')) {
            sendApiError(response, 404, 'Not found.', 'not_found');
            return;
        }
        sendText(response, 404, 'Not found.');
    });
}

function decodeTaskIdSegment(segment: string): string | null {
    try {
        return decodeURIComponent(segment);
    } catch (error) {
        if (error instanceof URIError) {
            return null;
        }
        throw error;
    }
}

function listenOnPort(server: http.Server, host: string, port: number): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            const address = server.address();
            resolve(typeof address === 'object' && address ? address.port : port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
    });
}

function closeServer(server: http.Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}

function validatePort(port: number, label: string): void {
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
        throw new Error(`${label} must be an integer from 0 to 65535.`);
    }
}

export async function startLocalUiServer(options: StartLocalUiServerOptions): Promise<LocalUiServer> {
    const host = options.host || DEFAULT_UI_HOST;
    if (host !== DEFAULT_UI_HOST) {
        throw new Error('garda ui only supports binding to 127.0.0.1.');
    }
    const portStart = options.portStart ?? DEFAULT_UI_PORT_START;
    const portEnd = options.portEnd ?? DEFAULT_UI_PORT_END;
    validatePort(portStart, 'portStart');
    validatePort(portEnd, 'portEnd');
    if (portEnd < portStart) {
        throw new Error('portEnd must be greater than or equal to portStart.');
    }
    const candidatePorts = options.port === null || options.port === undefined
        ? Array.from({ length: portEnd - portStart + 1 }, (_, index) => portStart + index)
        : [options.port];
    let lastError: Error | null = null;
    for (const port of candidatePorts) {
        validatePort(port, 'port');
        const server = createLocalUiServer(options.repoRoot);
        try {
            const actualPort = await listenOnPort(server, host, port);
            return {
                server,
                host,
                port: actualPort,
                url: `http://${host}:${actualPort}/`,
                close: () => closeServer(server)
            };
        } catch (error: unknown) {
            lastError = error instanceof Error ? error : new Error(String(error));
            await closeServer(server).catch(() => undefined);
            if (options.port !== null && options.port !== undefined || !('code' in (lastError as Error & { code?: string })) || (lastError as Error & { code?: string }).code !== 'EADDRINUSE') {
                throw lastError;
            }
        }
    }
    throw new Error(`No available localhost UI port in range ${portStart}-${portEnd}.${lastError ? ` Last error: ${lastError.message}` : ''}`);
}

export function formatLocalUiServerOutput(server: LocalUiServer): string {
    return [
        'GARDA_UI',
        `Url: ${server.url}`,
        `Host: ${server.host}`,
        `Port: ${server.port}`,
        'Mode: read-only',
        'Stop: Ctrl+C'
    ].join('\n');
}
