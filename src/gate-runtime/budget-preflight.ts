// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ReviewBudgetEstimate {
    review_type: string;
    estimated_tokens: number;
    basis: string;
}

export interface BudgetForecast {
    timestamp_utc: string;
    task_id: string | null;
    requested_depth: number;
    effective_depth: number;
    depth_escalated: boolean;
    path_mode: string;
    changed_files_count: number;
    changed_lines_total: number;
    required_reviews: string[];
    review_budget_estimates: ReviewBudgetEstimate[];
    total_estimated_review_tokens: number;
    compile_gate_estimated_tokens: number;
    total_forecast_tokens: number;
    token_economy_enabled: boolean;
    token_economy_active_for_depth: boolean;
    forecast_savings_estimate: number;
    effective_forecast_tokens: number;
}

export interface BudgetForecastInput {
    taskId?: string | null;
    requestedDepth: number;
    effectiveDepth: number;
    pathMode: string;
    changedFilesCount: number;
    changedLinesTotal: number;
    requiredReviews: Record<string, boolean>;
    tokenEconomyEnabled?: boolean;
    tokenEconomyEnabledDepths?: number[];
}

export interface DepthEscalationRecord {
    task_id: string | null;
    requested_depth: number;
    effective_depth: number;
    escalated: boolean;
    escalation_reason: string | null;
    path_mode: string;
    escalation_triggers: string[];
}

export interface RiskTriggers {
    db: boolean;
    security: boolean;
    refactor: boolean;
    api: boolean;
    test: boolean;
    performance: boolean;
    infra: boolean;
    dependency: boolean;
}

export interface CompressionProfile {
    strip_examples: boolean;
    strip_code_blocks: boolean;
    scoped_diffs: boolean;
    compact_reviewer_output: boolean;
    risk_level: 'low' | 'medium' | 'high';
    promotion_triggers: string[];
}

export interface RiskAwareDepthResult {
    requested_depth: number;
    effective_depth: number;
    escalated: boolean;
    escalation_triggers: string[];
    compression: CompressionProfile;
}

// ---------------------------------------------------------------------------
// Constants — heuristic token-cost baselines per review type
// ---------------------------------------------------------------------------

const BASE_REVIEW_TOKENS: Record<string, number> = {
    code: 800,
    db: 400,
    security: 500,
    refactor: 600,
    api: 450,
    test: 350,
    performance: 400,
    infra: 350,
    dependency: 250
};

const TOKENS_PER_CHANGED_FILE = 120;
const TOKENS_PER_CHANGED_LINE = 1.2;
const COMPILE_GATE_BASE_TOKENS = 300;
const COMPILE_GATE_TOKENS_PER_FILE = 40;

// Approximate savings ratio when token economy is active
const TOKEN_ECONOMY_SAVINGS_RATIO = 0.35;

// ---------------------------------------------------------------------------
// Depth escalation
// ---------------------------------------------------------------------------

export function resolveDepthEscalation(input: BudgetForecastInput): DepthEscalationRecord {
    const requested = input.requestedDepth;
    const effective = input.effectiveDepth;
    const escalated = effective > requested;
    const triggers: string[] = [];
    let reason: string | null = null;

    if (escalated) {
        if (input.pathMode === 'FULL_PATH' && requested < 2) {
            triggers.push('full_path_minimum_depth_2');
        }
        const rr = input.requiredReviews;
        if (rr.db) triggers.push('db_review_required');
        if (rr.security) triggers.push('security_review_required');
        if (rr.refactor) triggers.push('refactor_review_required');
        if (rr.api) triggers.push('api_review_required');
        if (rr.test) triggers.push('test_review_required');
        if (rr.performance) triggers.push('performance_review_required');
        if (rr.infra) triggers.push('infra_review_required');
        if (rr.dependency) triggers.push('dependency_review_required');
        if (triggers.length === 0) {
            triggers.push('explicit_escalation');
        }
        reason = triggers.join(', ');
    }

    return {
        task_id: input.taskId || null,
        requested_depth: requested,
        effective_depth: effective,
        escalated,
        escalation_reason: reason,
        path_mode: input.pathMode,
        escalation_triggers: triggers
    };
}

