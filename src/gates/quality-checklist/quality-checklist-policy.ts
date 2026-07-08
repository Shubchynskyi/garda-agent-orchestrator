import { createHash } from 'node:crypto';

import {
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES,
    isOptionalQualityCheckRuleActiveForScope,
    isBaselineOptionalQualityCheckRuleId,
    normalizeOptionalQualityCheckChangedFileRegexes,
    normalizeOptionalQualityCheckScopeCategories,
    type OptionalQualityCheckRule
} from '../../core/workflow-config';

export interface QualityChecklistEffectivePolicyEntry {
    id: string;
    source: 'baseline' | 'custom';
    enabled: boolean;
    included_scope_categories: string[];
    included_changed_file_regexes: string[];
    excluded_scope_categories: string[];
    scope_applicability: 'active' | 'disabled' | 'skipped_by_scope';
    title: string;
    prompt: string;
}

export interface QualityChecklistPolicyCompatibility {
    compatible: boolean;
    reasons: string[];
    effective_policy_sha256: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function normalizeRuleId(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeText(value: unknown): string {
    return String(value || '').trim();
}

function uniqueSorted(values: readonly string[]): string[] {
    return [...new Set(values)].sort();
}

function sha256Json(value: unknown): string {
    return createHash('sha256').update(`${JSON.stringify(value)}\n`, 'utf8').digest('hex');
}

function scopeApplicabilityForRule(
    rule: OptionalQualityCheckRule,
    scopeCategory: string | null,
    changedFiles: readonly unknown[] = []
): QualityChecklistEffectivePolicyEntry['scope_applicability'] {
    if (rule.enabled === false) {
        return 'disabled';
    }
    return isOptionalQualityCheckRuleActiveForScope(rule, scopeCategory, changedFiles)
        ? 'active'
        : 'skipped_by_scope';
}

export function buildQualityChecklistEffectivePolicyEntries(
    rules: readonly OptionalQualityCheckRule[],
    scopeCategory: string | null,
    changedFiles: readonly unknown[] = []
): QualityChecklistEffectivePolicyEntry[] {
    return rules
        .map((rule) => {
            const id = normalizeRuleId(rule.id);
            return {
                id,
                source: isBaselineOptionalQualityCheckRuleId(id) ? 'baseline' as const : 'custom' as const,
                enabled: rule.enabled !== false,
                included_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories),
                included_changed_file_regexes: normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes),
                excluded_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories),
                scope_applicability: scopeApplicabilityForRule(rule, scopeCategory, changedFiles),
                title: normalizeText(rule.title),
                prompt: normalizeText(rule.prompt)
            };
        })
        .filter((rule) => rule.id)
        .sort((left, right) => left.id.localeCompare(right.id));
}

export function buildQualityChecklistEffectivePolicyEntriesFromArtifact(
    value: unknown
): QualityChecklistEffectivePolicyEntry[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .filter(isRecord)
        .map((rule) => {
            const id = normalizeRuleId(rule.id);
            const enabled = rule.enabled !== false;
            const rawApplicability = normalizeText(rule.scope_applicability);
            const scopeApplicability: QualityChecklistEffectivePolicyEntry['scope_applicability'] =
                rawApplicability === 'disabled' || rawApplicability === 'skipped_by_scope'
                    ? rawApplicability
                    : enabled ? 'active' : 'disabled';
            return {
                id,
                source: isBaselineOptionalQualityCheckRuleId(id) ? 'baseline' as const : 'custom' as const,
                enabled,
                included_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.included_scope_categories),
                included_changed_file_regexes: normalizeOptionalQualityCheckChangedFileRegexes(rule.included_changed_file_regexes),
                excluded_scope_categories: normalizeOptionalQualityCheckScopeCategories(rule.excluded_scope_categories),
                scope_applicability: scopeApplicability,
                title: normalizeText(rule.title),
                prompt: normalizeText(rule.prompt)
            };
        })
        .filter((rule) => rule.id)
        .sort((left, right) => left.id.localeCompare(right.id));
}

function fingerprintEntry(entry: QualityChecklistEffectivePolicyEntry): Record<string, unknown> {
    const base = {
        id: entry.id,
        source: entry.source,
        enabled: entry.enabled,
        included_scope_categories: entry.included_scope_categories,
        included_changed_file_regexes: entry.included_changed_file_regexes,
        excluded_scope_categories: entry.excluded_scope_categories,
        scope_applicability: entry.scope_applicability
    };
    if (entry.source === 'baseline') {
        return base;
    }
    return {
        ...base,
        title: entry.title,
        prompt: entry.prompt
    };
}

export function computeQualityChecklistEffectivePolicySha256(
    rules: readonly OptionalQualityCheckRule[],
    scopeCategory: string | null,
    changedFiles: readonly unknown[] = []
): string {
    const entries = buildQualityChecklistEffectivePolicyEntries(rules, scopeCategory, changedFiles).map(fingerprintEntry);
    return sha256Json({
        schema_version: 1,
        baseline_rule_ids: DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => rule.id).sort(),
        rules: entries
    });
}

