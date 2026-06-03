import { escapeHtml, renderUnavailableList } from './common';
import { renderCommandList, renderValueTable } from './value-table';
import type { ReportInitSettingsTab } from '../report-data-contract';

export function renderInitSettingsPanel(tab: ReportInitSettingsTab): string {
    return [
        '<section class="panel" id="tab-init-settings" role="tabpanel">',
        '<div class="stack">',
        '<div class="card">',
        '<h2>Init Settings</h2>',
        `<p class="meta">Init answers: ${escapeHtml(tab.init_answers_path)} (${escapeHtml(tab.init_answers_status)})</p>`,
        `<p class="meta">Agent init state: ${escapeHtml(tab.agent_init_state_path)} (${escapeHtml(tab.agent_init_state_status)})</p>`,
        '<h3>Init Answers</h3>',
        renderValueTable(tab.init_answers),
        '<h3 style="margin-top: 14px;">Agent Init State</h3>',
        renderValueTable(tab.agent_init_state),
        renderCommandList(tab.commands),
        renderUnavailableList(tab.unavailable),
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
