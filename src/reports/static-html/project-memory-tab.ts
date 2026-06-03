import { escapeHtml, renderUnavailableList } from './common';
import { renderValueTable } from './value-table';
import type { ReportProjectMemoryFile, ReportProjectMemoryTab } from '../report-data-contract';

function renderMemoryFile(file: ReportProjectMemoryFile): string {
    const sizeLabel = typeof file.size_bytes === 'number' ? `${file.size_bytes} bytes` : '-';
    const contentBlock = file.exists && file.content
        ? `<pre>${escapeHtml(file.content)}</pre>`
        : '<p class="meta">File missing or empty.</p>';
    return [
        '<section class="card memory-file">',
        `<h3>${escapeHtml(file.path)}</h3>`,
        `<p class="meta">${escapeHtml(file.purpose)} | read: ${escapeHtml(file.read_role)} | size: ${escapeHtml(sizeLabel)}</p>`,
        contentBlock,
        '</section>'
    ].join('');
}

export function renderProjectMemoryPanel(tab: ReportProjectMemoryTab): string {
    const filesMarkup = tab.files.length === 0
        ? '<p class="meta">No project memory files recorded.</p>'
        : tab.files.map(renderMemoryFile).join('');
    return [
        '<section class="panel" id="tab-project-memory" role="tabpanel">',
        '<div class="stack">',
        '<div class="card">',
        '<h2>Project Memory</h2>',
        '<h3>Status</h3>',
        renderValueTable(tab.status),
        '<h3 style="margin-top: 14px;">Files</h3>',
        filesMarkup,
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