function entriesById(entries: readonly QualityChecklistEffectivePolicyEntry[]): Map<string, QualityChecklistEffectivePolicyEntry> {
    return new Map(entries.map((entry) => [entry.id, entry]));
}

function answersRuleIds(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return uniqueSorted(
        value
            .filter(isRecord)
            .map((answer) => normalizeRuleId(answer.rule_id))
            .filter(Boolean)
    );
}

function answersRuleIdCounts(value: unknown): Map<string, number> {
    const counts = new Map<string, number>();
    if (!Array.isArray(value)) {
        return counts;
    }
    for (const answer of value.filter(isRecord)) {
        const ruleId = normalizeRuleId(answer.rule_id);
        if (!ruleId) {
            continue;
        }
        counts.set(ruleId, (counts.get(ruleId) || 0) + 1);
    }
    return counts;
}

function customRuleCompatible(
    current: QualityChecklistEffectivePolicyEntry,
    artifact: QualityChecklistEffectivePolicyEntry
): boolean {
    return current.enabled === artifact.enabled
        && current.scope_applicability === artifact.scope_applicability
        && current.title === artifact.title
        && current.prompt === artifact.prompt
        && current.included_scope_categories.length === artifact.included_scope_categories.length
        && current.included_scope_categories.every((scope, index) => scope === artifact.included_scope_categories[index])
        && current.included_changed_file_regexes.length === artifact.included_changed_file_regexes.length
        && current.included_changed_file_regexes.every((pattern, index) => pattern === artifact.included_changed_file_regexes[index])
        && current.excluded_scope_categories.length === artifact.excluded_scope_categories.length
        && current.excluded_scope_categories.every((scope, index) => scope === artifact.excluded_scope_categories[index]);
}

export function assessQualityChecklistPolicyCompatibility(options: {
    currentRules: readonly OptionalQualityCheckRule[];
    artifactRules: unknown;
    artifactAnswers: unknown;
    scopeCategory: string | null;
    changedFiles?: readonly unknown[];
    currentRuleSetDiagnostic?: string | null;
}): QualityChecklistPolicyCompatibility {
    const currentEntries = buildQualityChecklistEffectivePolicyEntries(
        options.currentRules,
        options.scopeCategory,
        options.changedFiles || []
    );
    const artifactEntries = buildQualityChecklistEffectivePolicyEntriesFromArtifact(options.artifactRules);
    const currentById = entriesById(currentEntries);
    const artifactById = entriesById(artifactEntries);
    const reasons: string[] = [];
    const currentPolicySha256 = computeQualityChecklistEffectivePolicySha256(
        options.currentRules,
        options.scopeCategory,
        options.changedFiles || []
    );

    if (options.currentRuleSetDiagnostic) {
        reasons.push(options.currentRuleSetDiagnostic);
    }
    if (artifactEntries.length === 0) {
        reasons.push('Quality checklist artifact has no rule policy snapshot.');
    }

    const answeredRuleCounts = answersRuleIdCounts(options.artifactAnswers);
    const answeredRuleIds = new Set(answersRuleIds(options.artifactAnswers));

    for (const [ruleId, count] of answeredRuleCounts.entries()) {
        if (count > 1) {
            reasons.push(`Quality checklist answer references rule '${ruleId}' more than once.`);
        }
    }

    for (const ruleId of answeredRuleIds) {
        const current = currentById.get(ruleId);
        if (!current) {
            reasons.push(`Quality checklist answer references rule '${ruleId}' missing from the current workflow config.`);
            continue;
        }
        if (current.scope_applicability !== 'active') {
            reasons.push(
                `Quality checklist answer references rule '${ruleId}' that is currently ${current.scope_applicability}.`
            );
        }
        const artifact = artifactById.get(ruleId);
        if (current.source === 'custom' && artifact && !customRuleCompatible(current, artifact)) {
            reasons.push(`Custom quality-check rule '${ruleId}' changed after the quality checklist was recorded.`);
        }
    }

    for (const current of currentEntries) {
        if (current.scope_applicability !== 'active') {
            continue;
        }
        const artifact = artifactById.get(current.id);
        if (!answeredRuleIds.has(current.id)) {
            reasons.push(`Active quality-check rule '${current.id}' is missing from the recorded checklist answers.`);
        }
        if (!artifact) {
            reasons.push(`Active quality-check rule '${current.id}' is missing from the recorded checklist policy.`);
        } else if (current.source === 'custom' && !customRuleCompatible(current, artifact)) {
            reasons.push(`Active custom quality-check rule '${current.id}' changed after the quality checklist was recorded.`);
        }
    }

    return {
        compatible: reasons.length === 0,
        reasons,
        effective_policy_sha256: currentPolicySha256
    };
}
