import test from 'node:test';
import assert from 'node:assert/strict';

import {
    DEFAULT_TOKEN_ESTIMATOR,
    LEGACY_TOKEN_ESTIMATOR,
    estimateTokenCountFromChars,
    estimateTokenCount,
    buildOutputTelemetry,
    coerceIntLike,
    formatVisibleSavingsLine
} from '../../../src/gate-runtime/token-telemetry';

// --- Constants ---

test('DEFAULT_TOKEN_ESTIMATOR is hybrid_text_v1', () => {
    assert.equal(DEFAULT_TOKEN_ESTIMATOR, 'hybrid_text_v1');
});

test('LEGACY_TOKEN_ESTIMATOR is chars_per_4', () => {
    assert.equal(LEGACY_TOKEN_ESTIMATOR, 'chars_per_4');
});

// --- estimateTokenCountFromChars ---

test('estimateTokenCountFromChars returns 0 for zero chars', () => {
    assert.equal(estimateTokenCountFromChars(0), 0);
    assert.equal(estimateTokenCountFromChars(-5), 0);
});

test('estimateTokenCountFromChars chars_per_4 divides by 4', () => {
    assert.equal(estimateTokenCountFromChars(100, { estimator: 'chars_per_4' }), 25);
    assert.equal(estimateTokenCountFromChars(101, { estimator: 'chars_per_4' }), 26); // ceil
});

test('estimateTokenCountFromChars chars_per_3_5 divides by 3.5', () => {
    assert.equal(estimateTokenCountFromChars(7, { estimator: 'chars_per_3_5' }), 2);
    assert.equal(estimateTokenCountFromChars(8, { estimator: 'chars_per_3_5' }), 3); // ceil(8/3.5) = 3
});

test('estimateTokenCountFromChars chars_per_4_5 divides by 4.5', () => {
    assert.equal(estimateTokenCountFromChars(9, { estimator: 'chars_per_4_5' }), 2);
    assert.equal(estimateTokenCountFromChars(10, { estimator: 'chars_per_4_5' }), 3); // ceil(10/4.5) = 3
});

// --- estimateTokenCount ---

test('estimateTokenCount returns 0 for empty input', () => {
    assert.equal(estimateTokenCount([]), 0);
    assert.equal(estimateTokenCount(null), 0);
    assert.equal(estimateTokenCount(''), 0);
});

test('estimateTokenCount legacy mode matches chars_per_4', () => {
    const lines = ['Hello world'];
    const charCount = 11; // "Hello world"
    const expected = Math.ceil(charCount / 4.0);
    assert.equal(estimateTokenCount(lines, { estimator: 'chars_per_4' }), expected);
});

test('estimateTokenCount hybrid mode is >= chars_per_4 estimate', () => {
    const lines = ['function hello() { return 42; }'];
    const legacyEstimate = estimateTokenCount(lines, { estimator: 'chars_per_4' });
    const hybridEstimate = estimateTokenCount(lines, { estimator: 'hybrid_text_v1' });
    assert.ok(hybridEstimate >= legacyEstimate, `hybrid ${hybridEstimate} should be >= legacy ${legacyEstimate}`);
});

test('estimateTokenCount handles string input', () => {
    const result = estimateTokenCount('hello world');
    assert.ok(result > 0);
});

// --- coerceIntLike ---

test('coerceIntLike returns null for null/undefined/boolean', () => {
    assert.equal(coerceIntLike(null), null);
    assert.equal(coerceIntLike(undefined), null);
    assert.equal(coerceIntLike(true), null);
    assert.equal(coerceIntLike(false), null);
});

test('coerceIntLike returns integer for integer', () => {
    assert.equal(coerceIntLike(42), 42);
    assert.equal(coerceIntLike(0), 0);
    assert.equal(coerceIntLike(-5), -5);
});

test('coerceIntLike returns integer for integer-valued float', () => {
    assert.equal(coerceIntLike(42.0), 42);
});

