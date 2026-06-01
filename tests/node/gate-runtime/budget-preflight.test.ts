import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildBudgetForecast,
    buildBudgetComparison,
    resolveDepthEscalation,
    formatBudgetForecastText,
    computeEffectiveDepth,
    resolveCompressionProfile,
    resolveRiskAwareDepth,
    type BudgetForecastInput,
    type BudgetForecast,
    type RiskTriggers
} from '../../../src/gate-runtime/budget-preflight';


test('resolveDepthEscalation returns no escalation when depths match', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-001',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 50,
        requiredReviews: { code: true, db: false, security: false, refactor: false }
    });
    assert.equal(result.escalated, false);
    assert.equal(result.escalation_reason, null);
    assert.deepEqual(result.escalation_triggers, []);
    assert.equal(result.requested_depth, 2);
    assert.equal(result.effective_depth, 2);
});

test('resolveDepthEscalation detects full_path escalation', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-002',
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 5,
        changedLinesTotal: 100,
        requiredReviews: { code: true, db: false, security: false, refactor: false }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('full_path_minimum_depth_2'));
    assert.ok(result.escalation_reason);
});

test('resolveDepthEscalation detects db_review trigger', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-003',
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 50,
        requiredReviews: { code: true, db: true, security: false, refactor: false }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('db_review_required'));
});

test('resolveDepthEscalation detects security_review trigger', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-004',
        requestedDepth: 1,
        effectiveDepth: 3,
        pathMode: 'FULL_PATH',
        changedFilesCount: 2,
        changedLinesTotal: 30,
        requiredReviews: { code: true, db: false, security: true, refactor: false }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('security_review_required'));
});

test('resolveDepthEscalation detects refactor_review trigger', () => {
    const result = resolveDepthEscalation({
        taskId: null,
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 10,
        changedLinesTotal: 200,
        requiredReviews: { code: true, db: false, security: false, refactor: true }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('refactor_review_required'));
    assert.equal(result.task_id, null);
});

test('resolveDepthEscalation detects specialist review triggers', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-006',
        requestedDepth: 1,
        effectiveDepth: 3,
        pathMode: 'FULL_PATH',
        changedFilesCount: 10,
        changedLinesTotal: 300,
        requiredReviews: { code: true, api: true, test: true, performance: true, infra: true, dependency: true }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('api_review_required'));
    assert.ok(result.escalation_triggers.includes('test_review_required'));
    assert.ok(result.escalation_triggers.includes('performance_review_required'));
    assert.ok(result.escalation_triggers.includes('infra_review_required'));
    assert.ok(result.escalation_triggers.includes('dependency_review_required'));
});

test('resolveDepthEscalation explicit_escalation when no specific trigger matches', () => {
    const result = resolveDepthEscalation({
        taskId: 'T-005',
        requestedDepth: 2,
        effectiveDepth: 3,
        pathMode: 'FAST_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 10,
        requiredReviews: { code: false, db: false, security: false, refactor: false }
    });
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('explicit_escalation'));
});


test('buildBudgetForecast produces non-zero estimates for code review', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-010',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 100,
        requiredReviews: { code: true, db: false, security: false, refactor: false },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    assert.equal(forecast.task_id, 'T-010');
    assert.equal(forecast.requested_depth, 2);
    assert.equal(forecast.effective_depth, 2);
    assert.equal(forecast.depth_escalated, false);
    assert.equal(forecast.path_mode, 'FULL_PATH');
    assert.deepEqual(forecast.required_reviews, ['code']);
    assert.equal(forecast.review_budget_estimates.length, 1);
    assert.equal(forecast.review_budget_estimates[0].review_type, 'code');
    assert.ok(forecast.review_budget_estimates[0].estimated_tokens > 0);
    assert.ok(forecast.total_estimated_review_tokens > 0);
    assert.ok(forecast.compile_gate_estimated_tokens > 0);
    assert.ok(forecast.total_forecast_tokens > 0);
    assert.equal(forecast.token_economy_enabled, true);
    assert.equal(forecast.token_economy_active_for_depth, true);
    assert.ok(forecast.forecast_savings_estimate > 0);
    assert.ok(forecast.effective_forecast_tokens < forecast.total_forecast_tokens);
});

