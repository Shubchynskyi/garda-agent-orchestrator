import { escapeHtml } from './common';
import type { ReportWorkflowConfigTab, ReportWorkflowSetting } from '../report-data-contract';

function renderWorkflowSetting(setting: ReportWorkflowSetting): string {
    const options = setting.options.length > 0
        ? setting.options.map((option) => `${option.label} (${option.value}): ${option.description}`).join('\n')
        : 'No fixed options';
    return [
        '<tr>',
        `<td><strong>${escapeHtml(setting.label)}</strong><br><code>(${escapeHtml(setting.key)})</code></td>`,
        `<td>${escapeHtml(JSON.stringify(setting.value))}</td>`,
        `<td>${escapeHtml(setting.description)}<br><pre>${escapeHtml(options)}</pre></td>`,
        `<td><code>${escapeHtml(setting.command)}</code></td>`,
        '</tr>'
    ].join('');
}

export function renderWorkflowPanel(tab: ReportWorkflowConfigTab): string {
    return [
        '<section class="panel" id="tab-workflow" role="tabpanel">',
        '<div class="card">',
        '<h2>Workflow Config</h2>',
        `<p class="meta">Path: ${escapeHtml(tab.config_path)} | Status: ${escapeHtml(tab.status)}</p>`,
        '<div class="table-wrap" style="margin-top: 12px;">',
        '<table class="settings-table">',
        '<thead><tr><th>Setting</th><th>Value</th><th>Description</th><th>Command</th></tr></thead>',
        `<tbody>${tab.settings.map(renderWorkflowSetting).join('')}</tbody>`,
        '</table>',
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
