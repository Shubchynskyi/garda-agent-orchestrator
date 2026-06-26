import * as path from 'node:path';
import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
    type OptionalQualityCheckRule
} from '../../core/workflow-config';
import { joinOrchestratorPath } from '../../gates/shared/helpers';
import type {
    ReportQualityGateRule,
    ReportQualityGateRuleStatus,
    ReportQualityGateTab,
    ReportWorkflowConfigTab
} from './types';
import { buildQualityGateEvidence } from './quality-gate-evidence';

interface BuildQualityGateTabOptions {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    workflowConfigTab: ReportWorkflowConfigTab;
}

function baselineRuleMap(): Map<string, OptionalQualityCheckRule> {
    return new Map(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule]));
}

function getRuleStatuses(rule: OptionalQualityCheckRule, baselineRule: OptionalQualityCheckRule | undefined): ReportQualityGateRuleStatus[] {
    const statuses: ReportQualityGateRuleStatus[] = [];
    if (rule.enabled === false) {
        statuses.push('disabled');
    }
    if (baselineRule && (rule.title !== baselineRule.title || rule.prompt !== baselineRule.prompt)) {
        statuses.push('locally_edited');
    }
    return statuses.length > 0 ? statuses : ['active'];
}

function buildPresentRule(rule: OptionalQualityCheckRule, baselineRule: OptionalQualityCheckRule | undefined): ReportQualityGateRule {
    return {
        id: rule.id,
        title: rule.title,
        prompt: rule.prompt,
        enabled: rule.enabled !== false,
        present: true,
        source: baselineRule ? 'baseline' : 'custom',
        statuses: getRuleStatuses(rule, baselineRule),
        baseline_title: baselineRule?.title ?? null,
        baseline_prompt: baselineRule?.prompt ?? null
    };
}

function buildDeletedBaselineRule(rule: OptionalQualityCheckRule): ReportQualityGateRule {
    return {
        id: rule.id,
        title: rule.title,
        prompt: rule.prompt,
        enabled: false,
        present: false,
        source: 'baseline',
        statuses: ['deleted'],
        baseline_title: rule.title,
        baseline_prompt: rule.prompt
    };
}

function inferRepoRootFromWorkflowConfigPath(workflowConfigTab: ReportWorkflowConfigTab): string {
    const configPath = workflowConfigTab.config_path.replace(/\//gu, path.sep);
    return path.resolve(path.dirname(configPath), '..', '..', '..');
}

function normalizeBuildOptions(input: ReportWorkflowConfigTab | BuildQualityGateTabOptions): BuildQualityGateTabOptions {
    if ('workflowConfigTab' in input) {
        return input;
    }
    const repoRoot = inferRepoRootFromWorkflowConfigPath(input);
    return {
        repoRoot,
        reviewsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')),
        eventsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
        workflowConfigTab: input
    };
}

export function buildQualityGateTab(workflowConfigTab: ReportWorkflowConfigTab): ReportQualityGateTab;
export function buildQualityGateTab(options: BuildQualityGateTabOptions): ReportQualityGateTab;
export function buildQualityGateTab(input: ReportWorkflowConfigTab | BuildQualityGateTabOptions): ReportQualityGateTab {
    const options = normalizeBuildOptions(input);
    const workflowConfigTab = options.workflowConfigTab;
    const optionalQualityChecks = workflowConfigTab.optional_quality_checks;
    const baselineRules = baselineRuleMap();
    const presentRules = optionalQualityChecks.rules.map((rule) => buildPresentRule(rule, baselineRules.get(rule.id)));
    const presentRuleIds = new Set(presentRules.map((rule) => rule.id));
    const deletedBaselineRules = DEFAULT_OPTIONAL_QUALITY_CHECK_RULES
        .filter((rule) => !presentRuleIds.has(rule.id))
        .map((rule) => buildDeletedBaselineRule(rule));
    const rules = [...presentRules, ...deletedBaselineRules];
    const evidence = buildQualityGateEvidence({
        repoRoot: options.repoRoot,
        reviewsRoot: options.reviewsRoot,
        eventsRoot: options.eventsRoot,
        workflowConfigTab
    });

    return {
        config_path: workflowConfigTab.config_path,
        config_exists: workflowConfigTab.config_exists,
        status: workflowConfigTab.status,
        enabled: optionalQualityChecks.enabled,
        baseline_version: optionalQualityChecks.baseline_version,
        shipped_baseline_version: OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
        baseline_rule_count: rules.filter((rule) => rule.source === 'baseline' && rule.present).length,
        custom_rule_count: rules.filter((rule) => rule.source === 'custom').length,
        deleted_baseline_rule_count: deletedBaselineRules.length,
        rules,
        latest_check: evidence.latestCheck,
        action_required_history: evidence.actionRequiredHistory,
        unavailable: workflowConfigTab.unavailable
    };
}