test('buildBudgetForecast with multiple reviews', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-011',
        requestedDepth: 3,
        effectiveDepth: 3,
        pathMode: 'FULL_PATH',
        changedFilesCount: 5,
        changedLinesTotal: 200,
        requiredReviews: { code: true, db: true, security: true, refactor: false, test: true },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    assert.deepEqual(forecast.required_reviews.sort(), ['code', 'db', 'security', 'test']);
    assert.equal(forecast.review_budget_estimates.length, 4);
    assert.equal(forecast.token_economy_active_for_depth, false);
    assert.equal(forecast.forecast_savings_estimate, 0);
    assert.equal(forecast.effective_forecast_tokens, forecast.total_forecast_tokens);
});

test('buildBudgetForecast with no required reviews', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-012',
        requestedDepth: 1,
        effectiveDepth: 1,
        pathMode: 'FAST_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 5,
        requiredReviews: { code: false, db: false, security: false, refactor: false }
    });
    assert.deepEqual(forecast.required_reviews, []);
    assert.equal(forecast.review_budget_estimates.length, 0);
    assert.equal(forecast.total_estimated_review_tokens, 0);
    assert.ok(forecast.compile_gate_estimated_tokens > 0);
    assert.equal(forecast.total_forecast_tokens, forecast.compile_gate_estimated_tokens);
});

test('buildBudgetForecast token economy disabled', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-013',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 50,
        requiredReviews: { code: true },
        tokenEconomyEnabled: false
    });
    assert.equal(forecast.token_economy_enabled, false);
    assert.equal(forecast.token_economy_active_for_depth, false);
    assert.equal(forecast.forecast_savings_estimate, 0);
});

test('buildBudgetForecast depth escalated flag', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-014',
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 2,
        changedLinesTotal: 30,
        requiredReviews: { code: true }
    });
    assert.equal(forecast.depth_escalated, true);
    assert.equal(forecast.requested_depth, 1);
    assert.equal(forecast.effective_depth, 2);
});

test('buildBudgetForecast zero files and lines', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-015',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 0,
        changedLinesTotal: 0,
        requiredReviews: { code: true }
    });
    assert.ok(forecast.total_forecast_tokens > 0);
    assert.ok(forecast.review_budget_estimates[0].estimated_tokens > 0);
});

test('buildBudgetForecast null taskId', () => {
    const forecast = buildBudgetForecast({
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 10,
        requiredReviews: { code: true }
    });
    assert.equal(forecast.task_id, null);
});


test('buildBudgetComparison with forecast and actuals', () => {
    const forecast: BudgetForecast = {
        timestamp_utc: new Date().toISOString(),
        task_id: 'T-020',
        requested_depth: 2,
        effective_depth: 2,
        depth_escalated: false,
        path_mode: 'FULL_PATH',
        changed_files_count: 3,
        changed_lines_total: 100,
        required_reviews: ['code'],
        review_budget_estimates: [{ review_type: 'code', estimated_tokens: 1280, basis: 'heuristic_base_plus_scope' }],
        total_estimated_review_tokens: 1280,
        compile_gate_estimated_tokens: 420,
        total_forecast_tokens: 1700,
        token_economy_enabled: true,
        token_economy_active_for_depth: true,
        forecast_savings_estimate: 595,
        effective_forecast_tokens: 1105
    };
    const comparison = buildBudgetComparison('T-020', forecast, 500, 1500);
    assert.equal(comparison.task_id, 'T-020');
    assert.equal(comparison.forecast_total_tokens, 1700);
    assert.equal(comparison.actual_total_saved_tokens, 500);
    assert.equal(comparison.actual_total_raw_tokens, 1500);
    assert.ok(comparison.forecast_accuracy_ratio != null);
    assert.equal(comparison.requested_depth, 2);
    assert.equal(comparison.effective_depth, 2);
    assert.equal(comparison.depth_escalated, false);
    assert.ok(comparison.summary_line.includes('forecast'));
    assert.ok(comparison.summary_line.includes('actual raw'));
});

