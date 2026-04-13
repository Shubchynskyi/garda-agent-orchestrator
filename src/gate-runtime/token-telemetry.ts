import { toStringArray, countTextChars } from './text-utils';

export const DEFAULT_TOKEN_ESTIMATOR = 'hybrid_text_v1';
export const LEGACY_TOKEN_ESTIMATOR = 'chars_per_4';
export const TOKENISH_UNIT_PATTERN = /[A-Za-z]+(?:'[A-Za-z]+)?|[0-9]+|[^\w\s]/gu;

interface TokenEstimatorOptions {
    estimator?: string;
}

/**
 * Estimate token count from character count using a simple divisor.
 */
export function estimateTokenCountFromChars(charCount: number, options: TokenEstimatorOptions = {}): number {
    const estimator = options.estimator || LEGACY_TOKEN_ESTIMATOR;
    if (charCount <= 0) {
        return 0;
    }
    if (estimator === 'chars_per_3_5') {
        return Math.ceil(charCount / 3.5);
    }
    if (estimator === 'chars_per_4_5') {
        return Math.ceil(charCount / 4.5);
    }
    return Math.ceil(charCount / 4.0);
}

/**
 * Estimate token count for structured gate text.
 * hybrid_text_v1 supplements chars_per_4 with a tokenish unit count
 * so code/log heavy text does not look artificially cheap.
 */
export function estimateTokenCount(lines: unknown, options: TokenEstimatorOptions = {}): number {
    const estimator = options.estimator || DEFAULT_TOKEN_ESTIMATOR;
    const normalizedLines = toStringArray(lines);
    const charCount = countTextChars(normalizedLines);
    if (charCount <= 0) {
        return 0;
    }

    if (['chars_per_4', 'chars_per_3_5', 'chars_per_4_5'].includes(estimator)) {
        return estimateTokenCountFromChars(charCount, { estimator });
    }

    const text = normalizedLines.join('\n');
    const baseEstimate = estimateTokenCountFromChars(charCount, { estimator: LEGACY_TOKEN_ESTIMATOR });
    const matches = text.match(TOKENISH_UNIT_PATTERN);
    const tokenishUnitCount = matches ? matches.length : 0;
    if (tokenishUnitCount <= 0) {
        return baseEstimate;
    }

    const hybridEstimate = Math.ceil((baseEstimate + tokenishUnitCount) / 2.0);
    return Math.max(baseEstimate, hybridEstimate);
}

interface BuildOutputTelemetryOptions {
    filterMode?: string;
    fallbackMode?: string;
    parserMode?: string;
    parserName?: string;
    parserStrategy?: string;
    tokenEstimator?: string;
}

/**
 * Build output telemetry for filtered output, matching Python build_output_telemetry.
 */
export function buildOutputTelemetry(rawLines: unknown, filteredLines: unknown, options: BuildOutputTelemetryOptions = {}): Record<string, unknown> {
    const filterMode = options.filterMode || 'passthrough';
    const fallbackMode = options.fallbackMode || 'none';
    const parserMode = options.parserMode || 'NONE';
    const parserName = options.parserName || '';
    const parserStrategy = options.parserStrategy || '';
    const tokenEstimator = options.tokenEstimator || DEFAULT_TOKEN_ESTIMATOR;

    const rawLineList = toStringArray(rawLines);
    const filteredLineList = toStringArray(filteredLines);
    const rawCharCount = countTextChars(rawLineList);
    const filteredCharCount = countTextChars(filteredLineList);
    const estimatedSavedChars = Math.max(rawCharCount - filteredCharCount, 0);
    const rawTokenEstimate = estimateTokenCount(rawLineList, { estimator: tokenEstimator });
    const filteredTokenEstimate = estimateTokenCount(filteredLineList, { estimator: tokenEstimator });
    const estimatedSavedTokens = Math.max(rawTokenEstimate - filteredTokenEstimate, 0);
    const legacyRawTokenEstimate = estimateTokenCount(rawLineList, { estimator: LEGACY_TOKEN_ESTIMATOR });
    const legacyFilteredTokenEstimate = estimateTokenCount(filteredLineList, { estimator: LEGACY_TOKEN_ESTIMATOR });
    const legacyEstimatedSavedTokens = Math.max(legacyRawTokenEstimate - legacyFilteredTokenEstimate, 0);

    return {
        raw_line_count: rawLineList.length,
        raw_char_count: rawCharCount,
        raw_token_count_estimate: rawTokenEstimate,
        filtered_line_count: filteredLineList.length,
        filtered_char_count: filteredCharCount,
        filtered_token_count_estimate: filteredTokenEstimate,
        estimated_saved_chars: estimatedSavedChars,
        estimated_saved_tokens: estimatedSavedTokens,
        estimated_saved_tokens_chars_per_4: legacyEstimatedSavedTokens,
        token_estimator: tokenEstimator,
        legacy_token_estimator: LEGACY_TOKEN_ESTIMATOR,
        filter_mode: (String(filterMode).trim() || 'passthrough'),
        fallback_mode: (String(fallbackMode).trim() || 'none'),
        parser_mode: (String(parserMode).trim().toUpperCase() || 'NONE'),
        parser_name: (String(parserName).trim() || null),
        parser_strategy: (String(parserStrategy).trim() || null)
    };
}

/**
 * Coerce a value to an integer or return null, matching Python _coerce_int_like.
 */
export function coerceIntLike(value: unknown): number | null {
    if (value == null || typeof value === 'boolean') {
        return null;
    }
    if (typeof value === 'number') {
        if (Number.isFinite(value) && Number.isInteger(value)) {
            return value;
        }
        if (Number.isFinite(value) && value === Math.floor(value)) {
            return Math.floor(value);
        }
        return null;
    }
    if (typeof value === 'string') {
        const trimmed = value.trim();
        if (/^\s*-?\d+\s*$/.test(trimmed)) {
            return parseInt(trimmed, 10);
        }
    }
    return null;
}

interface OutputTelemetryRecord {
    estimated_saved_tokens?: unknown;
    raw_line_count?: unknown;
    filtered_line_count?: unknown;
    raw_char_count?: unknown;
    filtered_char_count?: unknown;
    raw_token_count_estimate?: unknown;
}

interface FormatVisibleSavingsOptions {
    label?: string;
    minimumSavedTokens?: number;
}

/**
 * Format a human-readable savings line, matching Python format_visible_savings_line.
 */
export function formatVisibleSavingsLine(telemetry: unknown, options: FormatVisibleSavingsOptions = {}): string | null {
    const label = options.label || 'token-economy';
    const minimumSavedTokens = options.minimumSavedTokens != null ? options.minimumSavedTokens : 10;

    if (!telemetry || typeof telemetry !== 'object') {
        return null;
    }

    const tel = telemetry as Record<string, unknown>;
    const savedTokens = coerceIntLike(tel.estimated_saved_tokens);
    const rawLineCount = coerceIntLike(tel.raw_line_count);
    const filteredLineCount = coerceIntLike(tel.filtered_line_count);
    const rawCharCount = coerceIntLike(tel.raw_char_count);
    const filteredCharCount = coerceIntLike(tel.filtered_char_count);
    const rawTokenEstimate = coerceIntLike(tel.raw_token_count_estimate);

    if (savedTokens === null || rawLineCount === null || filteredLineCount === null || rawCharCount === null || filteredCharCount === null) {
        return null;
    }
    if (savedTokens <= 0) {
        return null;
    }

    const lineSavings = rawLineCount - filteredLineCount;
    const charSavings = rawCharCount - filteredCharCount;
    if (lineSavings <= 0 && charSavings <= 0) {
        return null;
    }

    const resolvedLabel = (label || '').trim() || 'token-economy';
    if (lineSavings <= 0 && savedTokens < Math.max(minimumSavedTokens, 0)) {
        return null;
    }

    if (rawTokenEstimate != null && rawTokenEstimate > 0) {
        const savedPercent = Math.round((savedTokens * 100.0) / rawTokenEstimate);
        return `[${resolvedLabel}] saved ~${savedTokens} tokens (~${savedPercent}%)`;
    }

    return `[${resolvedLabel}] saved ~${savedTokens} tokens`;
}

