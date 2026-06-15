import { escapeHtml, renderUnavailableList, toStaticRepoFileHref, type StaticHtmlRenderContext } from './common';
import { renderValueTable } from './value-table';
import type { ReportProjectMemoryFile, ReportProjectMemoryTab } from '../report-data-contract';

function renderMemoryFile(file: ReportProjectMemoryFile, context: StaticHtmlRenderContext): string {
    const sizeLabel = typeof file.size_bytes === 'number' ? `${file.size_bytes} bytes` : '-';
    const href = file.exists ? toStaticRepoFileHref(context, file.path) : null;
    const openLink = file.exists && href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open file</a>`
        : `<span class="meta">${file.exists ? 'Open unavailable.' : 'File missing.'}</span>`;
    return [
        '<section class="card memory-file">',
        `<h3>${escapeHtml(file.path)}</h3>`,
        `<p class="meta">${escapeHtml(file.purpose)} | read: ${escapeHtml(file.read_role)} | size: ${escapeHtml(sizeLabel)}</p>`,
        openLink,
        '</section>'
    ].join('');
}

export function renderProjectMemoryPanel(tab: ReportProjectMemoryTab, context: StaticHtmlRenderContext): string {
    const filesMarkup = tab.files.length === 0
        ? '<p class="meta">No project memory files recorded.</p>'
        : tab.files.map((file) => renderMemoryFile(file, context)).join('');
    return [
        '<section class="panel" id="tab-project-memory" role="tabpanel">',
        '<div class="stack">',
        '<div class="card">',
        '<h2>Project Memory</h2>',
        '<h3>Status</h3>',
        renderValueTable(tab.status, context),
        '<h3 style="margin-top: 14px;">Files</h3>',
        filesMarkup,
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
