import type { ReportDataContract } from '../report-data-contract';
import { escapeHtml, escapeJsonForScript, type StaticHtmlRenderContext } from './common';
import { renderBackupsPanel } from './backups-tab';
import { renderInitSettingsPanel } from './init-settings-tab';
import { renderInstructionsPanel } from './instructions-tab';
import { renderProjectMemoryPanel } from './project-memory-tab';
import { STATIC_HTML_REPORT_STYLES } from './styles';
import { renderTaskDetailTemplate, renderTasksPanel, STATIC_HTML_TASK_CLIENT_SCRIPT } from './tasks-tab';
import { renderWorkflowPanel } from './workflow-tab';

export const STATIC_HTML_REPORT_TABS = [
    { id: 'tasks', label: 'Tasks' },
    { id: 'workflow', label: 'Workflow Config' },
    { id: 'init-settings', label: 'Init Settings' },
    { id: 'project-memory', label: 'Project Memory' },
    { id: 'backups', label: 'Backups' },
    { id: 'instructions', label: 'Instructions' }
] as const;

function renderTabButtons(): string {
    return STATIC_HTML_REPORT_TABS.map((tab, index) => [
        `<button class="tab" type="button" role="tab" aria-selected="${index === 0 ? 'true' : 'false'}" data-tab="${tab.id}">${escapeHtml(tab.label)}</button>`
    ].join('')).join('');
}

export function renderStaticHtmlDocument(report: ReportDataContract, context: StaticHtmlRenderContext): string {
    const rows = report.tasks_tab.rows;
    return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Garda HTML Report</title>
<style>
${STATIC_HTML_REPORT_STYLES}
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
${renderTabButtons()}
</nav>
<main>
${renderTasksPanel(rows)}
${renderWorkflowPanel(report.workflow_config_tab)}
${renderInitSettingsPanel(report.init_settings_tab, context)}
${renderProjectMemoryPanel(report.project_memory_tab, context)}
${renderBackupsPanel(report.backups_tab)}
${renderInstructionsPanel(report)}
</main>
${renderTaskDetailTemplate()}
<script id="report-data" type="application/json">${escapeJsonForScript(report)}</script>
<script>
const report = JSON.parse(document.getElementById('report-data').textContent);
${STATIC_HTML_TASK_CLIENT_SCRIPT}
</script>
</body>
</html>
`;
}