test('buildBudgetComparison with null forecast', () => {
    const comparison = buildBudgetComparison('T-021', null, 100, 800);
    assert.equal(comparison.forecast_total_tokens, 0);
    assert.equal(comparison.forecast_accuracy_ratio, null);
    assert.equal(comparison.requested_depth, 0);
    assert.equal(comparison.depth_escalated, false);
});

test('buildBudgetComparison with zero actuals', () => {
    const forecast: BudgetForecast = {
        timestamp_utc: new Date().toISOString(),
        task_id: 'T-022',
        requested_depth: 1,
        effective_depth: 2,
        depth_escalated: true,
        path_mode: 'FULL_PATH',
        changed_files_count: 1,
        changed_lines_total: 10,
        required_reviews: ['code'],
        review_budget_estimates: [{ review_type: 'code', estimated_tokens: 932, basis: 'heuristic_base_plus_scope' }],
        total_estimated_review_tokens: 932,
        compile_gate_estimated_tokens: 340,
        total_forecast_tokens: 1272,
        token_economy_enabled: true,
        token_economy_active_for_depth: true,
        forecast_savings_estimate: 445,
        effective_forecast_tokens: 827
    };
    const comparison = buildBudgetComparison('T-022', forecast, 0, 0);
    assert.equal(comparison.forecast_total_tokens, 1272);
    assert.equal(comparison.forecast_accuracy_ratio, null);
    assert.equal(comparison.depth_escalated, true);
    assert.ok(comparison.summary_line.includes('escalated'));
});


test('formatBudgetForecastText includes key fields', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-030',
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 80,
        requiredReviews: { code: true, security: true },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    const text = formatBudgetForecastText(forecast);
    assert.ok(text.includes('Budget Forecast:'));
    assert.ok(text.includes('1 -> 2 (escalated)'));
    assert.ok(text.includes('FULL_PATH'));
    assert.ok(text.includes('code:'));
    assert.ok(text.includes('security:'));
    assert.ok(text.includes('Total forecast:'));
    assert.ok(text.includes('Token economy savings estimate:'));
    assert.ok(text.includes('Effective forecast:'));
});

test('formatBudgetForecastText no escalation and no token economy', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-031',
        requestedDepth: 3,
        effectiveDepth: 3,
        pathMode: 'FULL_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 10,
        requiredReviews: { code: true },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    const text = formatBudgetForecastText(forecast);
    assert.ok(text.includes('Depth: 3'));
    assert.ok(!text.includes('escalated'));
    assert.ok(!text.includes('Token economy savings'));
});

test('formatBudgetForecastText no reviews', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-032',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FAST_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 5,
        requiredReviews: {}
    });
    const text = formatBudgetForecastText(forecast);
    assert.ok(text.includes('Required reviews: none'));
});


const NO_TRIGGERS: RiskTriggers = {
    db: false, security: false, refactor: false, api: false,
    test: false, performance: false, infra: false, dependency: false
};

test('computeEffectiveDepth returns requested depth when no triggers fire', () => {
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', NO_TRIGGERS), 1);
    assert.equal(computeEffectiveDepth(2, 'FAST_PATH', NO_TRIGGERS), 2);
    assert.equal(computeEffectiveDepth(3, 'FAST_PATH', NO_TRIGGERS), 3);
});

test('computeEffectiveDepth promotes to 2 for FULL_PATH when requested 1', () => {
    assert.equal(computeEffectiveDepth(1, 'FULL_PATH', NO_TRIGGERS), 2);
});

test('computeEffectiveDepth keeps depth 2 for FULL_PATH when requested 2', () => {
    assert.equal(computeEffectiveDepth(2, 'FULL_PATH', NO_TRIGGERS), 2);
});

