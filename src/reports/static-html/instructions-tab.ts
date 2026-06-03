import { escapeHtml, renderUnavailableList } from './common';
import type { ReportDataContract } from '../report-data-contract';

export function renderInstructionsPanel(report: ReportDataContract): string {
    const entries = report.instructions_tab.entries.map(
        (entry) => `<section class="card"><h2>${escapeHtml(entry.title)}</h2><p>${escapeHtml(entry.body)}</p></section>`
    ).join('');
    const globalUnavailable = renderUnavailableList(report.unavailable);
    return [
        '<section class="panel" id="tab-instructions" role="tabpanel">',
        '<div class="instructions">',
        entries,
        '</div>',
        globalUnavailable,
        '</section>'
    ].join('');
}