// ---------------------------------------------------------------------------
// Risk-aware depth auto-promotion
// ---------------------------------------------------------------------------

const HIGH_RISK_TRIGGERS: ReadonlySet<string> = new Set(['security', 'infra']);
const MEDIUM_RISK_TRIGGERS: ReadonlySet<string> = new Set(['db', 'refactor', 'api', 'performance']);

function classifyRiskLevel(triggers: RiskTriggers): 'low' | 'medium' | 'high' {
    if (triggers.security || triggers.infra) return 'high';
    if (triggers.db || triggers.refactor || triggers.api || triggers.performance) return 'medium';
    return 'low';
}

/**
 * Compute effective depth from requested depth, path mode, and risk triggers.
 *
 * Rules (from SKILL.md Execution Depth):
 *   - FULL_PATH => minimum depth 2
 *   - required db/security/refactor review => minimum depth 2
 *   - high-risk auth/payment/data/infra changes => prefer depth 3
 */
export function computeEffectiveDepth(
    requestedDepth: number,
    pathMode: string,
    triggers: RiskTriggers
): number {
    let effective = requestedDepth;

    // FULL_PATH forces minimum depth 2
    if (pathMode === 'FULL_PATH' && effective < 2) {
        effective = 2;
    }

    // Specialist reviews that mandate minimum depth 2
    if (triggers.db || triggers.security || triggers.refactor) {
        effective = Math.max(effective, 2);
    }

    // High-risk triggers prefer depth 3
    if (triggers.security || triggers.infra) {
        effective = Math.max(effective, 3);
    }

    return Math.min(effective, 3);
}

/**
 * Resolve a compression profile based on risk triggers and the effective depth.
 *
 * High-risk: conservative (no stripping, full context).
 * Medium-risk: moderate (strip examples only, keep code blocks).
 * Low-risk: full compression allowed.
 */
export function resolveCompressionProfile(
    triggers: RiskTriggers,
    effectiveDepth: number,
    baseConfig?: { strip_examples?: boolean; strip_code_blocks?: boolean; scoped_diffs?: boolean; compact_reviewer_output?: boolean }
): CompressionProfile {
    const riskLevel = classifyRiskLevel(triggers);
    const promotionTriggers: string[] = [];

    const base = {
        strip_examples: baseConfig?.strip_examples !== false,
        strip_code_blocks: baseConfig?.strip_code_blocks !== false,
        scoped_diffs: baseConfig?.scoped_diffs !== false,
        compact_reviewer_output: baseConfig?.compact_reviewer_output !== false
    };

    if (riskLevel === 'high') {
        if (base.strip_examples) promotionTriggers.push('strip_examples_disabled_by_high_risk');
        if (base.strip_code_blocks) promotionTriggers.push('strip_code_blocks_disabled_by_high_risk');
        if (base.compact_reviewer_output) promotionTriggers.push('compact_reviewer_output_disabled_by_high_risk');
        return {
            strip_examples: false,
            strip_code_blocks: false,
            scoped_diffs: base.scoped_diffs,
            compact_reviewer_output: false,
            risk_level: 'high',
            promotion_triggers: promotionTriggers
        };
    }

    if (riskLevel === 'medium') {
        if (base.strip_code_blocks) promotionTriggers.push('strip_code_blocks_disabled_by_medium_risk');
        // At depth 3 with medium risk, also disable compact output
        const compactOutput = effectiveDepth >= 3 ? false : base.compact_reviewer_output;
        if (base.compact_reviewer_output && !compactOutput) {
            promotionTriggers.push('compact_reviewer_output_disabled_by_depth3_medium_risk');
        }
        return {
            strip_examples: base.strip_examples,
            strip_code_blocks: false,
            scoped_diffs: base.scoped_diffs,
            compact_reviewer_output: compactOutput,
            risk_level: 'medium',
            promotion_triggers: promotionTriggers
        };
    }

    // Low risk: use base config as-is
    return {
        ...base,
        risk_level: 'low',
        promotion_triggers: []
    };
}

