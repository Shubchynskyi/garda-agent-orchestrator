export const SCOPE_BUDGET_GUARD_ACTIONS = ['BLOCK_FOR_SPLIT', 'WARN_ONLY'] as const;

export type ScopeBudgetGuardAction = typeof SCOPE_BUDGET_GUARD_ACTIONS[number];

export interface ScopeBudgetGuardConfig {
    enabled: boolean;
    profiles: string[];
    action: ScopeBudgetGuardAction;
    max_files: number;
    max_changed_lines: number;
    max_required_reviews: number;
    max_review_tokens: number;
    warn_files: number;
    block_files: number;
    warn_changed_lines: number;
    block_changed_lines: number;
    warn_required_reviews: number;
    block_required_reviews: number;
    warn_review_tokens: number;
    block_review_tokens: number;
}

export interface ScopeBudgetGuardEvaluationInput {
    profileName: string | null;
    changedFilesCount: number;
    changedLinesTotal: number;
    requiredReviewCount: number;
    totalEstimatedReviewTokens: number;
}

export interface ScopeBudgetGuardViolation {
    metric: 'changed_files_count' | 'changed_lines_total' | 'required_review_count' | 'total_estimated_review_tokens';
    actual: number;
    limit: number;
    warning_limit: number;
    blocking_limit: number;
    severity: 'WARN' | 'BLOCK';
}

export interface ScopeBudgetGuardEvaluation {
    active: boolean;
    action: ScopeBudgetGuardAction;
    status: 'INACTIVE' | 'OK' | 'WARN' | 'BLOCK';
    profile_name: string | null;
    violations: ScopeBudgetGuardViolation[];
    should_warn: boolean;
    should_block: boolean;
    continuation_allowed: boolean;
    summary_line: string;
}

export const DEFAULT_SCOPE_BUDGET_GUARD_CONFIG: ScopeBudgetGuardConfig = Object.freeze({
    enabled: true,
    profiles: ['strict'],
    action: 'WARN_ONLY',
    max_files: 20,
    max_changed_lines: 2000,
    max_required_reviews: 5,
    max_review_tokens: 50000,
    warn_files: 20,
    block_files: 50,
    warn_changed_lines: 2000,
    block_changed_lines: 5000,
    warn_required_reviews: 5,
    block_required_reviews: 8,
    warn_review_tokens: 50000,
    block_review_tokens: 100000
});

const SCOPE_BUDGET_METRICS = Object.freeze([
    {
        metric: 'changed_files_count',
        legacyKey: 'max_files',
        warningKey: 'warn_files',
        blockingKey: 'block_files'
    },
    {
        metric: 'changed_lines_total',
        legacyKey: 'max_changed_lines',
        warningKey: 'warn_changed_lines',
        blockingKey: 'block_changed_lines'
    },
    {
        metric: 'required_review_count',
        legacyKey: 'max_required_reviews',
        warningKey: 'warn_required_reviews',
        blockingKey: 'block_required_reviews'
    },
    {
        metric: 'total_estimated_review_tokens',
        legacyKey: 'max_review_tokens',
        warningKey: 'warn_review_tokens',
        blockingKey: 'block_review_tokens'
    }
] as const);

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function parseScopeBudgetNumber(value: unknown): number | null {
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (!trimmed) {
            return null;
        }
        const parsed = Number(trimmed);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

export function readScopeBudgetEffectivePreflightMetric(
    preflight: Record<string, unknown> | null,
    field: 'changed_files_count' | 'changed_lines_total'
): number | null {
    const triggers = isRecord(preflight?.triggers) ? preflight.triggers : {};
    if (triggers.ui_i18n_companion_scope !== true && triggers.ui_i18n_review_trigger_suppressed !== true) {
        return null;
    }
    const metrics = isRecord(preflight?.metrics) ? preflight.metrics : {};
    const effectiveField = field === 'changed_files_count'
        ? 'review_trigger_effective_changed_files_count'
        : 'review_trigger_effective_changed_lines_total';
    const legacyEffectiveField = field === 'changed_files_count'
        ? 'companion_scope_effective_changed_files_count'
        : 'companion_scope_effective_changed_lines_total';
    return parseScopeBudgetNumber(metrics[effectiveField])
        ?? parseScopeBudgetNumber(metrics[legacyEffectiveField]);
}

export function readScopeBudgetChangedFilesCount(preflight: Record<string, unknown> | null): number {
    const metrics = isRecord(preflight?.metrics) ? preflight.metrics : {};
    const changedFiles = Array.isArray(preflight?.changed_files) ? preflight.changed_files : [];
    return readScopeBudgetEffectivePreflightMetric(preflight, 'changed_files_count')
        ?? parseScopeBudgetNumber(metrics.changed_files_count)
        ?? changedFiles.length;
}

export function readScopeBudgetChangedLinesTotal(preflight: Record<string, unknown> | null): number {
    const metrics = isRecord(preflight?.metrics) ? preflight.metrics : {};
    const budgetForecast = isRecord(preflight?.budget_forecast) ? preflight.budget_forecast : {};
    return readScopeBudgetEffectivePreflightMetric(preflight, 'changed_lines_total')
        ?? parseScopeBudgetNumber(metrics.changed_lines_total)
        ?? parseScopeBudgetNumber(budgetForecast.changed_lines_total)
        ?? 0;
}

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : fallback;
}

