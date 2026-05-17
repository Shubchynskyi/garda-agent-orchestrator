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
:root { color-scheme: light; --ink: #17202a; --muted: #667085; --line: #d9e0ea; --panel: #f6f8fb; --accent: #18715f; --warn: #9a5b00; --danger: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #fff; }
header { padding: 18px 22px 12px; border-bottom: 1px solid var(--line); background: #fbfcfe; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0 0 10px; font-size: 18px; letter-spacing: 0; }
button { font: inherit; border: 1px solid var(--line); background: #fff; color: var(--ink); border-radius: 6px; padding: 7px 10px; cursor: pointer; }
button:hover { border-color: var(--accent); color: var(--accent); }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 320px; padding: 10px; background: #111827; color: #f9fafb; border-radius: 6px; }
.meta { display: flex; flex-wrap: wrap; gap: 8px 14px; color: var(--muted); font-size: 13px; }
main { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, .85fr); gap: 16px; padding: 16px 22px 26px; }
.notice, .panel { border: 1px solid var(--line); border-radius: 8px; background: #fff; }
.notice { grid-column: 1 / -1; padding: 12px; background: #eef8f6; color: #145447; }
.warnings { grid-column: 1 / -1; padding: 12px; background: #fff8e8; color: var(--warn); }
.panel { overflow: hidden; }
.panel-head { padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--panel); }
.table-wrap { overflow: auto; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: #344054; position: sticky; top: 0; z-index: 1; }
.task-id { font-weight: 700; color: var(--accent); }
.badge { display: inline-flex; align-items: center; min-height: 24px; padding: 3px 7px; border-radius: 999px; background: #eef2f6; font-size: 12px; font-weight: 700; white-space: nowrap; }
.status-DONE { background: #e7f6ec; color: #17633a; }
.status-TODO { background: #eef2ff; color: #3442a0; }
.status-IN_PROGRESS, .status-IN_REVIEW { background: #fff4dc; color: #8a4b17; }
.detail { padding: 14px; }
.empty { color: var(--muted); }
.error { color: var(--danger); }
.metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; margin: 12px 0; }
.metric { min-height: 50px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.metric strong { overflow-wrap: anywhere; }
@media (max-width: 980px) { main { grid-template-columns: 1fr; } }
@media (max-width: 640px) { header, main { padding-left: 14px; padding-right: 14px; } th, td { padding: 8px; } }
</style>
</head>
<body>
<header>
<h1>Garda UI</h1>
<div class="meta" id="meta">Loading workspace report...</div>
</header>
<main>
<section class="notice">Task details are loaded on demand from the local read-only server. The server is bound to 127.0.0.1 and stops when this CLI process exits.</section>
<section class="warnings" id="warnings" hidden></section>
<section class="panel">
<div class="panel-head"><h2>Tasks</h2></div>
<div class="table-wrap">
<table>
<thead><tr><th>ID</th><th>Status</th><th>Priority</th><th>Area</th><th>Title</th><th>Action</th></tr></thead>
<tbody id="tasks"><tr><td colspan="6" class="empty">Loading...</td></tr></tbody>
</table>
</div>
</section>
<section class="panel">
<div class="panel-head"><h2>Task Detail</h2></div>
<div class="detail" id="detail"><p class="empty">Choose a task and click Load details.</p></div>
</section>
</main>
<script>
const tasksNode = document.getElementById('tasks');
const detailNode = document.getElementById('detail');
const metaNode = document.getElementById('meta');
const warningsNode = document.getElementById('warnings');
function safe(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function badge(value) {
  const text = String(value || 'unknown');
  return '<span class="badge status-' + safe(text) + '">' + safe(text) + '</span>';
}
function metric(label, value) {
  return '<div class="metric"><span>' + safe(label) + '</span><strong>' + safe(value ?? '-') + '</strong></div>';
}
function renderTasks(report) {
  metaNode.textContent = 'Repo: ' + report.repo_root + ' | Tasks: ' + report.tasks_tab.rows.length + ' | Warnings: ' + report.unavailable.length;
  if (report.unavailable.length > 0) {
    warningsNode.hidden = false;
    warningsNode.innerHTML = '<strong>Warnings</strong><ul>' + report.unavailable.map(item => '<li><code>' + safe(item.scope) + '</code>: ' + safe(item.reason) + '</li>').join('') + '</ul>';
  }
  tasksNode.innerHTML = report.tasks_tab.rows.map(task => '<tr><td><span class="task-id">' + safe(task.task_id) + '</span></td><td>' + badge(task.status_token || task.status) + '</td><td>' + safe(task.priority) + '</td><td>' + safe(task.area) + '</td><td>' + safe(task.title) + '</td><td><button type="button" data-task-id="' + safe(task.task_id) + '">Load details</button></td></tr>').join('');
  for (const button of tasksNode.querySelectorAll('button[data-task-id]')) {
    button.addEventListener('click', () => loadDetail(button.dataset.taskId));
  }
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
    + '<h3>Audit</h3><pre>' + safe(JSON.stringify(audit, null, 2)) + '</pre>'
    + '<h3>Latest Cycle</h3><pre>' + safe(JSON.stringify(detail.latest_cycle_events || {}, null, 2)) + '</pre>';
}
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