/**
 * Full risk-aware depth resolution: computes effective depth from triggers,
 * then resolves the compression profile.
 */
export function resolveRiskAwareDepth(
    requestedDepth: number,
    pathMode: string,
    triggers: RiskTriggers,
    baseCompressionConfig?: { strip_examples?: boolean; strip_code_blocks?: boolean; scoped_diffs?: boolean; compact_reviewer_output?: boolean }
): RiskAwareDepthResult {
    const effectiveDepth = computeEffectiveDepth(requestedDepth, pathMode, triggers);
    const escalated = effectiveDepth > requestedDepth;
    const escalationTriggers: string[] = [];

    if (pathMode === 'FULL_PATH' && requestedDepth < 2 && effectiveDepth >= 2) {
        escalationTriggers.push('full_path_minimum_depth_2');
    }
    if (triggers.db) escalationTriggers.push('db_review_required');
    if (triggers.security) escalationTriggers.push('security_review_required');
    if (triggers.refactor) escalationTriggers.push('refactor_review_required');
    if (triggers.infra) escalationTriggers.push('infra_review_required');

    const compression = resolveCompressionProfile(triggers, effectiveDepth, baseCompressionConfig);

    return {
        requested_depth: requestedDepth,
        effective_depth: effectiveDepth,
        escalated,
        escalation_triggers: escalationTriggers,
        compression
    };
}

// ---------------------------------------------------------------------------
// Budget forecasting
// ---------------------------------------------------------------------------

function estimateReviewTokens(reviewType: string, changedFilesCount: number, changedLinesTotal: number): number {
    const base = BASE_REVIEW_TOKENS[reviewType] || 400;
    const fileCost = changedFilesCount * TOKENS_PER_CHANGED_FILE;
    const lineCost = Math.ceil(changedLinesTotal * TOKENS_PER_CHANGED_LINE);
    return base + fileCost + lineCost;
}

function estimateCompileGateTokens(changedFilesCount: number): number {
    return COMPILE_GATE_BASE_TOKENS + changedFilesCount * COMPILE_GATE_TOKENS_PER_FILE;
}

export function buildBudgetForecast(input: BudgetForecastInput): BudgetForecast {
    const requiredReviewTypes = Object.entries(input.requiredReviews)
        .filter(([, required]) => required)
        .map(([type]) => type);

    const reviewEstimates: ReviewBudgetEstimate[] = requiredReviewTypes.map((reviewType) => ({
        review_type: reviewType,
        estimated_tokens: estimateReviewTokens(reviewType, input.changedFilesCount, input.changedLinesTotal),
        basis: 'heuristic_base_plus_scope'
    }));

    const totalReviewTokens = reviewEstimates.reduce((sum, item) => sum + item.estimated_tokens, 0);
    const compileTokens = estimateCompileGateTokens(input.changedFilesCount);
    const totalForecast = totalReviewTokens + compileTokens;

    const enabledDepths = input.tokenEconomyEnabledDepths || [1, 2];
    const tokenEconomyEnabled = input.tokenEconomyEnabled !== false;
    const tokenEconomyActiveForDepth = tokenEconomyEnabled && enabledDepths.includes(input.effectiveDepth);
    const savingsEstimate = tokenEconomyActiveForDepth
        ? Math.ceil(totalForecast * TOKEN_ECONOMY_SAVINGS_RATIO)
        : 0;
    const effectiveForecast = totalForecast - savingsEstimate;

    const escalated = input.effectiveDepth > input.requestedDepth;

    return {
        timestamp_utc: new Date().toISOString(),
        task_id: input.taskId || null,
        requested_depth: input.requestedDepth,
        effective_depth: input.effectiveDepth,
        depth_escalated: escalated,
        path_mode: input.pathMode,
        changed_files_count: input.changedFilesCount,
        changed_lines_total: input.changedLinesTotal,
        required_reviews: requiredReviewTypes,
        review_budget_estimates: reviewEstimates,
        total_estimated_review_tokens: totalReviewTokens,
        compile_gate_estimated_tokens: compileTokens,
        total_forecast_tokens: totalForecast,
        token_economy_enabled: tokenEconomyEnabled,
        token_economy_active_for_depth: tokenEconomyActiveForDepth,
        forecast_savings_estimate: savingsEstimate,
        effective_forecast_tokens: effectiveForecast
    };
}

