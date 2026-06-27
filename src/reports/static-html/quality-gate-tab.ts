import { escapeHtml } from './common';
import type {
    ReportQualityGateRule,
    ReportQualityGateTab
} from '../report-data-contract';
import { formatQualityRulePackVersion } from '../report-data/quality-baseline-labels';

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

export function renderQualityGatePanel(tab: ReportQualityGateTab): string {
    const installedRulePack = tab.baseline_version_label || formatQualityRulePackVersion(tab.baseline_version);
    const shippedRulePack = tab.shipped_baseline_version_label || formatQualityRulePackVersion(tab.shipped_baseline_version);
    return [
        '<section class="panel" id="tab-quality-gate" role="tabpanel" hidden>',
        '<div class="card">',
        '<h2>Quality Gate</h2>',
        `<p class="meta">Status: ${escapeHtml(tab.status)}</p>`,
        '<div class="metrics">',
        `<div><strong>${escapeHtml(String(tab.enabled))}</strong><span>Enabled</span></div>`,
        `<div><strong>${escapeHtml(installedRulePack)}</strong><span>Installed rule pack</span></div>`,
        `<div><strong>${escapeHtml(shippedRulePack)}</strong><span>Shipped rule pack</span></div>`,
        `<div><strong>${tab.baseline_rule_count}</strong><span>Baseline rules</span></div>`,
        `<div><strong>${tab.custom_rule_count}</strong><span>Custom rules</span></div>`,
        '</div>',
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
