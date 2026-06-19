import { escapeHtml, renderUnavailableList, toStaticRepoFileHref, type StaticHtmlRenderContext } from './common';
import { renderValueTable } from './value-table';
import type { ReportProjectMemoryFile, ReportProjectMemoryTab } from '../report-data-contract';

function renderMemoryAdvisory(tab: ReportProjectMemoryTab, context: StaticHtmlRenderContext): string {
    const href = tab.advisory.prompt_exists ? toStaticRepoFileHref(context, tab.advisory.prompt_path) : null;
    const promptLink = href
        ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">Open prompt</a>`
        : '<span class="meta">Prompt file unavailable.</span>';
    return [
        '<section class="card memory-file">',
        '<h3>Project Memory Optimization</h3>',
        '<p class="meta">Occasionally assign an agent to optimize project-memory files. Choose a deep-reasoning agent and give it this prompt.</p>',
        `<p class="meta">Prompt file: <code>${escapeHtml(tab.advisory.prompt_path)}</code></p>`,
        promptLink,
        '</section>'
    ].join('');
}

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
    const settingsMarkup = tab.settings.length === 0
        ? '<p class="meta">No project-memory workflow settings recorded.</p>'
        : [
            '<table><thead><tr><th>Setting</th><th>Current value</th><th>Change command</th></tr></thead><tbody>',
            tab.settings.map((setting) => [
                '<tr>',
                `<td><strong>${escapeHtml(setting.label)}</strong><br><code>${escapeHtml(setting.key)}</code></td>`,
                `<td><code>${escapeHtml(JSON.stringify(setting.value))}</code></td>`,
                `<td><code>${escapeHtml(setting.command)}</code></td>`,
                '</tr>'
            ].join('')).join(''),
            '</tbody></table>'
        ].join('');
    return [
        '<section class="panel" id="tab-project-memory" role="tabpanel">',
        '<div class="stack">',
        '<div class="card">',
        '<h2>Project Memory</h2>',
        renderMemoryAdvisory(tab, context),
        '<h3>Status</h3>',
        renderValueTable(tab.status, context),
        '<h3 style="margin-top: 14px;">Limits and workflow settings</h3>',
        settingsMarkup,
        '<h3 style="margin-top: 14px;">Files</h3>',
        filesMarkup,
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
