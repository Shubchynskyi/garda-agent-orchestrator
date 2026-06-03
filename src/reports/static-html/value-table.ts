import { escapeHtml } from './common';
import type { ReportCommandInfo, ReportValueRow } from '../report-data-contract';

export function renderValueTable(rows: ReportValueRow[]): string {
    if (rows.length === 0) {
        return '<p class="meta">No rows.</p>';
    }
    return [
        '<div class="table-wrap">',
        '<table class="value-table">',
        '<thead><tr><th>Setting</th><th>Value</th><th>Description</th></tr></thead>',
        '<tbody>',
        ...rows.map(
            (row) => [
                '<tr>',
                `<td><strong>${escapeHtml(row.label)}</strong><br><code>${escapeHtml(row.id)}</code></td>`,
                `<td><code>${escapeHtml(JSON.stringify(row.value))}</code></td>`,
                `<td>${escapeHtml(row.description)}</td>`,
                '</tr>'
            ].join('')
        ),
        '</tbody>',
        '</table>',
        '</div>'
    ].join('');
}

export function renderCommandList(commands: ReportCommandInfo[]): string {
    if (commands.length === 0) {
        return '';
    }
    return [
        '<section class="stack">',
        '<h3>Reference Commands (read-only)</h3>',
        ...commands.map(
            (command) => [
                '<section class="card">',
                `<h3>${escapeHtml(command.title)}</h3>`,
                `<p class="meta">${escapeHtml(command.description)}</p>`,
                `<pre><code>${escapeHtml(command.command)}</code></pre>`,
                '</section>'
            ].join('')
        ),
        '</section>'
    ].join('');
}
