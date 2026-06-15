import { escapeHtml, renderUnavailableList, type StaticHtmlRenderContext } from './common';
import { renderCommandList, renderValueTable } from './value-table';
import type { ReportInitSettingsTab } from '../report-data-contract';

export function renderInitSettingsPanel(tab: ReportInitSettingsTab, context: StaticHtmlRenderContext): string {
    return [
        '<section class="panel" id="tab-init-settings" role="tabpanel">',
        '<div class="stack">',
        '<div class="card">',
        '<h2>Init Settings</h2>',
        `<p class="meta">Init answers: ${escapeHtml(tab.init_answers_path)} (${escapeHtml(tab.init_answers_status)})</p>`,
        `<p class="meta">Agent init state: ${escapeHtml(tab.agent_init_state_path)} (${escapeHtml(tab.agent_init_state_status)})</p>`,
        '<h3>Init Answers</h3>',
        renderValueTable(tab.init_answers, context),
        '<h3 style="margin-top: 14px;">Agent Init State</h3>',
        renderValueTable(tab.agent_init_state, context),
        '<h3 style="margin-top: 14px;">Ordinary Documents</h3>',
        `<p class="meta">Config: ${escapeHtml(tab.ordinary_docs.config_path)} (${escapeHtml(tab.ordinary_docs.status)}). These paths are ordinary planning/changelog/product documents; changing them does not trigger extra review lanes by itself.</p>`,
        tab.ordinary_docs.paths.length === 0
            ? '<p class="meta">No ordinary document paths configured.</p>'
            : `<ul>${tab.ordinary_docs.paths.map((entry) => `<li><code>${escapeHtml(entry)}</code></li>`).join('')}</ul>`,
        renderCommandList(tab.commands),
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
