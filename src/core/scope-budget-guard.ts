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
}

export interface ScopeBudgetGuardEvaluation {
    active: boolean;
    action: ScopeBudgetGuardAction;
    profile_name: string | null;
    violations: ScopeBudgetGuardViolation[];
    should_block: boolean;
    summary_line: string;
}

export const DEFAULT_SCOPE_BUDGET_GUARD_CONFIG: ScopeBudgetGuardConfig = Object.freeze({
    enabled: true,
    profiles: ['strict'],
    action: 'BLOCK_FOR_SPLIT',
    max_files: 12,
    max_changed_lines: 1200,
    max_required_reviews: 5,
    max_review_tokens: 50000
});

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

export function normalizeScopeBudgetGuardConfig(input: unknown): ScopeBudgetGuardConfig {
    const raw = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    return {
        enabled: typeof raw.enabled === 'boolean'
            ? raw.enabled
            : DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.enabled,
        profiles: normalizeProfiles(raw.profiles, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.profiles),
        action: normalizeAction(raw.action, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.action),
        max_files: normalizePositiveInteger(raw.max_files, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.max_files),
        max_changed_lines: normalizePositiveInteger(raw.max_changed_lines, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.max_changed_lines),
        max_required_reviews: normalizePositiveInteger(raw.max_required_reviews, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.max_required_reviews),
        max_review_tokens: normalizePositiveInteger(raw.max_review_tokens, DEFAULT_SCOPE_BUDGET_GUARD_CONFIG.max_review_tokens)
    };
}

export function evaluateScopeBudgetGuard(
    config: ScopeBudgetGuardConfig,
    input: ScopeBudgetGuardEvaluationInput
): ScopeBudgetGuardEvaluation {
    const profileName = input.profileName ? input.profileName.trim().toLowerCase() : null;
    const profileMatches = Boolean(profileName && config.profiles.includes(profileName));
    const active = config.enabled && profileMatches;
    const violations: ScopeBudgetGuardViolation[] = [];

    if (active && input.changedFilesCount > config.max_files) {
        violations.push({ metric: 'changed_files_count', actual: input.changedFilesCount, limit: config.max_files });
    }
    if (active && input.changedLinesTotal > config.max_changed_lines) {
        violations.push({ metric: 'changed_lines_total', actual: input.changedLinesTotal, limit: config.max_changed_lines });
    }
    if (active && input.requiredReviewCount > config.max_required_reviews) {
        violations.push({ metric: 'required_review_count', actual: input.requiredReviewCount, limit: config.max_required_reviews });
    }
    if (active && input.totalEstimatedReviewTokens > config.max_review_tokens) {
        violations.push({
            metric: 'total_estimated_review_tokens',
            actual: input.totalEstimatedReviewTokens,
            limit: config.max_review_tokens
        });
    }

    const violationText = violations
        .map((violation) => `${violation.metric}=${violation.actual}>${violation.limit}`)
        .join(', ');
    return {
        active,
        action: config.action,
        profile_name: profileName,
        violations,
        should_block: active && config.action === 'BLOCK_FOR_SPLIT' && violations.length > 0,
        summary_line: active
            ? violations.length > 0
                ? `Scope budget guard: ${config.action} (${violationText})`
                : 'Scope budget guard: within configured limits'
            : 'Scope budget guard: inactive for current profile'
    };
}
