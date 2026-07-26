import { escapeHtml, renderUnavailableList } from './common';
import type { ReportDataContract } from '../report-data-contract';
import { buildInstructionsReportUiTabMetadata } from '../ui/dashboard/instructions-report-ui-tab';

export function renderInstructionsPanel(report: ReportDataContract): string {
    const metadata = buildInstructionsReportUiTabMetadata(report.instructions_tab);
    const entries = report.instructions_tab.entries.map(
        (entry) => `<section class="card"><h2>${escapeHtml(entry.title)}</h2><p>${escapeHtml(entry.body)}</p></section>`
    ).join('');
    const globalUnavailable = renderUnavailableList(report.unavailable);
    return [
        `<section class="panel" id="tab-${metadata.id}" data-status="${metadata.status}" role="tabpanel">`,
        '<div class="instructions">',
        entries,
        '</div>',
        globalUnavailable,
        '</section>'
    ].join('');
}
