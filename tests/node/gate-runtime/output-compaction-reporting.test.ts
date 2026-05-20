import test from 'node:test';
import assert from 'node:assert/strict';

import {
    CANONICAL_REVIEW_CONTEXT_TYPES,
    isOutputCompactionSummaryLine,
    summarizeOutputCompactionBreakdown,
    type OutputCompactionContributionLike
} from '../../../src/gate-runtime/output-compaction-reporting';

function makeContribution(
    overrides: Partial<OutputCompactionContributionLike>
): OutputCompactionContributionLike {
    return {
        label: 'compile gate output',
        estimated_saved_chars: 0,
        estimated_saved_tokens: 0,
        raw_char_count: 0,
        output_char_count: 0,
        raw_token_count_estimate: 0,
        output_token_count_estimate: 0,
        ...overrides
    };
}

test('summarizeOutputCompactionBreakdown marks char-aware subset when mixed legacy token-only contributions remain', () => {
    const summary = summarizeOutputCompactionBreakdown([
        makeContribution({
            label: 'compile gate output',
            estimated_saved_chars: 120,
            estimated_saved_tokens: 30,
            raw_char_count: 200,
            output_char_count: 80,
            raw_token_count_estimate: 50,
            output_token_count_estimate: 20
        }),
        makeContribution({
            label: 'legacy review gate output',
            estimated_saved_chars: 0,
            estimated_saved_tokens: 15,
            raw_char_count: 0,
            output_char_count: 0,
            raw_token_count_estimate: 25,
            output_token_count_estimate: 10
        })
    ]);

    assert.equal(summary.total_estimated_saved_chars, 120);
    assert.equal(summary.total_estimated_saved_tokens, 45);
    assert.equal(summary.chars_savings_percent, null);
    assert.equal(summary.savings_percent, 60);
    assert.equal(
        summary.visible_summary_line,
        'Suppressed output (char-aware subset): ~120 chars (compile gate output ~120 chars + legacy review gate output suppressed output estimate ~15 tokens). Suppressed output estimate: ~45 tokens.'
    );
});

test('summarizeOutputCompactionBreakdown keeps char summary percent when char baseline is known', () => {
    const summary = summarizeOutputCompactionBreakdown([
        makeContribution({
            estimated_saved_chars: 160,
            estimated_saved_tokens: 40,
            raw_char_count: 200,
            output_char_count: 40,
            raw_token_count_estimate: 50,
            output_token_count_estimate: 10
        })
    ]);

    assert.equal(summary.char_baseline_known, true);
    assert.equal(summary.chars_savings_percent, 80);
    assert.equal(
        summary.visible_summary_line,
        'Suppressed output: ~160 chars (~80%) (compile gate output ~160 chars). Suppressed output estimate: ~40 tokens.'
    );
});

test('summarizeOutputCompactionBreakdown falls back to token-only wording when char savings are unavailable', () => {
    const summary = summarizeOutputCompactionBreakdown([
        makeContribution({
            estimated_saved_tokens: 33,
            raw_token_count_estimate: 50,
            output_token_count_estimate: 17
        })
    ]);

    assert.equal(summary.total_estimated_saved_chars, 0);
    assert.equal(summary.total_estimated_saved_tokens, 33);
    assert.equal(summary.savings_percent, 66);
    assert.equal(
        summary.visible_summary_line,
        'Suppressed output estimate: ~33 tokens (~66%) (compile gate output suppressed output estimate ~33 tokens).'
    );
});

test('summarizeOutputCompactionBreakdown omits percentages when baselines are unknown', () => {
    const summary = summarizeOutputCompactionBreakdown([
        makeContribution({
            estimated_saved_chars: 80,
            estimated_saved_tokens: 20,
            raw_char_count: 0,
            output_char_count: null,
            raw_token_count_estimate: 0,
            output_token_count_estimate: null
        })
    ]);

    assert.equal(summary.char_baseline_known, false);
    assert.equal(summary.baseline_known, false);
    assert.equal(
        summary.visible_summary_line,
        'Suppressed output: ~80 chars (compile gate output ~80 chars). Suppressed output estimate: ~20 tokens.'
    );
});

test('isOutputCompactionSummaryLine accepts standard, subset, and token-only summaries', () => {
    assert.equal(
        isOutputCompactionSummaryLine('Suppressed output: ~160 chars (~80%) (compile gate output ~160 chars). Suppressed output estimate: ~40 tokens.'),
        true
    );
    assert.equal(
        isOutputCompactionSummaryLine('  Suppressed output (char-aware subset): ~120 chars (compile gate output ~120 chars + legacy review gate output suppressed output estimate ~15 tokens). Suppressed output estimate: ~45 tokens.'),
        true
    );
    assert.equal(
        isOutputCompactionSummaryLine(' Suppressed output estimate: ~33 tokens (~66%) (compile gate output suppressed output estimate ~33 tokens).'),
        true
    );
    assert.equal(
        isOutputCompactionSummaryLine(' Token estimate: ~33 (~66%) (compile gate output ~33 tokens).'),
        true
    );
    assert.equal(isOutputCompactionSummaryLine('compile gate output: ok'), false);
});

test('CANONICAL_REVIEW_CONTEXT_TYPES stays aligned with the shared review context labels', () => {
    assert.deepEqual(CANONICAL_REVIEW_CONTEXT_TYPES, [
        'code',
        'db',
        'security',
        'refactor',
        'api',
        'test',
        'performance',
        'infra',
        'dependency'
    ]);
});