test('computeEffectiveDepth promotes to 2 for db trigger', () => {
    const triggers = { ...NO_TRIGGERS, db: true };
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', triggers), 2);
});

test('computeEffectiveDepth promotes to 2 for refactor trigger', () => {
    const triggers = { ...NO_TRIGGERS, refactor: true };
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', triggers), 2);
});

test('computeEffectiveDepth promotes to 3 for security trigger', () => {
    const triggers = { ...NO_TRIGGERS, security: true };
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', triggers), 3);
    assert.equal(computeEffectiveDepth(2, 'FULL_PATH', triggers), 3);
});

test('computeEffectiveDepth promotes to 3 for infra trigger', () => {
    const triggers = { ...NO_TRIGGERS, infra: true };
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', triggers), 3);
    assert.equal(computeEffectiveDepth(2, 'FULL_PATH', triggers), 3);
});

test('computeEffectiveDepth caps at 3 with combined triggers', () => {
    const triggers = { ...NO_TRIGGERS, security: true, infra: true, db: true };
    assert.equal(computeEffectiveDepth(1, 'FULL_PATH', triggers), 3);
});

test('computeEffectiveDepth does not demote when requested 3', () => {
    assert.equal(computeEffectiveDepth(3, 'FAST_PATH', NO_TRIGGERS), 3);
    assert.equal(computeEffectiveDepth(3, 'FULL_PATH', { ...NO_TRIGGERS, security: true }), 3);
});

test('computeEffectiveDepth with test/dependency/performance alone stays at requested', () => {
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', { ...NO_TRIGGERS, test: true }), 1);
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', { ...NO_TRIGGERS, dependency: true }), 1);
    assert.equal(computeEffectiveDepth(2, 'FAST_PATH', { ...NO_TRIGGERS, performance: true }), 2);
});

test('computeEffectiveDepth performance promotes via medium risk rule to 2 at most', () => {
    // performance is medium-risk trigger affecting compression but NOT depth alone
    assert.equal(computeEffectiveDepth(1, 'FAST_PATH', { ...NO_TRIGGERS, performance: true }), 1);
});


test('resolveCompressionProfile low risk keeps base config', () => {
    const profile = resolveCompressionProfile(NO_TRIGGERS, 2);
    assert.equal(profile.risk_level, 'low');
    assert.equal(profile.strip_examples, true);
    assert.equal(profile.strip_code_blocks, true);
    assert.equal(profile.compact_reviewer_output, true);
    assert.deepEqual(profile.promotion_triggers, []);
});

test('resolveCompressionProfile high risk disables stripping and compaction', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, security: true }, 3);
    assert.equal(profile.risk_level, 'high');
    assert.equal(profile.strip_examples, false);
    assert.equal(profile.strip_code_blocks, false);
    assert.equal(profile.compact_reviewer_output, false);
    assert.ok(profile.promotion_triggers.includes('strip_examples_disabled_by_high_risk'));
    assert.ok(profile.promotion_triggers.includes('strip_code_blocks_disabled_by_high_risk'));
    assert.ok(profile.promotion_triggers.includes('compact_reviewer_output_disabled_by_high_risk'));
});

test('resolveCompressionProfile infra triggers high risk', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, infra: true }, 2);
    assert.equal(profile.risk_level, 'high');
    assert.equal(profile.strip_examples, false);
    assert.equal(profile.strip_code_blocks, false);
});

test('resolveCompressionProfile medium risk disables code block stripping', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, db: true }, 2);
    assert.equal(profile.risk_level, 'medium');
    assert.equal(profile.strip_examples, true);
    assert.equal(profile.strip_code_blocks, false);
    assert.ok(profile.promotion_triggers.includes('strip_code_blocks_disabled_by_medium_risk'));
});

