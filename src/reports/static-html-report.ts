import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveBundleName } from '../core/constants';
import {
    buildReportDataContract,
    DEFAULT_REPORT_MAX_DETAILED_TASKS,
    type ReportDataContract,
    type ReportTaskRow,
    type ReportWorkflowSetting
} from './report-data-contract';

export interface BuildStaticHtmlReportOptions {
    repoRoot: string;
    outputPath?: string | null;
    generatedAtUtc?: string;
    snapshot?: boolean;
    snapshotRetention?: number | null;
    maxDetailedTasks?: number | null;
}

export interface StaticHtmlReportResult {
    output_path: string;
    url: string;
    latest_path: string;
    latest_url: string;
    snapshot_path: string | null;
    snapshot_url: string | null;
    snapshot_retention: number | null;
    deleted_snapshot_paths: string[];
    task_count: number;
    detailed_task_count: number;
    skipped_detail_count: number;
    max_detailed_tasks: number;
    workflow_setting_count: number;
    unavailable_count: number;
}

function escapeHtml(value: unknown): string {
    return String(value ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function escapeJsonForScript(value: unknown): string {
    return JSON.stringify(value)
        .replace(/</g, '\\u003c')
        .replace(/>/g, '\\u003e')
        .replace(/&/g, '\\u0026')
        .replace(/\u2028/g, '\\u2028')
        .replace(/\u2029/g, '\\u2029');
}

function formatNumber(value: number | null | undefined): string {
    return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

function formatDuration(seconds: number | null | undefined): string {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
        return '-';
    }
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = seconds % 60;
    return remainingSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainingSeconds}s`;
}

function renderTaskRow(task: ReportTaskRow, index: number): string {
    const stats = task.detail.stats;
    return [
        `<tr data-task-index="${index}" tabindex="0">`,
        `<td><span class="task-id">${escapeHtml(task.task_id)}</span></td>`,
        `<td>${escapeHtml(task.status_token || task.status)}</td>`,
        `<td>${escapeHtml(task.priority)}</td>`,
        `<td>${escapeHtml(task.area)}</td>`,
        `<td>${escapeHtml(task.title)}</td>`,
        `<td>${escapeHtml(task.profile)}</td>`,
        `<td>${task.detail.detail_status === 'skipped' ? 'skipped' : formatNumber(stats?.events_count)}</td>`,
        `<td>${task.detail.detail_status === 'skipped' ? 'skipped' : formatDuration(stats?.wall_clock_seconds)}</td>`,
        '</tr>'
    ].join('');
}

function renderWorkflowSetting(setting: ReportWorkflowSetting): string {
    return [
        '<tr>',
        `<td><code>${escapeHtml(setting.key)}</code></td>`,
        `<td>${escapeHtml(JSON.stringify(setting.value))}</td>`,
        `<td>${escapeHtml(setting.description)}</td>`,
        `<td><code>${escapeHtml(setting.command)}</code></td>`,
        '</tr>'
    ].join('');
}

function renderTaskDetailTemplate(): string {
    return [
        '<template id="task-detail-template">',
        '<section class="detail">',
        '<div class="detail-head">',
        '<div>',
        '<p class="eyebrow">Task</p>',
        '<h2 data-field="title"></h2>',
        '</div>',
        '<span class="pill" data-field="status"></span>',
        '</div>',
        '<div class="metrics">',
        '<div data-metric="events"></div>',
        '<div data-metric="passes"></div>',
        '<div data-metric="fails"></div>',
        '<div data-metric="reviews"></div>',
        '<div data-metric="changed"></div>',
        '<div data-metric="duration"></div>',
        '</div>',
        '<div class="detail-grid">',
        '<section>',
        '<h3>Latest Cycle</h3>',
        '<pre data-field="latest-cycle"></pre>',
        '</section>',
        '<section>',
        '<h3>Artifacts</h3>',
        '<ul data-field="artifacts"></ul>',
        '</section>',
        '</div>',
        '<section>',
        '<h3>Unavailable</h3>',
        '<ul data-field="unavailable"></ul>',
        '</section>',
        '</section>',
        '</template>'
    ].join('');
}

function renderBaseHtml(report: ReportDataContract): string {
    const rows = report.tasks_tab.rows;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garda HTML Report</title>
<style>
:root { color-scheme: light; --ink: #18202a; --muted: #667085; --line: #d8dee8; --panel: #f7f9fc; --accent: #1f7a6d; --accent-2: #8a4b17; --danger: #b42318; }
* { box-sizing: border-box; }
body { margin: 0; font-family: Arial, Helvetica, sans-serif; color: var(--ink); background: #ffffff; }
header { padding: 20px 24px 12px; border-bottom: 1px solid var(--line); background: #fdfefe; }
h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.2; letter-spacing: 0; }
h2 { margin: 0; font-size: 20px; letter-spacing: 0; }
h3 { margin: 0 0 10px; font-size: 15px; letter-spacing: 0; }
p { margin: 0; }
code, pre { font-family: Consolas, "Courier New", monospace; }
pre { white-space: pre-wrap; word-break: break-word; overflow: auto; max-height: 260px; padding: 10px; background: #111827; color: #f9fafb; border-radius: 6px; }
button { font: inherit; }
.meta { color: var(--muted); font-size: 13px; display: flex; flex-wrap: wrap; gap: 10px 16px; }
.tabs { display: flex; gap: 6px; padding: 12px 24px 0; border-bottom: 1px solid var(--line); background: #fff; }
.tab { border: 1px solid var(--line); border-bottom: 0; background: var(--panel); color: var(--ink); padding: 9px 12px; border-radius: 6px 6px 0 0; cursor: pointer; }
.tab[aria-selected="true"] { background: #fff; color: var(--accent); font-weight: 700; }
main { padding: 16px 24px 28px; }
.panel { display: none; }
.panel.active { display: block; }
.task-layout { display: grid; grid-template-columns: minmax(420px, 1fr) minmax(360px, 0.8fr); gap: 16px; align-items: start; }
.table-wrap { overflow: auto; border: 1px solid var(--line); border-radius: 8px; }
table { width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 9px 10px; border-bottom: 1px solid var(--line); vertical-align: top; }
th { background: var(--panel); color: #344054; position: sticky; top: 0; z-index: 1; }
tr[data-task-index] { cursor: pointer; }
tr[data-task-index].selected, tr[data-task-index]:focus { outline: 2px solid var(--accent); outline-offset: -2px; background: #eef8f6; }
.task-id { font-weight: 700; color: var(--accent); }
.detail, .card { border: 1px solid var(--line); border-radius: 8px; padding: 14px; background: #fff; }
.detail-head { display: flex; justify-content: space-between; gap: 12px; align-items: start; border-bottom: 1px solid var(--line); padding-bottom: 12px; margin-bottom: 12px; }
.eyebrow { color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: .06em; margin-bottom: 4px; }
.pill { display: inline-flex; align-items: center; min-height: 26px; padding: 4px 8px; border-radius: 999px; background: #fff4e5; color: var(--accent-2); font-size: 12px; font-weight: 700; white-space: nowrap; }
.metrics { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 8px; margin-bottom: 14px; }
.metric { min-height: 54px; padding: 8px; background: var(--panel); border: 1px solid var(--line); border-radius: 6px; }
.metric span { display: block; color: var(--muted); font-size: 12px; margin-bottom: 4px; }
.metric strong { font-size: 15px; overflow-wrap: anywhere; }
.detail-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; margin-bottom: 14px; }
ul { margin: 0; padding-left: 18px; }
li { margin: 4px 0; }
.settings-table td:nth-child(4) { min-width: 320px; }
.instructions { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.unavailable { margin-top: 14px; color: var(--danger); }
@media (max-width: 980px) { .task-layout, .detail-grid { grid-template-columns: 1fr; } .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (max-width: 640px) { header, main { padding-left: 14px; padding-right: 14px; } .tabs { padding-left: 14px; padding-right: 14px; overflow-x: auto; } .metrics { grid-template-columns: 1fr; } th, td { padding: 8px; } }
</style>
</head>
<body>
<header>
<h1>Garda HTML Report</h1>
<div class="meta">
<span>Generated: ${escapeHtml(report.generated_at_utc)}</span>
<span>Repo: ${escapeHtml(report.repo_root)}</span>
<span>Tasks: ${rows.length}</span>
<span>Unavailable: ${report.unavailable.length}</span>
</div>
</header>
<nav class="tabs" role="tablist">
<button class="tab" type="button" role="tab" aria-selected="true" data-tab="tasks">Tasks</button>
<button class="tab" type="button" role="tab" aria-selected="false" data-tab="workflow">Workflow Config</button>
<button class="tab" type="button" role="tab" aria-selected="false" data-tab="instructions">Instructions</button>
</nav>
<main>
<section class="panel active" id="tab-tasks" role="tabpanel">
<div class="task-layout">
<div class="table-wrap">
<table>
<thead><tr><th>ID</th><th>Status</th><th>Priority</th><th>Area</th><th>Title</th><th>Profile</th><th>Events</th><th>Time</th></tr></thead>
<tbody>${rows.map(renderTaskRow).join('')}</tbody>
</table>
</div>
<div id="task-detail"></div>
</div>
</section>
<section class="panel" id="tab-workflow" role="tabpanel">
<div class="card">
<h2>Workflow Config</h2>
<p class="meta">Path: ${escapeHtml(report.workflow_config_tab.config_path)} | Status: ${escapeHtml(report.workflow_config_tab.status)}</p>
<div class="table-wrap" style="margin-top: 12px;">
<table class="settings-table">
<thead><tr><th>Setting</th><th>Value</th><th>Description</th><th>Command</th></tr></thead>
<tbody>${report.workflow_config_tab.settings.map(renderWorkflowSetting).join('')}</tbody>
</table>
</div>
</div>
</section>
<section class="panel" id="tab-instructions" role="tabpanel">
<div class="instructions">
${report.instructions_tab.entries.map((entry) => `<section class="card"><h2>${escapeHtml(entry.title)}</h2><p>${escapeHtml(entry.body)}</p></section>`).join('')}
</div>
${report.unavailable.length === 0 ? '' : `<section class="card unavailable"><h2>Unavailable Data</h2><ul>${report.unavailable.map((entry) => `<li><strong>${escapeHtml(entry.scope)}</strong>: ${escapeHtml(entry.reason)}</li>`).join('')}</ul></section>`}
</section>
</main>
${renderTaskDetailTemplate()}
<script id="report-data" type="application/json">${escapeJsonForScript(report)}</script>
<script>
const report = JSON.parse(document.getElementById('report-data').textContent);
const tabs = Array.from(document.querySelectorAll('.tab'));
for (const tab of tabs) {
  tab.addEventListener('click', () => {
    for (const item of tabs) item.setAttribute('aria-selected', String(item === tab));
    for (const panel of document.querySelectorAll('.panel')) panel.classList.remove('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
}
function text(value) { return value === null || value === undefined || value === '' ? '-' : String(value); }
function toArtifactHref(pathValue) {
  const value = text(pathValue).replace(/\\\\/g, '/');
  if (/^[A-Za-z]:\\//.test(value)) return 'file:///' + encodeURI(value);
  if (value.startsWith('/')) return 'file://' + encodeURI(value);
  return '';
}
function metric(label, value) { return '<div class="metric"><span>' + label + '</span><strong>' + text(value) + '</strong></div>'; }
function duration(seconds) {
  if (typeof seconds !== 'number') return '-';
  if (seconds < 60) return seconds + 's';
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return rest === 0 ? minutes + 'm' : minutes + 'm ' + rest + 's';
}
function safe(value) {
  return text(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function renderList(items, formatter) {
  if (!items || items.length === 0) return '<li>none</li>';
  return items.map(formatter).join('');
}
function showTask(index) {
  const task = report.tasks_tab.rows[index];
  const stats = task.detail.stats || {};
  const audit = task.detail.audit || {};
  const template = document.getElementById('task-detail-template');
  const node = template.content.cloneNode(true);
  node.querySelector('[data-field="title"]').textContent = task.task_id + ' - ' + task.title;
  node.querySelector('[data-field="status"]').textContent = task.status_token || task.status;
  node.querySelector('[data-metric="events"]').innerHTML = metric('Events', stats.events_count);
  node.querySelector('[data-metric="passes"]').innerHTML = metric('Gate Pass', stats.gate_pass_count);
  node.querySelector('[data-metric="fails"]').innerHTML = metric('Gate Fail', stats.gate_fail_count);
  node.querySelector('[data-metric="reviews"]').innerHTML = metric('Reviews', (stats.required_reviews || []).join(', ') || '-');
  node.querySelector('[data-metric="changed"]').innerHTML = metric('Changed Lines', stats.changed_lines_total);
  node.querySelector('[data-metric="duration"]').innerHTML = metric('Wall Time', duration(stats.wall_clock_seconds));
  node.querySelector('[data-field="latest-cycle"]').textContent = JSON.stringify(task.detail.latest_cycle_events || {}, null, 2);
  node.querySelector('[data-field="artifacts"]').innerHTML = renderList((task.detail.artifact_links || []).filter(item => item.exists).slice(0, 12), item => {
    const href = toArtifactHref(item.path);
    const pathText = safe(item.path);
    const link = href ? '<a href="' + safe(href) + '">' + pathText + '</a>' : pathText;
    return '<li><code>' + safe(item.kind) + '</code> ' + link + '</li>';
  });
  node.querySelector('[data-field="unavailable"]').innerHTML = renderList(task.detail.unavailable || [], item => '<li><strong>' + safe(item.scope) + '</strong>: ' + safe(item.reason) + '</li>');
  const detail = document.getElementById('task-detail');
  detail.replaceChildren(node);
  for (const row of document.querySelectorAll('tr[data-task-index]')) row.classList.toggle('selected', row.dataset.taskIndex === String(index));
}
for (const row of document.querySelectorAll('tr[data-task-index]')) {
  row.addEventListener('click', () => showTask(Number(row.dataset.taskIndex)));
  row.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') showTask(Number(row.dataset.taskIndex)); });
}
if (report.tasks_tab.rows.length > 0) showTask(0);
</script>
</body>
</html>
`;
}

function resolveDefaultOutputPath(repoRoot: string): string {
    return path.join(path.resolve(repoRoot), resolveBundleName(), 'runtime', 'reports', 'garda-report.html');
}

function resolveSnapshotPath(outputPath: string, generatedAtUtc: string): string {
    const snapshotStamp = generatedAtUtc.replace(/[^0-9A-Za-z]/g, '');
    return path.join(path.dirname(outputPath), 'snapshots', `garda-report-${snapshotStamp}.html`);
}

function pruneSnapshots(snapshotPath: string, retention: number | null | undefined): string[] {
    if (typeof retention !== 'number' || !Number.isInteger(retention) || retention < 1) {
        return [];
    }
    const snapshotDir = path.dirname(snapshotPath);
    if (!fs.existsSync(snapshotDir)) {
        return [];
    }
    const snapshotFiles = fs.readdirSync(snapshotDir)
        .filter((fileName) => /^garda-report-[0-9A-Za-z]+\.html$/.test(fileName))
        .sort()
        .map((fileName) => path.join(snapshotDir, fileName));
    const deleteCount = Math.max(0, snapshotFiles.length - retention);
    const deletedPaths = snapshotFiles.slice(0, deleteCount);
    for (const filePath of deletedPaths) {
        fs.rmSync(filePath, { force: true });
    }
    return deletedPaths;
}

export function renderStaticHtmlReport(report: ReportDataContract): string {
    return renderBaseHtml(report);
}

function resolveMaxDetailedTasks(value: number | null | undefined): number {
    return value === null || value === undefined ? DEFAULT_REPORT_MAX_DETAILED_TASKS : value;
}

export function buildStaticHtmlReport(options: BuildStaticHtmlReportOptions): StaticHtmlReportResult {
    const repoRoot = path.resolve(options.repoRoot);
    const generatedAtUtc = options.generatedAtUtc;
    const maxDetailedTasks = resolveMaxDetailedTasks(options.maxDetailedTasks);
    const report = buildReportDataContract({
        repoRoot,
        generatedAtUtc,
        maxDetailedTasks
    });
    const outputPath = path.resolve(options.outputPath || resolveDefaultOutputPath(repoRoot));
    const html = renderStaticHtmlReport(report);
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, html, 'utf8');
    const snapshotPath = options.snapshot === true
        ? resolveSnapshotPath(outputPath, report.generated_at_utc)
        : null;
    if (snapshotPath) {
        fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
        fs.writeFileSync(snapshotPath, html, 'utf8');
    }
    const deletedSnapshotPaths = snapshotPath
        ? pruneSnapshots(snapshotPath, options.snapshotRetention)
        : [];
    return {
        output_path: outputPath,
        url: pathToFileURL(outputPath).href,
        latest_path: outputPath,
        latest_url: pathToFileURL(outputPath).href,
        snapshot_path: snapshotPath,
        snapshot_url: snapshotPath ? pathToFileURL(snapshotPath).href : null,
        snapshot_retention: typeof options.snapshotRetention === 'number' ? options.snapshotRetention : null,
        deleted_snapshot_paths: deletedSnapshotPaths,
        task_count: report.tasks_tab.rows.length,
        detailed_task_count: report.tasks_tab.rows.filter((row) => row.detail.detail_status === 'loaded').length,
        skipped_detail_count: report.tasks_tab.rows.filter((row) => row.detail.detail_status === 'skipped').length,
        max_detailed_tasks: maxDetailedTasks,
        workflow_setting_count: report.workflow_config_tab.settings.length,
        unavailable_count: report.unavailable.length
    };
}
