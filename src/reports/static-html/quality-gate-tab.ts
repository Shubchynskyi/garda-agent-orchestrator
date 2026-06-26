import { escapeHtml } from './common';
import type {
    ReportQualityGateActionRequiredHistoryEntry,
    ReportQualityGateAnswerSummary,
    ReportQualityGateLatestCheck,
    ReportQualityGateRule,
    ReportQualityGateTab
} from '../report-data-contract';

function renderStatuses(rule: ReportQualityGateRule): string {
    return rule.statuses.map((status) => `<code>${escapeHtml(status)}</code>`).join(' ');
}

function renderRule(rule: ReportQualityGateRule): string {
    return [
        '<tr>',
        `<td><code>${escapeHtml(rule.id)}</code></td>`,
        `<td>${escapeHtml(rule.source)}</td>`,
        `<td>${renderStatuses(rule)}</td>`,
        `<td>${escapeHtml(rule.title)}</td>`,
        `<td>${escapeHtml(rule.prompt)}</td>`,
        `<td>${escapeHtml(String(rule.enabled))}</td>`,
        '</tr>'
    ].join('');
}

function renderList(items: readonly string[]): string {
    if (items.length === 0) {
        return '<span class="muted">-</span>';
    }
    return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>`;
}

function renderAnswerDetails(answer: ReportQualityGateAnswerSummary): string {
    return [
        '<li>',
        `<p><code>${escapeHtml(answer.rule_id || '-')}</code> <strong>${escapeHtml(answer.status || '-')}</strong></p>`,
        `<p class="meta">${escapeHtml(answer.answer || '-')}</p>`,
        answer.evidence_files.length > 0 ? `<p><strong>Evidence files</strong>${renderList(answer.evidence_files)}</p>` : '',
        answer.actions_taken.length > 0 ? `<p><strong>Actions taken</strong>${renderList(answer.actions_taken)}</p>` : '',
        answer.actions_required.length > 0 ? `<p><strong>Actions required</strong>${renderList(answer.actions_required)}</p>` : '',
        '</li>'
    ].join('');
}

function renderAnswerSummaries(answers: ReportQualityGateAnswerSummary[]): string {
    if (answers.length === 0) {
        return '';
    }
    return `<p><strong>Rule answers</strong><ul>${answers.map(renderAnswerDetails).join('')}</ul></p>`;
}

function renderLatestCheck(check: ReportQualityGateLatestCheck): string {
    return [
        '<section style="margin-top: 12px;">',
        '<h3>Latest check</h3>',
        '<div class="metrics">',
        `<div><strong>${escapeHtml(check.evidence_status)}</strong><span>Evidence</span></div>`,
        `<div><strong>${escapeHtml(check.effect)}</strong><span>Effect</span></div>`,
        `<div><strong>${escapeHtml(check.checklist_status || '-')}</strong><span>Status</span></div>`,
        `<div><strong>${check.answer_count}</strong><span>Rule answers</span></div>`,
        `<div><strong>${check.action_taken_count}</strong><span>Actions taken</span></div>`,
        `<div><strong>${check.action_required_count}</strong><span>Actions required</span></div>`,
        `<div><strong>${escapeHtml(String(check.changed_files_count ?? '-'))}</strong><span>Changed files</span></div>`,
        `<div><strong>${check.timeline_event_count}</strong><span>Timeline events</span></div>`,
        '</div>',
        `<p class="meta">${escapeHtml(check.summary)}</p>`,
        check.stale_reasons.length > 0 ? `<p>${renderList(check.stale_reasons)}</p>` : '',
        renderAnswerSummaries(check.answers),
        check.actions_required.length > 0 ? `<p><strong>Actions required</strong>${renderList(check.actions_required)}</p>` : '',
        check.actions_taken.length > 0 ? `<p><strong>Actions taken</strong>${renderList(check.actions_taken)}</p>` : '',
        '</section>'
    ].join('');
}

function renderActionRequiredHistory(history: ReportQualityGateActionRequiredHistoryEntry[]): string {
    if (history.length === 0) {
        return '<section style="margin-top: 12px;"><h3>Action-required history</h3><p class="meta">No recent action-required records.</p></section>';
    }
    return [
        '<section style="margin-top: 12px;">',
        '<h3>Action-required history</h3>',
        '<div class="table-wrap">',
        '<table class="settings-table">',
        '<thead><tr><th>Task</th><th>Evidence</th><th>Actions required</th><th>Artifact</th></tr></thead>',
        `<tbody>${history.map((entry) => [
            '<tr>',
            `<td><code>${escapeHtml(entry.task_id || '-')}</code></td>`,
            `<td>${escapeHtml(entry.evidence_status)}</td>`,
            `<td>${renderList(entry.actions_required)}</td>`,
            `<td><code>${escapeHtml(entry.artifact_path)}</code></td>`,
            '</tr>'
        ].join('')).join('')}</tbody>`,
        '</table>',
        '</div>',
        '</section>'
    ].join('');
}

export function renderQualityGatePanel(tab: ReportQualityGateTab): string {
    return [
        '<section class="panel" id="tab-quality-gate" role="tabpanel" hidden>',
        '<div class="card">',
        '<h2>Quality Gate</h2>',
        `<p class="meta">Path: ${escapeHtml(tab.config_path)} | Status: ${escapeHtml(tab.status)}</p>`,
        '<div class="metrics">',
        `<div><strong>${escapeHtml(String(tab.enabled))}</strong><span>Enabled</span></div>`,
        `<div><strong>${escapeHtml(tab.baseline_version || '-')}</strong><span>Current baseline</span></div>`,
        `<div><strong>${escapeHtml(tab.shipped_baseline_version || '-')}</strong><span>Shipped baseline</span></div>`,
        `<div><strong>${tab.baseline_rule_count}</strong><span>Baseline rules</span></div>`,
        `<div><strong>${tab.custom_rule_count}</strong><span>Custom rules</span></div>`,
        `<div><strong>${tab.deleted_baseline_rule_count}</strong><span>Deleted baseline rules</span></div>`,
        '</div>',
        renderLatestCheck(tab.latest_check),
        renderActionRequiredHistory(tab.action_required_history),
        '<div class="table-wrap" style="margin-top: 12px;">',
        '<table class="settings-table">',
        '<thead><tr><th>ID</th><th>Source</th><th>Status</th><th>Title</th><th>Prompt</th><th>Enabled</th></tr></thead>',
        `<tbody>${tab.rules.map(renderRule).join('')}</tbody>`,
        '</table>',
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