test('resolveCompressionProfile medium risk at depth 3 disables compact output', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, refactor: true }, 3);
    assert.equal(profile.risk_level, 'medium');
    assert.equal(profile.compact_reviewer_output, false);
    assert.ok(profile.promotion_triggers.includes('compact_reviewer_output_disabled_by_depth3_medium_risk'));
});

test('resolveCompressionProfile medium risk at depth 2 keeps compact output', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, api: true }, 2);
    assert.equal(profile.risk_level, 'medium');
    assert.equal(profile.compact_reviewer_output, true);
});

test('resolveCompressionProfile respects base config overrides', () => {
    const profile = resolveCompressionProfile(NO_TRIGGERS, 2, {
        strip_examples: false,
        strip_code_blocks: false,
        scoped_diffs: false,
        compact_reviewer_output: false
    });
    assert.equal(profile.strip_examples, false);
    assert.equal(profile.strip_code_blocks, false);
    assert.equal(profile.scoped_diffs, false);
    assert.equal(profile.compact_reviewer_output, false);
});

test('resolveCompressionProfile high risk with base already disabled records no triggers', () => {
    const profile = resolveCompressionProfile({ ...NO_TRIGGERS, security: true }, 3, {
        strip_examples: false,
        strip_code_blocks: false,
        compact_reviewer_output: false
    });
    assert.equal(profile.risk_level, 'high');
    assert.deepEqual(profile.promotion_triggers, []);
});

test('resolveCompressionProfile scoped_diffs preserved at all risk levels', () => {
    assert.equal(resolveCompressionProfile({ ...NO_TRIGGERS, security: true }, 3).scoped_diffs, true);
    assert.equal(resolveCompressionProfile({ ...NO_TRIGGERS, db: true }, 2).scoped_diffs, true);
    assert.equal(resolveCompressionProfile(NO_TRIGGERS, 1).scoped_diffs, true);
});


test('resolveRiskAwareDepth combines depth promotion and compression for security trigger', () => {
    const result = resolveRiskAwareDepth(1, 'FULL_PATH', { ...NO_TRIGGERS, security: true });
    assert.equal(result.requested_depth, 1);
    assert.equal(result.effective_depth, 3);
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('full_path_minimum_depth_2'));
    assert.ok(result.escalation_triggers.includes('security_review_required'));
    assert.equal(result.compression.risk_level, 'high');
    assert.equal(result.compression.strip_examples, false);
    assert.equal(result.compression.strip_code_blocks, false);
});

test('resolveRiskAwareDepth no escalation for low-risk FAST_PATH', () => {
    const result = resolveRiskAwareDepth(2, 'FAST_PATH', NO_TRIGGERS);
    assert.equal(result.requested_depth, 2);
    assert.equal(result.effective_depth, 2);
    assert.equal(result.escalated, false);
    assert.deepEqual(result.escalation_triggers, []);
    assert.equal(result.compression.risk_level, 'low');
    assert.equal(result.compression.strip_examples, true);
});

test('resolveRiskAwareDepth db trigger promotes depth to 2 with medium compression', () => {
    const result = resolveRiskAwareDepth(1, 'FAST_PATH', { ...NO_TRIGGERS, db: true });
    assert.equal(result.effective_depth, 2);
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('db_review_required'));
    assert.equal(result.compression.risk_level, 'medium');
    assert.equal(result.compression.strip_examples, true);
    assert.equal(result.compression.strip_code_blocks, false);
});

test('resolveRiskAwareDepth passes base compression config through', () => {
    const result = resolveRiskAwareDepth(2, 'FULL_PATH', NO_TRIGGERS, {
        strip_examples: false,
        strip_code_blocks: false,
        scoped_diffs: true,
        compact_reviewer_output: true
    });
    assert.equal(result.compression.strip_examples, false);
    assert.equal(result.compression.strip_code_blocks, false);
});

test('resolveRiskAwareDepth infra trigger promotes to depth 3 with high risk compression', () => {
    const result = resolveRiskAwareDepth(2, 'FULL_PATH', { ...NO_TRIGGERS, infra: true });
    assert.equal(result.effective_depth, 3);
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('infra_review_required'));
    assert.equal(result.compression.risk_level, 'high');
});