test('coerceIntLike returns null for non-integer float', () => {
    assert.equal(coerceIntLike(42.5), null);
});

test('coerceIntLike parses integer string', () => {
    assert.equal(coerceIntLike('42'), 42);
    assert.equal(coerceIntLike(' -10 '), -10);
});

test('coerceIntLike returns null for non-numeric string', () => {
    assert.equal(coerceIntLike('abc'), null);
    assert.equal(coerceIntLike(''), null);
});

// --- buildOutputTelemetry ---

test('buildOutputTelemetry returns correct shape for identical input/output', () => {
    const raw = ['line 1', 'line 2'];
    const filtered = ['line 1', 'line 2'];
    const result = buildOutputTelemetry(raw, filtered);

    assert.equal(result.raw_line_count, 2);
    assert.equal(result.filtered_line_count, 2);
    assert.equal((result as Record<string, number>).estimated_saved_chars, 0);
    assert.equal((result as Record<string, number>).estimated_saved_tokens, 0);
    assert.equal(result.filter_mode, 'passthrough');
    assert.equal(result.fallback_mode, 'none');
    assert.equal(result.parser_mode, 'NONE');
    assert.equal(result.token_estimator, 'hybrid_text_v1');
    assert.equal(result.legacy_token_estimator, 'chars_per_4');
});

test('buildOutputTelemetry shows savings when output is smaller', () => {
    const raw = ['line 1', 'line 2', 'line 3', 'line 4'];
    const filtered = ['line 1'];
    const result = buildOutputTelemetry(raw, filtered, {
        filterMode: 'profile:test',
        parserMode: 'FULL'
    });

    assert.equal(result.raw_line_count, 4);
    assert.equal(result.filtered_line_count, 1);
    assert.ok((result as Record<string, number>).estimated_saved_chars > 0);
    assert.ok((result as Record<string, number>).estimated_saved_tokens > 0);
    assert.equal(result.filter_mode, 'profile:test');
    assert.equal(result.parser_mode, 'FULL');
});

// --- formatVisibleSavingsLine ---

test('formatVisibleSavingsLine returns null for non-object', () => {
    assert.equal(formatVisibleSavingsLine(null), null);
    assert.equal(formatVisibleSavingsLine('string'), null);
});

test('formatVisibleSavingsLine returns null when no savings', () => {
    const telemetry = {
        estimated_saved_tokens: 0,
        raw_line_count: 10,
        filtered_line_count: 10,
        raw_char_count: 100,
        filtered_char_count: 100
    };
    assert.equal(formatVisibleSavingsLine(telemetry), null);
});

test('formatVisibleSavingsLine formats with percentage when raw estimate available', () => {
    const telemetry = {
        estimated_saved_tokens: 50,
        raw_line_count: 20,
        filtered_line_count: 10,
        raw_char_count: 200,
        filtered_char_count: 100,
        raw_token_count_estimate: 100
    };
    const result = formatVisibleSavingsLine(telemetry);
    assert.match(result!, /^\[token-economy\] saved ~50 tokens \(~50%\)$/);
});

test('formatVisibleSavingsLine uses custom label', () => {
    const telemetry = {
        estimated_saved_tokens: 25,
        raw_line_count: 20,
        filtered_line_count: 10,
        raw_char_count: 200,
        filtered_char_count: 100
    };
    const result = formatVisibleSavingsLine(telemetry, { label: 'custom' });
    assert.match(result!, /^\[custom\] saved ~25 tokens$/);
});

test('formatVisibleSavingsLine returns null when savings below minimum', () => {
    const telemetry = {
        estimated_saved_tokens: 5,
        raw_line_count: 10,
        filtered_line_count: 10, // no line savings
        raw_char_count: 100,
        filtered_char_count: 95 // char savings exist
    };
    assert.equal(formatVisibleSavingsLine(telemetry, { minimumSavedTokens: 10 }), null);
});