function normalizeProfiles(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const normalized = [...new Set(value
        .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
        .filter(Boolean))];
    return normalized.length > 0 ? normalized : [...fallback];
}

function normalizeAction(value: unknown, fallback: ScopeBudgetGuardAction): ScopeBudgetGuardAction {
    const normalized = typeof value === 'string'
        ? value.trim().toUpperCase().replace(/[\s-]+/g, '_')
        : '';
    return (SCOPE_BUDGET_GUARD_ACTIONS as readonly string[]).includes(normalized)
        ? normalized as ScopeBudgetGuardAction
        : fallback;
}

function hasOwnKey(record: Record<string, unknown>, key: string): boolean {
    return Object.prototype.hasOwnProperty.call(record, key);
}

function deriveWarningThreshold(params: {
    raw: Record<string, unknown>;
    action: ScopeBudgetGuardAction;
    legacyKey: string;
    warningKey: string;
    blockingKey: string;
    defaultWarning: number;
    defaultBlocking: number;
}): number {
    if (hasOwnKey(params.raw, params.warningKey)) {
        return normalizePositiveInteger(params.raw[params.warningKey], params.defaultWarning);
    }
    const hasBlockingThreshold = hasOwnKey(params.raw, params.blockingKey);
    const hasLegacyThreshold = hasOwnKey(params.raw, params.legacyKey);
    if (hasBlockingThreshold && !hasLegacyThreshold) {
        const blockingLimit = normalizePositiveInteger(params.raw[params.blockingKey], params.defaultBlocking);
        return blockingLimit > 1
            ? Math.min(params.defaultWarning, blockingLimit - 1)
            : 0;
    }
    if (params.action === 'BLOCK_FOR_SPLIT') {
        if (!hasLegacyThreshold) {
            return params.defaultWarning;
        }
        const legacyBlockingLimit = normalizePositiveInteger(params.raw[params.legacyKey], params.defaultBlocking);
        return legacyBlockingLimit > 1
            ? Math.min(params.defaultWarning, legacyBlockingLimit - 1)
            : 0;
    }
    return normalizePositiveInteger(params.raw[params.legacyKey], params.defaultWarning);
}

function deriveBlockingThreshold(params: {
    raw: Record<string, unknown>;
    action: ScopeBudgetGuardAction;
    legacyKey: string;
    blockingKey: string;
    warningLimit: number;
    defaultBlocking: number;
}): number {
    if (hasOwnKey(params.raw, params.blockingKey)) {
        return normalizePositiveInteger(params.raw[params.blockingKey], params.defaultBlocking);
    }
    if (params.action === 'BLOCK_FOR_SPLIT') {
        return hasOwnKey(params.raw, params.legacyKey)
            ? normalizePositiveInteger(params.raw[params.legacyKey], params.defaultBlocking)
            : params.defaultBlocking;
    }
    const legacyLimit = normalizePositiveInteger(params.raw[params.legacyKey], params.warningLimit);
    return Math.max(params.defaultBlocking, legacyLimit + 1);
}

