import { escapeHtml, renderUnavailableList } from './common';
import type { ReportBackupRow, ReportBackupsTab } from '../report-data-contract';

function renderBackupRow(row: ReportBackupRow): string {
    return [
        '<tr>',
        `<td><code>${escapeHtml(row.id)}</code></td>`,
        `<td>${escapeHtml(row.reason)}</td>`,
        `<td>${escapeHtml(row.created_at)}</td>`,
        `<td>${escapeHtml(row.size_human)}</td>`,
        `<td>${escapeHtml(row.health)}${row.health_message ? `<br>${escapeHtml(row.health_message)}` : ''}</td>`,
        `<td>${escapeHtml(String(row.record_count))}</td>`,
        `<td>${row.restorable ? 'yes' : 'no'}</td>`,
        `<td><code>${escapeHtml(row.relative_snapshot_path)}</code></td>`,
        '</tr>'
    ].join('');
}

export function renderBackupsPanel(tab: ReportBackupsTab): string {
    const autoBackup = tab.auto_backup;
    return [
        '<section class="panel" id="tab-backups" role="tabpanel">',
        '<div class="stack">',
        '<p class="notice">Backups tab is read-only in static HTML. Inventory reflects snapshot time at report generation; manual create and restore actions are available only through the live <code>garda ui --actions</code> server.</p>',
        '<div class="card">',
        '<h2>Backups</h2>',
        `<p class="meta">Snapshots root: ${escapeHtml(tab.snapshots_root)} (${tab.snapshots_root_exists ? 'present' : 'missing'})</p>`,
        '<p class="meta">',
        `Auto-backup: enabled=${autoBackup.enabled}, interval_days=${autoBackup.interval_days}, keep_latest=${autoBackup.keep_latest}`,
        '</p>',
        '<div class="table-wrap" style="margin-top: 12px;">',
        '<table>',
        '<thead><tr><th>ID</th><th>Reason</th><th>Created</th><th>Size</th><th>Health</th><th>Records</th><th>Restorable</th><th>Snapshot Path</th></tr></thead>',
        `<tbody>${tab.rows.length === 0 ? '<tr><td colspan="8" class="meta">No backups in inventory.</td></tr>' : tab.rows.map(renderBackupRow).join('')}</tbody>`,
        '</table>',
        '</div>',
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
