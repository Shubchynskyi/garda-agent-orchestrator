export const REVIEW_CYCLE_GUARD_ACTIONS = ['BLOCK_FOR_OPERATOR_DECISION', 'WARN_ONLY'] as const;

export type ReviewCycleGuardAction = typeof REVIEW_CYCLE_GUARD_ACTIONS[number];

export interface ReviewCycleGuardConfig {
    enabled: boolean;
    action: ReviewCycleGuardAction;
    max_failed_non_test_reviews: number;
    max_total_non_test_reviews: number;
    excluded_review_types: string[];
}

export interface ReviewCycleAttempt {
    reviewType: string;
    failed: boolean;
    passed?: boolean;
}

export interface ReviewCycleGuardViolation {
    metric: 'failed_non_test_review_count' | 'total_non_test_review_count' | 'timeline_integrity';
    actual: number;
    limit: number;
}

export interface ReviewCycleGuardEvaluationInput {
    attempts: ReviewCycleAttempt[];
    timelineValid: boolean;
}

export interface ReviewCycleGuardEvaluation {
    active: boolean;
    action: ReviewCycleGuardAction;
    total_non_test_review_count: number;
    failed_non_test_review_count: number;
    counts_by_review_type: Record<string, { total: number; failed: number; passed: number; pending: number }>;
    excluded_review_types: string[];
    violations: ReviewCycleGuardViolation[];
    should_block: boolean;
    summary_line: string;
}

export const DEFAULT_REVIEW_CYCLE_GUARD_CONFIG: ReviewCycleGuardConfig = Object.freeze({
    enabled: true,
    action: 'BLOCK_FOR_OPERATOR_DECISION',
    max_failed_non_test_reviews: 15,
    max_total_non_test_reviews: 15,
    excluded_review_types: ['test']
});

function normalizePositiveInteger(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
        ? value
        : fallback;
}

function normalizeAction(value: unknown, fallback: ReviewCycleGuardAction): ReviewCycleGuardAction {
    const normalized = typeof value === 'string'
        ? value.trim().toUpperCase().replace(/[\s-]+/g, '_')
        : '';
    return REVIEW_CYCLE_GUARD_ACTIONS.includes(normalized as ReviewCycleGuardAction)
        ? normalized as ReviewCycleGuardAction
        : fallback;
}

function normalizeReviewTypeList(value: unknown, fallback: string[]): string[] {
    if (!Array.isArray(value)) {
        return [...fallback];
    }
    const normalized = [...new Set(value
        .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
        .filter(Boolean))];
    return normalized.length > 0 ? normalized : [...fallback];
}

export function normalizeReviewCycleGuardConfig(input: unknown): ReviewCycleGuardConfig {
    const raw = input && typeof input === 'object' && !Array.isArray(input)
        ? input as Record<string, unknown>
        : {};
    return {
        enabled: typeof raw.enabled === 'boolean'
            ? raw.enabled
            : DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.enabled,
        action: normalizeAction(raw.action, DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.action),
        max_failed_non_test_reviews: normalizePositiveInteger(
            raw.max_failed_non_test_reviews,
            DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.max_failed_non_test_reviews
        ),
        max_total_non_test_reviews: normalizePositiveInteger(
            raw.max_total_non_test_reviews,
            DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.max_total_non_test_reviews
        ),
        excluded_review_types: normalizeReviewTypeList(
            raw.excluded_review_types,
            DEFAULT_REVIEW_CYCLE_GUARD_CONFIG.excluded_review_types
        )
    };
}

export function evaluateReviewCycleGuard(
    config: ReviewCycleGuardConfig,
    input: ReviewCycleGuardEvaluationInput
): ReviewCycleGuardEvaluation {
    const excluded = new Set(config.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    const countsByReviewType: Record<string, { total: number; failed: number; passed: number; pending: number }> = {};
    let totalNonTestReviewCount = 0;
    let failedNonTestReviewCount = 0;

    for (const attempt of input.attempts) {
        const reviewType = attempt.reviewType.trim().toLowerCase();
        if (!reviewType || excluded.has(reviewType)) {
            continue;
        }
        countsByReviewType[reviewType] ??= { total: 0, failed: 0, passed: 0, pending: 0 };
        countsByReviewType[reviewType].total += 1;
        totalNonTestReviewCount += 1;
        if (attempt.failed) {
            countsByReviewType[reviewType].failed += 1;
            failedNonTestReviewCount += 1;
        } else if (attempt.passed) {
            countsByReviewType[reviewType].passed += 1;
        } else {
            countsByReviewType[reviewType].pending += 1;
        }
    }

    const active = config.enabled;
    const violations: ReviewCycleGuardViolation[] = [];
    if (active && !input.timelineValid) {
        violations.push({ metric: 'timeline_integrity', actual: 1, limit: 0 });
    }
    if (active && failedNonTestReviewCount > config.max_failed_non_test_reviews) {
        violations.push({
            metric: 'failed_non_test_review_count',
            actual: failedNonTestReviewCount,
            limit: config.max_failed_non_test_reviews
        });
    }
    if (active && totalNonTestReviewCount > config.max_total_non_test_reviews) {
        violations.push({
            metric: 'total_non_test_review_count',
            actual: totalNonTestReviewCount,
            limit: config.max_total_non_test_reviews
        });
    }

    const violationText = violations
        .map((violation) => `${violation.metric}=${violation.actual}>${violation.limit}`)
        .join(', ');

    return {
        active,
        action: config.action,
        total_non_test_review_count: totalNonTestReviewCount,
        failed_non_test_review_count: failedNonTestReviewCount,
        counts_by_review_type: countsByReviewType,
        excluded_review_types: [...excluded],
        violations,
        should_block: active && config.action === 'BLOCK_FOR_OPERATOR_DECISION' && violations.length > 0,
        summary_line: active
            ? violations.length > 0
                ? `Review cycle guard: ${config.action} (${violationText})`
                : 'Review cycle guard: within configured limits'
            : 'Review cycle guard: disabled'
    };
}