export function normalizeScopeBudgetGuardConfig(input: unknown): ScopeBudgetGuardConfig {
    const raw = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    const action = normalizeAction(raw.action, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.action);
    const thresholds = Object.fromEntries(SCOPE_BUDGET_METRICS.flatMap((entry) => {
        const defaultWarning = DEFAULT_SCOPE_BUDGET_GUARD_CONFIG[entry.warningKey];
        const defaultBlocking = DEFAULT_SCOPE_BUDGET_GUARD_CONFIG[entry.blockingKey];
        const warningLimit = deriveWarningThreshold({
            raw,
            action,
            legacyKey: entry.legacyKey,
            warningKey: entry.warningKey,
            blockingKey: entry.blockingKey,
            defaultWarning,
            defaultBlocking
        });
        const blockingLimit = deriveBlockingThreshold({
            raw,
            action,
            legacyKey: entry.legacyKey,
            blockingKey: entry.blockingKey,
            warningLimit,
            defaultBlocking
        });
        return [
            [entry.warningKey, warningLimit],
            [entry.blockingKey, blockingLimit]
        ];
    })) as Pick<
        ScopeBudgetGuardConfig,
        | 'warn_files'
        | 'block_files'
        | 'warn_changed_lines'
        | 'block_changed_lines'
        | 'warn_required_reviews'
        | 'block_required_reviews'
        | 'warn_review_tokens'
        | 'block_review_tokens'
    >;
    const legacyThresholdFallbacks = {
        max_files: action === 'BLOCK_FOR_SPLIT' ? thresholds.block_files : thresholds.warn_files,
        max_changed_lines: action === 'BLOCK_FOR_SPLIT' ? thresholds.block_changed_lines : thresholds.warn_changed_lines,
        max_required_reviews: action === 'BLOCK_FOR_SPLIT' ? thresholds.block_required_reviews : thresholds.warn_required_reviews,
        max_review_tokens: action === 'BLOCK_FOR_SPLIT' ? thresholds.block_review_tokens : thresholds.warn_review_tokens
    };
    return {
        enabled: typeof raw.enabled === 'boolean'
            ? raw.enabled
            : DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.enabled,
        profiles: normalizeProfiles(raw.profiles, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.profiles),
        action,
        max_files: normalizePositiveInteger(raw.max_files, legacyThresholdFallbacks.max_files),
        max_changed_lines: normalizePositiveInteger(raw.max_changed_lines, legacyThresholdFallbacks.max_changed_lines),
        max_required_reviews: normalizePositiveInteger(raw.max_required_reviews, legacyThresholdFallbacks.max_required_reviews),
        max_review_tokens: normalizePositiveInteger(raw.max_review_tokens, legacyThresholdFallbacks.max_review_tokens),
        ...thresholds
    };
}

function evaluateScopeBudgetMetric(
    metric: ScopeBudgetGuardViolation['metric'],
    actual: number,
    warningLimit: number,
    blockingLimit: number
): ScopeBudgetGuardViolation | null {
    if (actual > blockingLimit) {
        return {
            metric,
            actual,
            limit: blockingLimit,
            warning_limit: warningLimit,
            blocking_limit: blockingLimit,
            severity: 'BLOCK'
        };
    }
    if (actual > warningLimit) {
        return {
            metric,
            actual,
            limit: warningLimit,
            warning_limit: warningLimit,
            blocking_limit: blockingLimit,
            severity: 'WARN'
        };
    }
    return null;
}

export function evaluateScopeBudgetGuard(
    config: ScopeBudgetGuardConfig,
    input: ScopeBudgetGuardEvaluationInput
): ScopeBudgetGuardEvaluation {
    const profileName = input.profileName ? input.profileName.trim().toLowerCase() : null;
    const profileMatches = Boolean(profileName && config.profiles.includes(profileName));
    const active = config.enabled && profileMatches;
    const violations: ScopeBudgetGuardViolation[] = [];

    if (active) {
        const evaluated = [
            evaluateScopeBudgetMetric('changed_files_count', input.changedFilesCount, config.warn_files, config.block_files),
            evaluateScopeBudgetMetric('changed_lines_total', input.changedLinesTotal, config.warn_changed_lines, config.block_changed_lines),
            evaluateScopeBudgetMetric('required_review_count', input.requiredReviewCount, config.warn_required_reviews, config.block_required_reviews),
            evaluateScopeBudgetMetric('total_estimated_review_tokens', input.totalEstimatedReviewTokens, config.warn_review_tokens, config.block_review_tokens)
        ];
        for (const violation of evaluated) {
            if (violation) {
                violations.push(violation);
            }
        }
    }

    const shouldBlock = active && violations.some((violation) => violation.severity === 'BLOCK');
    const shouldWarn = active && !shouldBlock && violations.some((violation) => violation.severity === 'WARN');
    const status = !active
        ? 'INACTIVE'
        : shouldBlock
            ? 'BLOCK'
            : shouldWarn
                ? 'WARN'
                : 'OK';
    const violationText = violations
        .map((violation) => `${violation.metric}=${violation.actual}>${violation.limit} ${violation.severity}`)
        .join(', ');
    return {
        active,
        action: config.action,
        status,
        profile_name: profileName,
        violations,
        should_warn: shouldWarn,
        should_block: shouldBlock,
        continuation_allowed: !shouldBlock,
        summary_line: active
            ? violations.length > 0
                ? `Scope budget guard: ${status} (${violationText})`
                : 'Scope budget guard: within configured limits'
            : 'Scope budget guard: inactive for current profile'
    };
}
