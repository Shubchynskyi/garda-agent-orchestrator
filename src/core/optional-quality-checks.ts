import { cloneJsonValue, isPlainObject } from './config-merge';

export interface OptionalQualityCheckRule {
    id: string;
    title: string;
    prompt: string;
    enabled: boolean;
    [key: string]: unknown;
}

export interface OptionalQualityChecksConfig {
    enabled: boolean;
    baseline_version: string;
    rules: OptionalQualityCheckRule[];
    [key: string]: unknown;
}

export interface OptionalQualityChecksMergeOptions {
    preserveMovedProjectRulesAsCustom?: boolean;
}

export const OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE = 'режим опциональных проверок включен, проверь в garda ui перед стартом';
export const OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION = '2026-06-27.t846';

export const LEGACY_OPTIONAL_QUALITY_CHECK_RULES: readonly OptionalQualityCheckRule[] = Object.freeze([
    Object.freeze({
        id: 'code_simplification',
        title: 'Code simplification',
        prompt: 'Check whether the changed code can be simplified without weakening behavior, validation, or diagnostics.',
        enabled: true
    }),
    Object.freeze({
        id: 'project_style_fit',
        title: 'Project style fit',
        prompt: 'Check whether the change follows the local project style, naming, module boundaries, and existing helper patterns.',
        enabled: true
    }),
    Object.freeze({
        id: 'unnecessary_abstraction',
        title: 'Unnecessary abstraction',
        prompt: 'Check whether the change introduced abstractions that do not remove real duplication, risk, or complexity.',
        enabled: true
    }),
    Object.freeze({
        id: 'size_growth',
        title: 'Class/function/file growth',
        prompt: 'Check whether touched classes, functions, or files grew enough to need local extraction or clearer ownership.',
        enabled: true
    }),
    Object.freeze({
        id: 'hardcoded_values_contracts',
        title: 'Hardcoded values and contracts',
        prompt: 'Check whether new literals, paths, statuses, or messages should be named constants, schema fields, or shared contracts.',
        enabled: true
    }),
    Object.freeze({
        id: 'duplicated_logic_contracts',
        title: 'Duplicated logic and contracts',
        prompt: 'Check whether the change duplicates logic, validation, or contract strings that should stay defined in one place.',
        enabled: true
    }),
    Object.freeze({
        id: 'test_verification_scope',
        title: 'Test and verification scope',
        prompt: 'Check whether the focused tests and mandatory gates cover the behavioral risk without adding unrelated slow coverage.',
        enabled: true
    })
]);

export const DEFAULT_OPTIONAL_QUALITY_CHECK_RULES: readonly OptionalQualityCheckRule[] = Object.freeze([
    ...LEGACY_OPTIONAL_QUALITY_CHECK_RULES
]);

const DEFAULT_OPTIONAL_QUALITY_CHECK_RULE_BY_ID = new Map(
    DEFAULT_OPTIONAL_QUALITY_CHECK_RULES.map((rule) => [rule.id, rule])
);

const DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS = new Set([
    'preflight_review_scope_regressions',
    'trust_artifact_identity',
    'doc_impact_closeout_parity',
    'task_queue_parser_state',
    'review_cycle_scope_freshness',
    'zero_diff_noop_preemption',
    'classifier_intent_edge_cases',
    'config_materialization_parity',
    'control_plane_action_safety',
    'artifact_evidence_binding',
    'gate_routing_self_regression'
]);

const MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES: readonly Readonly<{
    movedRuleId: string;
    customRule: OptionalQualityCheckRule;
}>[] = Object.freeze([
    Object.freeze({
        movedRuleId: 'classifier_intent_edge_cases',
        customRule: Object.freeze({
            id: 'custom_garda_classifier_intent_edge_cases',
            title: 'Garda classifier intent edge cases',
            prompt: 'For Garda classifier keyword or regex changes, check acceptance wording, hyphen and space variants, standalone forms, and protocol or numeric suffixes such as OAuth2.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'config_materialization_parity',
        customRule: Object.freeze({
            id: 'custom_garda_config_materialization_parity',
            title: 'Garda config materialization parity',
            prompt: 'For Garda config, default, template, materialization, schema, install, and update changes, check parity while preserving explicit local user choices.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'control_plane_action_safety',
        customRule: Object.freeze({
            id: 'custom_garda_control_plane_action_safety',
            title: 'Garda control-plane action safety',
            prompt: 'For Garda UI, CLI, or control-plane mutations, check audited and validated action paths with confirmation, boundary checks, compact success output, and preserved failure diagnostics.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'artifact_evidence_binding',
        customRule: Object.freeze({
            id: 'custom_garda_artifact_evidence_binding',
            title: 'Garda artifact evidence binding',
            prompt: 'For Garda artifact, history, cache, or telemetry evidence, check identity, freshness, scope or worktree binding, path ownership, and stale or forged negative cases before trust.',
            enabled: true
        })
    }),
    Object.freeze({
        movedRuleId: 'gate_routing_self_regression',
        customRule: Object.freeze({
            id: 'custom_garda_gate_routing_self_regression',
            title: 'Garda gate routing self-regression',
            prompt: 'For Garda gate, guard, or routing changes, check self-regression fixtures where blocking states preempt expensive work, pass states continue, and warning-only states do not block.',
            enabled: true
        })
    })
]);

const MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULE_BY_OLD_ID = new Map(
    MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES.map((entry) => [entry.movedRuleId, entry.customRule])
);

function appendMissingMovedProjectCustomRules(
    mergedRules: OptionalQualityCheckRule[],
    mergedRuleIds: Set<string>
): void {
    for (const { customRule } of MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULES) {
        if (mergedRuleIds.has(customRule.id)) {
            continue;
        }
        mergedRules.push(cloneJsonValue(customRule) as OptionalQualityCheckRule);
        mergedRuleIds.add(customRule.id);
    }
}

function getOptionalQualityCheckBaselineRuleById(ruleId: string): OptionalQualityCheckRule | null {
    return DEFAULT_OPTIONAL_QUALITY_CHECK_RULE_BY_ID.get(ruleId.trim().toLowerCase()) || null;
}

export function isBaselineOptionalQualityCheckRuleId(ruleId: string): boolean {
    return getOptionalQualityCheckBaselineRuleById(ruleId) !== null;
}

export function getBaselineOptionalQualityCheckRule(ruleId: string): OptionalQualityCheckRule | null {
    const baselineRule = getOptionalQualityCheckBaselineRuleById(ruleId);
    return baselineRule ? cloneJsonValue(baselineRule) as OptionalQualityCheckRule : null;
}

export function buildDefaultOptionalQualityChecksConfig(): OptionalQualityChecksConfig {
    return {
        enabled: true,
        baseline_version: OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION,
        rules: cloneJsonValue(DEFAULT_OPTIONAL_QUALITY_CHECK_RULES) as OptionalQualityCheckRule[]
    };
}

function normalizeOptionalQualityCheckRule(input: unknown): OptionalQualityCheckRule | null {
    if (!isPlainObject(input)) {
        return null;
    }
    const id = typeof input.id === 'string' ? input.id.trim().toLowerCase() : '';
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    if (!id || !title || !prompt) {
        return null;
    }
    const baselineRule = getOptionalQualityCheckBaselineRuleById(id);
    if (baselineRule) {
        return {
            ...cloneJsonValue(baselineRule),
            enabled: input.enabled === undefined ? baselineRule.enabled : input.enabled === true
        };
    }
    return {
        ...cloneJsonValue(input),
        id,
        title,
        prompt,
        enabled: input.enabled === undefined ? true : input.enabled === true
    };
}

function normalizeOptionalQualityCheckRules(input: unknown): OptionalQualityCheckRule[] {
    if (!Array.isArray(input)) {
        return [];
    }
    return input
        .map((rule) => normalizeOptionalQualityCheckRule(rule))
        .filter((rule): rule is OptionalQualityCheckRule => rule !== null);
}

function mergeOptionalQualityCheckRulesWithBaseline(
    existingRules: readonly OptionalQualityCheckRule[],
    baselineRules: readonly OptionalQualityCheckRule[],
    staleBaselineVersion: boolean,
    options: OptionalQualityChecksMergeOptions = {}
): OptionalQualityCheckRule[] {
    const baselineRuleById = new Map(baselineRules.map((rule) => [rule.id, rule]));
    const existingRuleIds = new Set(existingRules.map((rule) => rule.id));
    const mergedRuleIds = new Set<string>();
    const mergedRules: OptionalQualityCheckRule[] = [];

    for (const existingRule of existingRules) {
        if (staleBaselineVersion && DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS.has(existingRule.id)) {
            const movedCustomRule = options.preserveMovedProjectRulesAsCustom
                ? MOVED_GARDA_OPTIONAL_QUALITY_CHECK_CUSTOM_RULE_BY_OLD_ID.get(existingRule.id)
                : null;
            if (movedCustomRule && !existingRuleIds.has(movedCustomRule.id) && !mergedRuleIds.has(movedCustomRule.id)) {
                mergedRules.push({
                    ...cloneJsonValue(movedCustomRule),
                    enabled: existingRule.enabled !== false
                });
                mergedRuleIds.add(movedCustomRule.id);
            }
            continue;
        }
        const baselineRule = baselineRuleById.get(existingRule.id);
        if (baselineRule) {
            if (!mergedRuleIds.has(existingRule.id)) {
                const canonicalRule = cloneJsonValue(baselineRule) as OptionalQualityCheckRule;
                mergedRules.push({
                    ...canonicalRule,
                    enabled: existingRule.enabled !== false
                });
                mergedRuleIds.add(existingRule.id);
            }
            continue;
        }
        if (!mergedRuleIds.has(existingRule.id)) {
            mergedRules.push(cloneJsonValue(existingRule) as OptionalQualityCheckRule);
            mergedRuleIds.add(existingRule.id);
        }
    }

    for (const baselineRule of baselineRules) {
        if (!mergedRuleIds.has(baselineRule.id)) {
            mergedRules.push(cloneJsonValue(baselineRule) as OptionalQualityCheckRule);
            mergedRuleIds.add(baselineRule.id);
        }
    }

    if (options.preserveMovedProjectRulesAsCustom) {
        appendMissingMovedProjectCustomRules(mergedRules, mergedRuleIds);
    }

    return mergedRules;
}

function isExactOptionalQualityCheckRule(rule: unknown, expected: OptionalQualityCheckRule): boolean {
    const normalized = normalizeOptionalQualityCheckRule(rule);
    return normalized !== null
        && normalized.id === expected.id
        && normalized.title === expected.title
        && normalized.prompt === expected.prompt
        && normalized.enabled === expected.enabled
        && Object.keys(normalized).sort().join('\n') === Object.keys(expected).sort().join('\n');
}

function getOptionalQualityChecksBaselineVersion(input: Record<string, unknown>): string {
    return typeof input.baseline_version === 'string'
        ? input.baseline_version.trim()
        : '';
}

export function isExactLegacyOptionalQualityChecksGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }
    if (typeof input.baseline_version === 'string' && input.baseline_version.trim()) {
        return false;
    }
    const rules = input.rules;
    if (!Array.isArray(rules) || rules.length !== LEGACY_OPTIONAL_QUALITY_CHECK_RULES.length) {
        return false;
    }
    return LEGACY_OPTIONAL_QUALITY_CHECK_RULES.every((expected, index) => (
        isExactOptionalQualityCheckRule(rules[index], expected)
    ));
}

export function normalizeOptionalQualityChecksConfig(input: unknown): OptionalQualityChecksConfig {
    const defaultConfig = buildDefaultOptionalQualityChecksConfig();
    if (!isPlainObject(input)) {
        return defaultConfig;
    }
    const rawBaselineVersion = getOptionalQualityChecksBaselineVersion(input);
    const baselineVersion = rawBaselineVersion || defaultConfig.baseline_version;
    const baselineRules = cloneJsonValue(defaultConfig.rules) as OptionalQualityCheckRule[];
    const normalizedRules = Array.isArray(input.rules)
        ? mergeOptionalQualityCheckRulesWithBaseline(
            normalizeOptionalQualityCheckRules(input.rules),
            baselineRules,
            rawBaselineVersion !== defaultConfig.baseline_version
        )
        : baselineRules;
    return {
        ...cloneJsonValue(input),
        enabled: input.enabled === undefined
            ? defaultConfig.enabled
            : input.enabled === true,
        baseline_version: baselineVersion,
        rules: normalizedRules.length > 0
            ? normalizedRules
            : cloneJsonValue(defaultConfig.rules)
    };
}

export function mergeOptionalQualityChecksWithBaseline(
    templateInput: unknown,
    existingInput: unknown,
    options: OptionalQualityChecksMergeOptions = {}
): OptionalQualityChecksConfig {
    const templateConfig = normalizeOptionalQualityChecksConfig(templateInput);
    if (!isPlainObject(existingInput)) {
        const templateClone = cloneJsonValue(templateConfig);
        const mergedRules = mergeOptionalQualityCheckRulesWithBaseline(
            [],
            templateClone.rules,
            false,
            options
        );
        return {
            ...templateClone,
            rules: mergedRules
        };
    }

    const existingConfig = cloneJsonValue(existingInput);
    const existingRules = normalizeOptionalQualityCheckRules(existingConfig.rules);
    const baselineRules = cloneJsonValue(templateConfig.rules);
    const staleBaselineVersion = getOptionalQualityChecksBaselineVersion(existingConfig) !== templateConfig.baseline_version;
    const mergedRules = mergeOptionalQualityCheckRulesWithBaseline(
        existingRules,
        baselineRules,
        staleBaselineVersion,
        options
    );

    return {
        ...cloneJsonValue(templateConfig),
        ...existingConfig,
        enabled: existingConfig.enabled === undefined
            ? templateConfig.enabled
            : existingConfig.enabled === true,
        baseline_version: templateConfig.baseline_version,
        rules: mergedRules.length > 0
            ? mergedRules
            : baselineRules
    };
}
