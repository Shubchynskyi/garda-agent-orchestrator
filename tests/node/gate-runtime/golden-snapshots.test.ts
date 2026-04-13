/**
 * Golden snapshot tests for token economy, compaction, and output filter behavior.
 *
 * These tests lock down the deterministic output shapes of hot-path functions
 * so that contract-breaking regressions are caught immediately.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
    buildOutputTelemetry,
    formatVisibleSavingsLine
} from '../../../src/gate-runtime/token-telemetry';

import {
    buildBudgetForecast,
    buildBudgetComparison,
    formatBudgetForecastText,
    resolveRiskAwareDepth,
    resolveCompressionProfile,
    type BudgetForecastInput,
    type RiskTriggers
} from '../../../src/gate-runtime/budget-preflight';

import {
    compactMarkdownContent
} from '../../../src/gate-runtime/review-context';

import {
    normalizeErrorSignature,
    groupMatchingLines,
    formatGroupedLines
} from '../../../src/gate-runtime/output-filters';

// ============================================================================
// buildOutputTelemetry — golden output shape
// ============================================================================

test('golden: buildOutputTelemetry passthrough shape', () => {
    const raw = ['line one', 'line two', 'line three'];
    const filtered = ['line one', 'line two', 'line three'];
    const result = buildOutputTelemetry(raw, filtered);

    assert.deepEqual(Object.keys(result).sort(), [
        'estimated_saved_chars',
        'estimated_saved_tokens',
        'estimated_saved_tokens_chars_per_4',
        'fallback_mode',
        'filter_mode',
        'filtered_char_count',
        'filtered_line_count',
        'filtered_token_count_estimate',
        'legacy_token_estimator',
        'parser_mode',
        'parser_name',
        'parser_strategy',
        'raw_char_count',
        'raw_line_count',
        'raw_token_count_estimate',
        'token_estimator'
    ]);

    assert.equal(result.raw_line_count, 3);
    assert.equal(result.filtered_line_count, 3);
    assert.equal(result.estimated_saved_tokens, 0);
    assert.equal(result.estimated_saved_chars, 0);
    assert.equal(result.filter_mode, 'passthrough');
    assert.equal(result.fallback_mode, 'none');
    assert.equal(result.parser_mode, 'NONE');
    assert.equal(result.parser_name, null);
    assert.equal(result.parser_strategy, null);
    assert.equal(result.token_estimator, 'hybrid_text_v1');
    assert.equal(result.legacy_token_estimator, 'chars_per_4');
});

test('golden: buildOutputTelemetry with filtering produces savings', () => {
    const raw = Array.from({ length: 20 }, (_, i) => `error line ${i}: something failed at /path/to/file.ts:${i}`);
    const filtered = ['error line 0: something failed at /path/to/file.ts:0'];
    const result = buildOutputTelemetry(raw, filtered, {
        filterMode: 'profile_applied',
        parserMode: 'ACTIVE',
        parserName: 'compile_failure_summary',
        parserStrategy: 'node'
    });

    assert.equal(result.raw_line_count, 20);
    assert.equal(result.filtered_line_count, 1);
    assert.ok((result.estimated_saved_tokens as number) > 0, 'must report positive token savings');
    assert.ok((result.estimated_saved_chars as number) > 0, 'must report positive char savings');
    assert.equal(result.filter_mode, 'profile_applied');
    assert.equal(result.parser_mode, 'ACTIVE');
    assert.equal(result.parser_name, 'compile_failure_summary');
    assert.equal(result.parser_strategy, 'node');

    // Invariant: saved = raw - filtered (both chars and tokens)
    const savedChars = result.estimated_saved_chars as number;
    const rawChars = result.raw_char_count as number;
    const filteredChars = result.filtered_char_count as number;
    assert.equal(savedChars, rawChars - filteredChars);

    const savedTokens = result.estimated_saved_tokens as number;
    const rawTokens = result.raw_token_count_estimate as number;
    const filteredTokens = result.filtered_token_count_estimate as number;
    assert.equal(savedTokens, rawTokens - filteredTokens);
});

test('golden: buildOutputTelemetry empty input', () => {
    const result = buildOutputTelemetry([], []);
    assert.equal(result.raw_line_count, 0);
    assert.equal(result.filtered_line_count, 0);
    assert.equal(result.raw_char_count, 0);
    assert.equal(result.filtered_char_count, 0);
    assert.equal(result.raw_token_count_estimate, 0);
    assert.equal(result.filtered_token_count_estimate, 0);
    assert.equal(result.estimated_saved_tokens, 0);
    assert.equal(result.estimated_saved_chars, 0);
});

// ============================================================================
// formatVisibleSavingsLine — golden output patterns
// ============================================================================

test('golden: formatVisibleSavingsLine produces expected format', () => {
    const telemetry = buildOutputTelemetry(
        Array.from({ length: 50 }, (_, i) => `output line ${i} with some content for estimation`),
        ['summary: 50 lines filtered'],
        { filterMode: 'profile_applied' }
    );
    const line = formatVisibleSavingsLine(telemetry);
    assert.ok(line !== null, 'should produce a savings line');
    assert.match(line!, /^\[token-economy\] saved ~\d+ tokens \(~\d+%\)$/);
});

test('golden: formatVisibleSavingsLine returns null for zero savings', () => {
    const telemetry = buildOutputTelemetry(['single line'], ['single line']);
    const line = formatVisibleSavingsLine(telemetry);
    assert.equal(line, null);
});

test('golden: formatVisibleSavingsLine respects custom label', () => {
    const telemetry = buildOutputTelemetry(
        Array.from({ length: 30 }, (_, i) => `line ${i} with enough content`),
        ['one filtered line'],
        { filterMode: 'custom' }
    );
    const line = formatVisibleSavingsLine(telemetry, { label: 'compile-gate' });
    assert.ok(line !== null);
    assert.match(line!, /^\[compile-gate\] saved ~\d+ tokens/);
});

// ============================================================================
// buildBudgetForecast — golden output shape
// ============================================================================

test('golden: buildBudgetForecast shape with single review', () => {
    const input: BudgetForecastInput = {
        taskId: 'T-GOLDEN-01',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 50,
        requiredReviews: { code: true, db: false, security: false, refactor: false },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    };
    const forecast = buildBudgetForecast(input);

    assert.deepEqual(Object.keys(forecast).sort(), [
        'changed_files_count',
        'changed_lines_total',
        'compile_gate_estimated_tokens',
        'depth_escalated',
        'effective_depth',
        'effective_forecast_tokens',
        'forecast_savings_estimate',
        'path_mode',
        'requested_depth',
        'required_reviews',
        'review_budget_estimates',
        'task_id',
        'timestamp_utc',
        'token_economy_active_for_depth',
        'token_economy_enabled',
        'total_estimated_review_tokens',
        'total_forecast_tokens'
    ]);

    assert.equal(forecast.task_id, 'T-GOLDEN-01');
    assert.equal(forecast.requested_depth, 2);
    assert.equal(forecast.effective_depth, 2);
    assert.equal(forecast.depth_escalated, false);
    assert.equal(forecast.path_mode, 'FULL_PATH');
    assert.equal(forecast.changed_files_count, 3);
    assert.equal(forecast.changed_lines_total, 50);
    assert.deepEqual(forecast.required_reviews, ['code']);
    assert.equal(forecast.token_economy_enabled, true);
    assert.equal(forecast.token_economy_active_for_depth, true);

    // Review budget: code = 800 + 3*120 + ceil(50*1.2) = 800 + 360 + 60 = 1220
    assert.equal(forecast.review_budget_estimates.length, 1);
    assert.equal(forecast.review_budget_estimates[0].review_type, 'code');
    assert.equal(forecast.review_budget_estimates[0].estimated_tokens, 1220);
    assert.equal(forecast.review_budget_estimates[0].basis, 'heuristic_base_plus_scope');

    // Compile gate: 300 + 3*40 = 420
    assert.equal(forecast.compile_gate_estimated_tokens, 420);

    // Total: 1220 + 420 = 1640
    assert.equal(forecast.total_estimated_review_tokens, 1220);
    assert.equal(forecast.total_forecast_tokens, 1640);

    // Savings: ceil(1640 * 0.35) = 574
    assert.equal(forecast.forecast_savings_estimate, 574);
    assert.equal(forecast.effective_forecast_tokens, 1640 - 574);
});

test('golden: buildBudgetForecast with multiple reviews and no token economy', () => {
    const input: BudgetForecastInput = {
        taskId: 'T-GOLDEN-02',
        requestedDepth: 3,
        effectiveDepth: 3,
        pathMode: 'FULL_PATH',
        changedFilesCount: 5,
        changedLinesTotal: 100,
        requiredReviews: { code: true, db: true, security: true, refactor: false },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    };
    const forecast = buildBudgetForecast(input);

    assert.deepEqual(forecast.required_reviews, ['code', 'db', 'security']);
    assert.equal(forecast.token_economy_active_for_depth, false);
    assert.equal(forecast.forecast_savings_estimate, 0);
    assert.equal(forecast.effective_forecast_tokens, forecast.total_forecast_tokens);

    // code: 800+600+120=1520, db: 400+600+120=1120, security: 500+600+120=1220
    assert.equal(forecast.review_budget_estimates.length, 3);
    assert.equal(forecast.total_estimated_review_tokens, 1520 + 1120 + 1220);
    // compile: 300+200=500
    assert.equal(forecast.compile_gate_estimated_tokens, 500);
    assert.equal(forecast.total_forecast_tokens, 1520 + 1120 + 1220 + 500);
});

test('golden: buildBudgetForecast zero-file zero-line', () => {
    const input: BudgetForecastInput = {
        taskId: null,
        requestedDepth: 1,
        effectiveDepth: 1,
        pathMode: 'FAST_PATH',
        changedFilesCount: 0,
        changedLinesTotal: 0,
        requiredReviews: { code: true }
    };
    const forecast = buildBudgetForecast(input);
    assert.equal(forecast.task_id, null);
    assert.equal(forecast.review_budget_estimates[0].estimated_tokens, 800);
    assert.equal(forecast.compile_gate_estimated_tokens, 300);
});

// ============================================================================
// formatBudgetForecastText — golden output lines
// ============================================================================

test('golden: formatBudgetForecastText structure', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-FMT',
        requestedDepth: 1,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 2,
        changedLinesTotal: 30,
        requiredReviews: { code: true, test: true },
        tokenEconomyEnabled: true,
        tokenEconomyEnabledDepths: [1, 2]
    });
    const text = formatBudgetForecastText(forecast);
    const lines = text.split('\n');

    assert.match(lines[0], /^Budget Forecast:$/);
    assert.match(lines[1], /Depth: 1 -> 2 \(escalated\)/);
    assert.match(lines[2], /PathMode: FULL_PATH/);
    assert.match(lines[3], /Scope: 2 files, 30 lines/);
    assert.match(lines[4], /Required reviews: code, test/);
    assert.ok(lines.some(l => /code: ~\d+ tokens/.test(l)));
    assert.ok(lines.some(l => /test: ~\d+ tokens/.test(l)));
    assert.ok(lines.some(l => /Compile gate: ~\d+ tokens/.test(l)));
    assert.ok(lines.some(l => /Total forecast: ~\d+ tokens/.test(l)));
    assert.ok(lines.some(l => /Token economy savings estimate: ~\d+ tokens/.test(l)));
    assert.ok(lines.some(l => /Effective forecast: ~\d+ tokens/.test(l)));
});

test('golden: formatBudgetForecastText no escalation', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-FMT2',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 1,
        changedLinesTotal: 10,
        requiredReviews: { code: true },
        tokenEconomyEnabled: false
    });
    const text = formatBudgetForecastText(forecast);
    assert.match(text, /Depth: 2\n/);
    assert.ok(!text.includes('escalated'));
    assert.ok(!text.includes('Token economy savings'));
});

// ============================================================================
// buildBudgetComparison — golden output shape
// ============================================================================

test('golden: buildBudgetComparison with forecast', () => {
    const forecast = buildBudgetForecast({
        taskId: 'T-CMP',
        requestedDepth: 2,
        effectiveDepth: 2,
        pathMode: 'FULL_PATH',
        changedFilesCount: 3,
        changedLinesTotal: 50,
        requiredReviews: { code: true }
    });
    const result = buildBudgetComparison('T-CMP', forecast, 400, 1600);

    assert.deepEqual(Object.keys(result).sort(), [
        'actual_total_raw_tokens',
        'actual_total_saved_tokens',
        'depth_escalated',
        'effective_depth',
        'forecast_accuracy_ratio',
        'forecast_total_tokens',
        'requested_depth',
        'summary_line',
        'task_id'
    ]);

    assert.equal(result.task_id, 'T-CMP');
    assert.equal(result.forecast_total_tokens, forecast.total_forecast_tokens);
    assert.equal(result.actual_total_saved_tokens, 400);
    assert.equal(result.actual_total_raw_tokens, 1600);
    assert.ok(typeof result.forecast_accuracy_ratio === 'number');
    assert.match(result.summary_line, /depth: 2/);
    assert.match(result.summary_line, /forecast: ~\d+ tokens/);
    assert.match(result.summary_line, /actual raw: ~1600 tokens/);
    assert.match(result.summary_line, /saved: ~400 tokens/);
    assert.match(result.summary_line, /accuracy: [\d.]+x/);
});

test('golden: buildBudgetComparison without forecast', () => {
    const result = buildBudgetComparison('T-NIL', null, 0, 0);
    assert.equal(result.forecast_total_tokens, 0);
    assert.equal(result.forecast_accuracy_ratio, null);
    assert.equal(result.summary_line, 'no forecast data');
});

// ============================================================================
// resolveRiskAwareDepth — golden compression profiles
// ============================================================================

test('golden: resolveRiskAwareDepth low risk', () => {
    const triggers: RiskTriggers = {
        db: false, security: false, refactor: false, api: false,
        test: true, performance: false, infra: false, dependency: false
    };
    const result = resolveRiskAwareDepth(2, 'FULL_PATH', triggers);

    assert.deepEqual(result, {
        requested_depth: 2,
        effective_depth: 2,
        escalated: false,
        escalation_triggers: [],
        compression: {
            strip_examples: true,
            strip_code_blocks: true,
            scoped_diffs: true,
            compact_reviewer_output: true,
            risk_level: 'low',
            promotion_triggers: []
        }
    });
});

test('golden: resolveRiskAwareDepth medium risk (db)', () => {
    const triggers: RiskTriggers = {
        db: true, security: false, refactor: false, api: false,
        test: false, performance: false, infra: false, dependency: false
    };
    const result = resolveRiskAwareDepth(1, 'FULL_PATH', triggers);

    assert.equal(result.effective_depth, 2);
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('full_path_minimum_depth_2'));
    assert.ok(result.escalation_triggers.includes('db_review_required'));
    assert.equal(result.compression.risk_level, 'medium');
    assert.equal(result.compression.strip_examples, true);
    assert.equal(result.compression.strip_code_blocks, false);
    assert.ok(result.compression.promotion_triggers.includes('strip_code_blocks_disabled_by_medium_risk'));
});

test('golden: resolveRiskAwareDepth high risk (security)', () => {
    const triggers: RiskTriggers = {
        db: false, security: true, refactor: false, api: false,
        test: false, performance: false, infra: false, dependency: false
    };
    const result = resolveRiskAwareDepth(1, 'FAST_PATH', triggers);

    assert.equal(result.effective_depth, 3);
    assert.equal(result.escalated, true);
    assert.ok(result.escalation_triggers.includes('security_review_required'));
    assert.equal(result.compression.risk_level, 'high');
    assert.equal(result.compression.strip_examples, false);
    assert.equal(result.compression.strip_code_blocks, false);
    assert.equal(result.compression.compact_reviewer_output, false);
    assert.ok(result.compression.promotion_triggers.length >= 3);
});

// ============================================================================
// resolveCompressionProfile — golden risk-level profiles
// ============================================================================

test('golden: resolveCompressionProfile low risk keeps full compression', () => {
    const triggers: RiskTriggers = {
        db: false, security: false, refactor: false, api: false,
        test: true, performance: false, infra: false, dependency: true
    };
    const profile = resolveCompressionProfile(triggers, 2);
    assert.deepEqual(profile, {
        strip_examples: true,
        strip_code_blocks: true,
        scoped_diffs: true,
        compact_reviewer_output: true,
        risk_level: 'low',
        promotion_triggers: []
    });
});

test('golden: resolveCompressionProfile high risk disables all stripping', () => {
    const triggers: RiskTriggers = {
        db: false, security: false, refactor: false, api: false,
        test: false, performance: false, infra: true, dependency: false
    };
    const profile = resolveCompressionProfile(triggers, 3);
    assert.equal(profile.risk_level, 'high');
    assert.equal(profile.strip_examples, false);
    assert.equal(profile.strip_code_blocks, false);
    assert.equal(profile.compact_reviewer_output, false);
    assert.equal(profile.scoped_diffs, true);
    assert.ok(profile.promotion_triggers.length >= 3);
});

// ============================================================================
// compactMarkdownContent — golden compaction behavior
// ============================================================================

test('golden: compactMarkdownContent passthrough without options', () => {
    const input = '# Title\n\nSome paragraph.\n\n## Section\n\nMore text.\n';
    const result = compactMarkdownContent(input);

    assert.deepEqual(Object.keys(result).sort(), [
        'content',
        'original_char_count',
        'original_line_count',
        'output_char_count',
        'output_line_count',
        'removed_code_blocks',
        'removed_example_content_lines',
        'removed_example_labels',
        'removed_example_sections',
        'retained_structural_code_blocks'
    ]);

    // Source ends with \n so compacted content preserves trailing newline
    assert.equal(result.content, '# Title\n\nSome paragraph.\n\n## Section\n\nMore text.\n');
    assert.equal(result.removed_code_blocks, 0);
    assert.equal(result.removed_example_sections, 0);
    assert.equal(result.retained_structural_code_blocks, 0);
});

test('golden: compactMarkdownContent strips example sections', () => {
    const input = [
        '# Rules',
        '',
        'Important rule text.',
        '',
        '## Examples',
        '',
        'Bad example:',
        '```java',
        'counter++;',
        '```',
        '',
        'Good example:',
        '```java',
        'items.stream().skip(1);',
        '```',
        '',
        '## Config',
        '',
        'Config section retained.',
        ''
    ].join('\n');

    const result = compactMarkdownContent(input, { stripExamples: true });
    assert.ok(result.removed_example_sections >= 1);
    assert.ok(result.content.includes('# Rules'));
    assert.ok(result.content.includes('Important rule text.'));
    assert.ok(result.content.includes('## Config'));
    assert.ok(result.content.includes('Config section retained.'));
    assert.ok(result.content.includes('Example section omitted due to token economy.'));
    assert.ok(result.output_line_count < result.original_line_count);
    assert.ok(result.output_char_count < result.original_char_count);
});

test('golden: compactMarkdownContent strips illustrative code blocks', () => {
    const input = [
        '# Setup',
        '',
        '```bash',
        'npm install',
        '```',
        '',
        'For example:',
        '',
        '```typescript',
        'const x = 1;',
        '```',
        '',
        'More text.',
        ''
    ].join('\n');

    const result = compactMarkdownContent(input, { stripCodeBlocks: true });
    assert.equal(result.retained_structural_code_blocks, 1);
    assert.ok(result.removed_code_blocks >= 1);
    assert.ok(result.content.includes('npm install'));
    assert.ok(!result.content.includes('const x = 1;'));
    assert.ok(result.content.includes('Code block omitted due to token economy.'));
});

test('golden: compactMarkdownContent combined strip modes', () => {
    const input = [
        '# Main',
        '',
        'Key rule.',
        '',
        '## Examples',
        '',
        '```java',
        'bad code;',
        '```',
        '',
        '## Commands',
        '',
        '```bash',
        'npm run build',
        '```',
        ''
    ].join('\n');

    const result = compactMarkdownContent(input, { stripExamples: true, stripCodeBlocks: true });
    assert.ok(result.removed_example_sections >= 1);
    assert.ok(result.content.includes('npm run build'));
    assert.ok(!result.content.includes('bad code;'));

    // Line count invariant: output never exceeds original
    assert.ok(result.output_line_count <= result.original_line_count);
    // Note: char count can slightly exceed original when placeholder text replaces
    // very short removed content, so we verify line count as the primary invariant.
});

test('golden: compactMarkdownContent empty input', () => {
    const result = compactMarkdownContent('');
    assert.equal(result.content, '');
    assert.equal(result.original_line_count, 1);
    assert.equal(result.output_line_count, 0);
    assert.equal(result.removed_code_blocks, 0);
});

// ============================================================================
// normalizeErrorSignature — golden normalization patterns
// ============================================================================

test('golden: normalizeErrorSignature strips file path prefix', () => {
    const sig = normalizeErrorSignature('src/main/java/App.java:42:10: error: cannot find symbol');
    assert.equal(sig, 'error: cannot find symbol');
});

test('golden: normalizeErrorSignature strips Windows path prefix', () => {
    const sig = normalizeErrorSignature('C:\\Users\\dev\\project\\src\\file.ts:10:5: Type error');
    assert.equal(sig, 'Type error');
});

test('golden: normalizeErrorSignature anonymizes inline paths', () => {
    const sig = normalizeErrorSignature('Module not found: /home/user/project/node_modules/missing');
    assert.match(sig, /<path>/);
    assert.ok(!sig.includes('/home/user'));
});

test('golden: normalizeErrorSignature strips line-column tuples', () => {
    const sig = normalizeErrorSignature('error TS2304(5,12): Cannot find name');
    assert.ok(!sig.includes('(5,12)'));
    assert.ok(sig.includes('Cannot find name'));
});

test('golden: normalizeErrorSignature preserves bare error text', () => {
    const sig = normalizeErrorSignature('COMPILATION ERROR');
    assert.equal(sig, 'COMPILATION ERROR');
});

// ============================================================================
// groupMatchingLines + formatGroupedLines — golden grouping behavior
// ============================================================================

test('golden: groupMatchingLines deduplication and format', () => {
    const lines = [
        'src/a.ts:1:1: error TS2304: Cannot find name',
        'src/b.ts:5:3: error TS2304: Cannot find name',
        'src/c.ts:10:1: error TS2304: Cannot find name',
        'src/d.ts:2:1: error TS6133: declared but never used',
        'src/e.ts:8:1: error TS6133: declared but never used',
        'all good here'
    ];
    const patterns = ['error TS\\d+'];
    const result = groupMatchingLines(lines, patterns, 10);

    assert.equal(result.total_matches, 5);
    assert.equal(result.unique_groups, 2);
    assert.equal(result.groups.length, 2);
    assert.equal(result.groups[0].count, 3);
    assert.equal(result.groups[1].count, 2);

    const formatted = formatGroupedLines(result);
    assert.equal(formatted.length, 2);
    assert.match(formatted[0], /^\[3×\] /);
    assert.match(formatted[1], /^\[2×\] /);
});

test('golden: groupMatchingLines truncation with maxGroups', () => {
    const lines = [
        'error A: first',
        'error B: second',
        'error C: third',
        'error D: fourth'
    ];
    const result = groupMatchingLines(lines, ['error'], 2);

    assert.equal(result.total_matches, 4);
    assert.equal(result.unique_groups, 4);
    assert.equal(result.groups.length, 2);

    const formatted = formatGroupedLines(result);
    assert.equal(formatted.length, 3);
    assert.equal(formatted[2], '... and 2 more distinct error(s) (4 total matches)');
});

test('golden: formatGroupedLines single-count entries have no prefix', () => {
    const result = {
        groups: [
            { signature: 'sig1', representative: 'error: unique problem', count: 1 },
            { signature: 'sig2', representative: 'error: another unique', count: 1 }
        ],
        total_matches: 2,
        unique_groups: 2
    };
    const formatted = formatGroupedLines(result);
    assert.equal(formatted.length, 2);
    assert.equal(formatted[0], 'error: unique problem');
    assert.equal(formatted[1], 'error: another unique');
});

// ============================================================================
// Token telemetry invariants across estimators
// ============================================================================

test('golden: buildOutputTelemetry savings invariant holds across estimators', () => {
    const raw = Array.from({ length: 40 }, (_, i) => `diagnostic line ${i}: some verbose output content here`);
    const filtered = raw.slice(0, 5);

    for (const estimator of ['hybrid_text_v1', 'chars_per_4', 'chars_per_3_5', 'chars_per_4_5']) {
        const result = buildOutputTelemetry(raw, filtered, { tokenEstimator: estimator });
        const savedTokens = result.estimated_saved_tokens as number;
        const rawTokens = result.raw_token_count_estimate as number;
        const filteredTokens = result.filtered_token_count_estimate as number;
        assert.equal(savedTokens, rawTokens - filteredTokens,
            `invariant violated for estimator ${estimator}`);
        assert.ok(savedTokens >= 0, `savings must be non-negative for ${estimator}`);
        assert.ok(filteredTokens <= rawTokens, `filtered must not exceed raw for ${estimator}`);
    }
});

// ============================================================================
// Budget forecast invariant: total = reviews + compile
// ============================================================================

test('golden: budget forecast total equals sum of parts', () => {
    const configs: BudgetForecastInput[] = [
        { taskId: 'T-INV1', requestedDepth: 1, effectiveDepth: 1, pathMode: 'FAST_PATH', changedFilesCount: 1, changedLinesTotal: 10, requiredReviews: { code: true } },
        { taskId: 'T-INV2', requestedDepth: 2, effectiveDepth: 2, pathMode: 'FULL_PATH', changedFilesCount: 5, changedLinesTotal: 200, requiredReviews: { code: true, db: true, security: true } },
        { taskId: 'T-INV3', requestedDepth: 3, effectiveDepth: 3, pathMode: 'FULL_PATH', changedFilesCount: 10, changedLinesTotal: 500, requiredReviews: { code: true, db: true, security: true, refactor: true, test: true, performance: true } }
    ];

    for (const input of configs) {
        const forecast = buildBudgetForecast(input);
        const sumReview = forecast.review_budget_estimates.reduce((s, e) => s + e.estimated_tokens, 0);
        assert.equal(forecast.total_estimated_review_tokens, sumReview, `review sum mismatch for ${input.taskId}`);
        assert.equal(forecast.total_forecast_tokens, sumReview + forecast.compile_gate_estimated_tokens, `total mismatch for ${input.taskId}`);
    }
});
