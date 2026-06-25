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
export const OPTIONAL_QUALITY_CHECKS_BASELINE_VERSION = '2026-06-25.t839';

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
        id: 'preflight_review_scope_regressions',
        title: 'Preflight and review scope regressions',
        prompt: 'Check whether regression tests added for runtime changes are included in the current preflight and review scope together with the implementation files.',
        enabled: true
    }),
    Object.freeze({
        id: 'classifier_intent_edge_cases',
        title: 'Classifier intent edge cases',
        prompt: 'Check classifier keyword or regex changes against acceptance wording, hyphen and space variants, standalone forms, and protocol or numeric suffixes such as OAuth2.',
        enabled: true
    }),
    Object.freeze({
        id: 'trust_artifact_identity',
        title: 'Trust artifact identity',
        prompt: 'Check new trust-bearing artifact or telemetry identity fields for stable-selection persistence, stale or forged value rejection, and legacy fallback behavior.',
        enabled: true
    }),
    Object.freeze({
        id: 'doc_impact_closeout_parity',
        title: 'Doc impact closeout parity',
        prompt: 'Check that next-step commands, direct gate validation, and CLI tests stay aligned for behaviorChanged internal evidence, docs-only evidence, and project-memory parity.',
        enabled: true
    }),
    Object.freeze({
        id: 'task_queue_parser_state',
        title: 'Task queue parser state',
        prompt: 'Check task queue parser and status-sync changes against comma-separated child ids, range notation, missing child rows, mixed statuses, and reentrant global RegExp state.',
        enabled: true
    }),
    Object.freeze({
        id: 'review_cycle_scope_freshness',
        title: 'Review cycle scope freshness',
        prompt: 'Check review-cycle or split guard changes so pending launch telemetry is not counted as a completed cycle, stale scope hashes are ignored, and helper growth is extracted before review.',
        enabled: true
    }),
    Object.freeze({
        id: 'zero_diff_noop_preemption',
        title: 'Zero-diff no-op preemption',
        prompt: 'Check zero-diff or no-op routing so missing, stale, or foreign no-op evidence preempts full-suite, review-context, and reviewer-launch routing after compile.',
        enabled: true
    })
]);

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
    return {
        ...cloneJsonValue(input),
        id,
        title,
        prompt,
        enabled: input.enabled === undefined ? true : input.enabled === true
    };
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
    const normalizedRules = Array.isArray(input.rules)
        ? input.rules
            .map((rule) => normalizeOptionalQualityCheckRule(rule))
            .filter((rule): rule is OptionalQualityCheckRule => rule !== null)
        : cloneJsonValue(defaultConfig.rules);
    return {
        ...cloneJsonValue(input),
        enabled: input.enabled === undefined
            ? defaultConfig.enabled
            : input.enabled === true,
        baseline_version: typeof input.baseline_version === 'string' && input.baseline_version.trim()
            ? input.baseline_version.trim()
            : defaultConfig.baseline_version,
        rules: normalizedRules.length > 0
            ? normalizedRules
            : cloneJsonValue(defaultConfig.rules)
    };
}