test('resolveRiskAwareDepth with triggers matching classify-change security output', () => {
    // Simulates the trigger map that gates.ts builds from classifyChange result
    const triggers: RiskTriggers = {
        db: false, security: true, refactor: false, api: false,
        test: false, performance: false, infra: false, dependency: false
    };
    const result = resolveRiskAwareDepth(1, 'FULL_PATH', triggers, {
        strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true
    });
    // Security trigger should promote depth to 3 and disable all compression
    assert.equal(result.effective_depth, 3);
    assert.equal(result.compression.risk_level, 'high');
    assert.equal(result.compression.strip_examples, false);
    assert.equal(result.compression.strip_code_blocks, false);
    assert.equal(result.compression.compact_reviewer_output, false);
    assert.ok(result.compression.promotion_triggers.length > 0);
});

test('resolveRiskAwareDepth with triggers matching classify-change db+refactor output', () => {
    const triggers: RiskTriggers = {
        db: true, security: false, refactor: true, api: false,
        test: true, performance: false, infra: false, dependency: false
    };
    const result = resolveRiskAwareDepth(1, 'FULL_PATH', triggers, {
        strip_examples: true, strip_code_blocks: true, scoped_diffs: true, compact_reviewer_output: true
    });
    // db+refactor should promote to at least 2, no security/infra so stays at 2
    assert.equal(result.effective_depth, 2);
    assert.equal(result.compression.risk_level, 'medium');
    assert.equal(result.compression.strip_examples, true);
    assert.equal(result.compression.strip_code_blocks, false);
});

