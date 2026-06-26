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

export const OPTIONAL_QUALITY_CHECKS_ENABLED_NOTICE = 'режим опциональных проверок включен, проверь в garda ui перед стартом';
export const OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION = '2026-06-26.t843';

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
    ...LEGACY_OPTIONAL_QUALITY_CHECK_RULES,
    Object.freeze({
        id: 'classifier_intent_edge_cases',
        title: 'Classifier intent edge cases',
        prompt: 'Check classifier keyword or regex changes against acceptance wording, hyphen and space variants, standalone forms, and protocol or numeric suffixes such as OAuth2.',
        enabled: true
    }),
    Object.freeze({
        id: 'config_materialization_parity',
        title: 'Config materialization parity',
        prompt: 'Check config, default, template, materialization, schema, install, and update changes for parity while preserving explicit local user choices.',
        enabled: true
    }),
    Object.freeze({
        id: 'control_plane_action_safety',
        title: 'Control-plane action safety',
        prompt: 'Check UI, CLI, or other control-plane mutations use audited and validated action paths with confirmation, boundary checks, compact success output, and preserved failure diagnostics.',
        enabled: true
    }),
    Object.freeze({
        id: 'artifact_evidence_binding',
        title: 'Artifact evidence binding',
        prompt: 'Check artifact, history, cache, or telemetry evidence validates identity, freshness, scope or worktree binding, path ownership, and stale or forged negative cases before trust.',
        enabled: true
    }),
    Object.freeze({
        id: 'gate_routing_self_regression',
        title: 'Gate routing self-regression',
        prompt: 'Check gate, guard, or routing changes with self-regression fixtures where blocking states preempt expensive work, pass states continue, and warning-only states do not block.',
        enabled: true
    })
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
    'zero_diff_noop_preemption'
]);

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
    staleBaselineVersion: boolean
): OptionalQualityCheckRule[] {
    const baselineRuleById = new Map(baselineRules.map((rule) => [rule.id, rule]));
    const mergedRuleIds = new Set<string>();
    const mergedRules: OptionalQualityCheckRule[] = [];

    for (const existingRule of existingRules) {
        if (staleBaselineVersion && DEPRECATED_OPTIONAL_QUALITY_CHECK_BASELINE_RULE_IDS.has(existingRule.id)) {
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
    existingInput: unknown
): OptionalQualityChecksConfig {
    const templateConfig = normalizeOptionalQualityChecksConfig(templateInput);
    if (!isPlainObject(existingInput)) {
        return cloneJsonValue(templateConfig);
    }

    const existingConfig = cloneJsonValue(existingInput);
    const existingRules = normalizeOptionalQualityCheckRules(existingConfig.rules);
    const baselineRules = cloneJsonValue(templateConfig.rules);
    const staleBaselineVersion = getOptionalQualityChecksBaselineVersion(existingConfig) !== templateConfig.baseline_version;
    const mergedRules = mergeOptionalQualityCheckRulesWithBaseline(
        existingRules,
        baselineRules,
        staleBaselineVersion
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