// ---------------------------------------------------------------------------
// Requested-vs-effective comparison (for stats)
// ---------------------------------------------------------------------------

export interface BudgetComparisonResult {
    task_id: string;
    forecast_total_tokens: number;
    actual_total_saved_tokens: number;
    actual_total_raw_tokens: number;
    forecast_accuracy_ratio: number | null;
    requested_depth: number;
    effective_depth: number;
    depth_escalated: boolean;
    summary_line: string;
}

export function buildBudgetComparison(
    taskId: string,
    forecast: BudgetForecast | null,
    actualSavedTokens: number,
    actualRawTokens: number
): BudgetComparisonResult {
    const forecastTotal = forecast ? forecast.total_forecast_tokens : 0;
    const requestedDepth = forecast ? forecast.requested_depth : 0;
    const effectiveDepth = forecast ? forecast.effective_depth : 0;
    const depthEscalated = forecast ? forecast.depth_escalated : false;

    let accuracyRatio: number | null = null;
    if (forecastTotal > 0 && actualRawTokens > 0) {
        accuracyRatio = Math.round((actualRawTokens / forecastTotal) * 100) / 100;
    }

    const parts: string[] = [];
    if (requestedDepth > 0 && effectiveDepth > 0) {
        if (depthEscalated) {
            parts.push(`depth: ${requestedDepth}->${effectiveDepth} (escalated)`);
        } else {
            parts.push(`depth: ${effectiveDepth}`);
        }
    }
    if (forecastTotal > 0) {
        parts.push(`forecast: ~${forecastTotal} tokens`);
    }
    if (actualRawTokens > 0) {
        parts.push(`actual raw: ~${actualRawTokens} tokens`);
    }
    if (actualSavedTokens > 0) {
        parts.push(`saved: ~${actualSavedTokens} tokens`);
    }
    if (accuracyRatio !== null) {
        parts.push(`accuracy: ${accuracyRatio}x`);
    }

    return {
        task_id: taskId,
        forecast_total_tokens: forecastTotal,
        actual_total_saved_tokens: actualSavedTokens,
        actual_total_raw_tokens: actualRawTokens,
        forecast_accuracy_ratio: accuracyRatio,
        requested_depth: requestedDepth,
        effective_depth: effectiveDepth,
        depth_escalated: depthEscalated,
        summary_line: parts.length > 0 ? parts.join(', ') : 'no forecast data'
    };
}

// ---------------------------------------------------------------------------
// Format helpers
// ---------------------------------------------------------------------------

export function formatBudgetForecastText(forecast: BudgetForecast): string {
    const lines: string[] = [];
    lines.push('Budget Forecast:');
    if (forecast.depth_escalated) {
        lines.push(`  Depth: ${forecast.requested_depth} -> ${forecast.effective_depth} (escalated)`);
    } else {
        lines.push(`  Depth: ${forecast.effective_depth}`);
    }
    lines.push(`  PathMode: ${forecast.path_mode}`);
    lines.push(`  Scope: ${forecast.changed_files_count} files, ${forecast.changed_lines_total} lines`);
    lines.push(`  Required reviews: ${forecast.required_reviews.length > 0 ? forecast.required_reviews.join(', ') : 'none'}`);

    if (forecast.review_budget_estimates.length > 0) {
        for (const est of forecast.review_budget_estimates) {
            lines.push(`    ${est.review_type}: ~${est.estimated_tokens} tokens (${est.basis})`);
        }
    }

    lines.push(`  Compile gate: ~${forecast.compile_gate_estimated_tokens} tokens`);
    lines.push(`  Total forecast: ~${forecast.total_forecast_tokens} tokens`);

    if (forecast.token_economy_active_for_depth) {
        lines.push(`  Token economy savings estimate: ~${forecast.forecast_savings_estimate} tokens`);
        lines.push(`  Effective forecast: ~${forecast.effective_forecast_tokens} tokens`);
    }

    return lines.join('\n');
}