test('resolveRiskAwareDepth budget forecast uses promoted effective depth', () => {
    const triggers: RiskTriggers = { ...NO_TRIGGERS, security: true };
    const result = resolveRiskAwareDepth(1, 'FULL_PATH', triggers);
    // Budget forecast should use promoted depth, not requested
    const forecast = buildBudgetForecast({
        taskId: 'T-INT',
        requestedDepth: 1,
        effectiveDepth: result.effective_depth,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 100,
        requiredReviews: { code: true, security: true },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    assert.equal(forecast.effective_depth, 3);
    assert.equal(forecast.depth_escalated, true);
    // Depth 3 not in enabled_depths=[1,2] so token economy inactive
    assert.equal(forecast.token_economy_active_for_depth, false);
});

// Integration: classifyChange triggers → RiskTriggers mapping contract

import { classifyChange, getDefaultClassificationConfig } from '../../../src/gates/preflight/classify-change';

function makeTestConfig() {
    const defaults = getDefaultClassificationConfig('/repo');
    return {
        source: 'defaults' as const,
        config_path: '/repo/garda-agent-orchestrator/live/config/paths.json',
        metrics_path: '/repo/garda-agent-orchestrator/runtime/metrics.jsonl',
        runtime_roots: defaults.runtime_roots.map((r: string) => r.endsWith('/') ? r : r + '/'),
        fast_path_roots: defaults.fast_path_roots.map((r: string) => r.endsWith('/') ? r : r + '/'),
        fast_path_allowed_regexes: defaults.fast_path_allowed_regexes,
        fast_path_sensitive_regexes: defaults.fast_path_sensitive_regexes,
        sql_or_migration_regexes: defaults.sql_or_migration_regexes,
        db_trigger_regexes: defaults.triggers.db,
        security_trigger_regexes: defaults.triggers.security,
        api_trigger_regexes: defaults.triggers.api,
        dependency_trigger_regexes: defaults.triggers.dependency,
        infra_trigger_regexes: defaults.triggers.infra,
        test_trigger_regexes: defaults.triggers.test,
        performance_trigger_regexes: defaults.triggers.performance,
        code_like_regexes: defaults.code_like_regexes,
        protected_control_plane_roots: [] as string[],
        ordinary_doc_paths: defaults.ordinary_doc_paths
    };
}

test('classifyChange security triggers map to risk-aware depth 3', () => {
    const config = makeTestConfig();
    const result = classifyChange({
        normalizedFiles: ['src/auth/jwt-guard.ts'],
        changedLinesTotal: 50,
        classificationConfig: config,
        reviewCapabilities: { code: true, security: true }
    });
    // classifyChange should trigger security
    assert.equal(result.triggers.security, true);

    // Map triggers to RiskTriggers (same as gates.ts does)
    const riskTriggers: RiskTriggers = {
        db: !!result.triggers.db,
        security: !!result.triggers.security,
        refactor: !!result.triggers.refactor,
        api: !!result.triggers.api,
        test: !!result.triggers.test,
        performance: !!result.triggers.performance,
        infra: !!result.triggers.infra,
        dependency: !!result.triggers.dependency
    };

    const riskAwareResult = resolveRiskAwareDepth(1, result.mode, riskTriggers);
    assert.equal(riskAwareResult.effective_depth, 3);
    assert.equal(riskAwareResult.compression.risk_level, 'high');
});

test('classifyChange db triggers map to risk-aware depth 2', () => {
    const config = makeTestConfig();
    const result = classifyChange({
        normalizedFiles: ['src/db/migrations/001.sql'],
        changedLinesTotal: 20,
        classificationConfig: config,
        reviewCapabilities: { code: true, db: true }
    });
    assert.equal(result.triggers.db, true);

    const riskTriggers: RiskTriggers = {
        db: !!result.triggers.db,
        security: !!result.triggers.security,
        refactor: !!result.triggers.refactor,
        api: !!result.triggers.api,
        test: !!result.triggers.test,
        performance: !!result.triggers.performance,
        infra: !!result.triggers.infra,
        dependency: !!result.triggers.dependency
    };

    const riskAwareResult = resolveRiskAwareDepth(1, result.mode, riskTriggers);
    assert.equal(riskAwareResult.effective_depth, 2);
    assert.equal(riskAwareResult.compression.risk_level, 'medium');
});

test('classifyChange infra triggers map to risk-aware depth 3', () => {
    const config = makeTestConfig();
    const result = classifyChange({
        normalizedFiles: ['infrastructure/terraform/main.tf'],
        changedLinesTotal: 30,
        classificationConfig: config,
        reviewCapabilities: { infra: true }
    });
    assert.equal(result.triggers.infra, true);

    const riskTriggers: RiskTriggers = {
        db: !!result.triggers.db,
        security: !!result.triggers.security,
        refactor: !!result.triggers.refactor,
        api: !!result.triggers.api,
        test: !!result.triggers.test,
        performance: !!result.triggers.performance,
        infra: !!result.triggers.infra,
        dependency: !!result.triggers.dependency
    };

    const riskAwareResult = resolveRiskAwareDepth(1, result.mode, riskTriggers);
    assert.equal(riskAwareResult.effective_depth, 3);
    assert.equal(riskAwareResult.compression.risk_level, 'high');
});

test('risk_aware_depth.effective_depth is usable by downstream rule-pack selection', () => {
    // Simulates the preflight artifact contract: risk_aware_depth stored in preflight
    const triggers: RiskTriggers = { ...NO_TRIGGERS, security: true };
    const riskAwareResult = resolveRiskAwareDepth(1, 'FULL_PATH', triggers);

    // Simulates the rule-pack.ts POST_PREFLIGHT read: reading effective_depth from preflight
    const preflightArtifact = {
        risk_aware_depth: riskAwareResult
    };
    const preflightRiskAwareDepth = preflightArtifact.risk_aware_depth;
    const effectiveDepth = typeof preflightRiskAwareDepth?.effective_depth === 'number'
        ? preflightRiskAwareDepth.effective_depth
        : 2;

    // The downstream effective depth must match what resolveRiskAwareDepth computed
    assert.equal(effectiveDepth, 3);
    assert.equal(effectiveDepth, riskAwareResult.effective_depth);
});
