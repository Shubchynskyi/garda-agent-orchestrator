import { escapeHtml } from './common';
import type {
    ReportQualityGateLatestCheck,
    ReportQualityGateRule,
    ReportQualityGateTab
} from '../report-data-contract';
import { formatQualityRulePackVersion } from '../report-data/quality-baseline-labels';

function renderStatuses(rule: ReportQualityGateRule): string {
    return rule.statuses.map((status) => `<code>${escapeHtml(status)}</code>`).join(' ');
}

function renderScopeList(values: string[]): string {
    return values.length > 0
        ? values.map((value) => `<code>${escapeHtml(value)}</code>`).join(' ')
        : '<span class="muted">-</span>';
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
        `<td>${renderScopeList(rule.excluded_scope_categories)}</td>`,
        '</tr>'
    ].join('');
}

function renderLatestCheck(latest: ReportQualityGateLatestCheck): string {
    const skippedRules = latest.skipped_by_scope_rules.length > 0
        ? [
            '<div class="table-wrap" style="margin-top: 12px;">',
            '<table class="settings-table">',
            '<thead><tr><th>ID</th><th>Title</th><th>Excluded scopes</th><th>Skip reason</th></tr></thead>',
            `<tbody>${latest.skipped_by_scope_rules.map((rule) => [
                '<tr>',
                `<td><code>${escapeHtml(rule.rule_id)}</code></td>`,
                `<td>${escapeHtml(rule.title)}</td>`,
                `<td>${renderScopeList(rule.excluded_scope_categories)}</td>`,
                `<td>${escapeHtml(rule.scope_skip_reason || '-')}</td>`,
                '</tr>'
            ].join('')).join('')}</tbody>`,
            '</table>',
            '</div>'
        ].join('')
        : '<p class="muted">No rules were skipped by scope.</p>';
    return [
        '<div style="margin-top: 12px;">',
        '<h3>Latest check</h3>',
        '<div class="metrics">',
        `<div><strong>${escapeHtml(latest.evidence_status)}</strong><span>Evidence</span></div>`,
        `<div><strong>${escapeHtml(latest.effect)}</strong><span>Effect</span></div>`,
        `<div><strong>${escapeHtml(latest.scope_category || '-')}</strong><span>Scope</span></div>`,
        `<div><strong>${escapeHtml(String(latest.changed_files_count ?? '-'))}</strong><span>Changed files</span></div>`,
        `<div><strong>${escapeHtml(String(latest.enabled_rule_count))}</strong><span>Enabled rules</span></div>`,
        `<div><strong>${escapeHtml(String(latest.active_rule_count ?? '-'))}</strong><span>Active rules</span></div>`,
        `<div><strong>${escapeHtml(String(latest.skipped_by_scope_rule_count ?? '-'))}</strong><span>Skipped by scope</span></div>`,
        '</div>',
        `<p class="meta">${escapeHtml(latest.summary)}</p>`,
        '<h4>Skipped by scope</h4>',
        skippedRules,
        '</div>'
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
        renderLatestCheck(tab.latest_check),
        '<div class="table-wrap" style="margin-top: 12px;">',
        '<table class="settings-table">',
        '<thead><tr><th>ID</th><th>Source</th><th>Status</th><th>Title</th><th>Prompt</th><th>Enabled</th><th>Excluded scopes</th></tr></thead>',
        `<tbody>${tab.rules.map(renderRule).join('')}</tbody>`,
        '</table>',
        '</div>',
        '</div>',
        '</section>'
    ].join('');
}
