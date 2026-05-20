export interface OutputCompactionContributionLike {
    label: string;
    estimated_saved_chars: number;
    estimated_saved_tokens: number;
    raw_char_count: number;
    output_char_count: number | null;
    raw_token_count_estimate: number;
    output_token_count_estimate?: number | null;
}

export interface OutputCompactionAggregateSummary {
    total_estimated_saved_chars: number;
    total_raw_char_count: number;
    total_output_char_count: number;
    total_estimated_saved_tokens: number;
    total_raw_token_count_estimate: number;
    total_output_token_count_estimate: number;
    chars_savings_percent: number | null;
    savings_percent: number | null;
    baseline_known: boolean;
    char_baseline_known: boolean;
    measurable_part_count: number;
    visible_summary_line: string | null;
}

export const CANONICAL_REVIEW_CONTEXT_TYPES = Object.freeze([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
] as const);

const REVIEW_CONTEXT_LABELS = Object.freeze({
    code: 'code review context',
    db: 'DB review context',
    security: 'security review context',
    refactor: 'refactor review context',
    api: 'API review context',
    test: 'test review context',
    performance: 'performance review context',
    infra: 'infra review context',
    dependency: 'dependency review context'
});

export function getReviewContextOutputLabel(reviewType: string): string {
    const normalized = String(reviewType || '').trim().toLowerCase();
    return (REVIEW_CONTEXT_LABELS as Record<string, string>)[normalized] || 'review context';
}

export function getGateOutputCompactionLabel(eventType: string): string {
    const normalized = String(eventType || '').trim().toUpperCase();
    if (normalized.startsWith('COMPILE_GATE_')) return 'compile gate output';
    if (normalized.startsWith('REVIEW_GATE_')) return 'review gate output';
    if (normalized.startsWith('FULL_SUITE_VALIDATION_')) return 'full-suite validation output';
    return 'gate output';
}

function formatContributionSummaryPart(item: OutputCompactionContributionLike): string {
    if ((item.estimated_saved_chars || 0) > 0) {
        return `${item.label} ~${item.estimated_saved_chars} chars`;
    }
    return `${item.label} suppressed output estimate ~${item.estimated_saved_tokens} tokens`;
}

export function summarizeOutputCompactionBreakdown<T extends OutputCompactionContributionLike>(
    breakdown: ReadonlyArray<T>
): OutputCompactionAggregateSummary {
    const totalSavedChars = breakdown.reduce((total, item) => total + (item.estimated_saved_chars || 0), 0);
    const totalRawChars = breakdown.reduce((total, item) => total + (item.raw_char_count || 0), 0);
    const totalOutputChars = breakdown.reduce((total, item) => total + (item.output_char_count != null ? item.output_char_count : 0), 0);
    const totalSavedTokens = breakdown.reduce((total, item) => total + (item.estimated_saved_tokens || 0), 0);
    const totalRawTokens = breakdown.reduce((total, item) => total + (item.raw_token_count_estimate || 0), 0);
    const totalOutputTokens = breakdown.reduce((total, item) => total + (item.output_token_count_estimate != null ? item.output_token_count_estimate : 0), 0);
    const baselineKnown = breakdown.length > 0 && breakdown.every((item) => (item.raw_token_count_estimate || 0) > 0);
    const charBaselineKnown = breakdown.length > 0 && breakdown.every((item) => (item.raw_char_count || 0) > 0);
    const hasTokenOnlyContributions = breakdown.some((item) => (item.estimated_saved_chars || 0) <= 0 && (item.estimated_saved_tokens || 0) > 0);
    const hasCharAwareContributions = breakdown.some((item) => (item.estimated_saved_chars || 0) > 0);
    const charAwareSubsetOnly = hasCharAwareContributions && hasTokenOnlyContributions;
    const savingsPercent = baselineKnown && totalRawTokens > 0 ? Math.round((totalSavedTokens * 100.0) / totalRawTokens) : null;
    const charsSavingsPercent = charBaselineKnown && totalRawChars > 0 ? Math.round((totalSavedChars * 100.0) / totalRawChars) : null;

    let visibleSummaryLine: string | null = null;
    if (totalSavedChars > 0 && breakdown.length > 0) {
        const parts = breakdown.map((item) => formatContributionSummaryPart(item)).join(' + ');
        const tokenNote = totalSavedTokens > 0 ? ` Suppressed output estimate: ~${totalSavedTokens} tokens.` : '';
        const prefix = charAwareSubsetOnly
            ? 'Suppressed output (char-aware subset)'
            : 'Suppressed output';
        if (charsSavingsPercent != null) {
            visibleSummaryLine = `${prefix}: ~${totalSavedChars} chars (~${charsSavingsPercent}%) (${parts}).${tokenNote}`;
        } else {
            visibleSummaryLine = `${prefix}: ~${totalSavedChars} chars (${parts}).${tokenNote}`;
        }
    } else if (totalSavedTokens > 0 && breakdown.length > 0) {
        const parts = breakdown.map((item) => `${item.label} suppressed output estimate ~${item.estimated_saved_tokens} tokens`).join(' + ');
        if (savingsPercent != null) {
            visibleSummaryLine = `Suppressed output estimate: ~${totalSavedTokens} tokens (~${savingsPercent}%) (${parts}).`;
        } else {
            visibleSummaryLine = `Suppressed output estimate: ~${totalSavedTokens} tokens (${parts}).`;
        }
    }

    return {
        total_estimated_saved_chars: totalSavedChars,
        total_raw_char_count: totalRawChars,
        total_output_char_count: totalOutputChars,
        total_estimated_saved_tokens: totalSavedTokens,
        total_raw_token_count_estimate: totalRawTokens,
        total_output_token_count_estimate: totalOutputTokens,
        chars_savings_percent: charsSavingsPercent,
        savings_percent: savingsPercent,
        baseline_known: baselineKnown,
        char_baseline_known: charBaselineKnown,
        measurable_part_count: breakdown.length,
        visible_summary_line: visibleSummaryLine
    };
}

export function isOutputCompactionSummaryLine(line: string): boolean {
    const trimmed = String(line || '').trimStart();
    return /^Suppressed output(?: \(char-aware subset\))?:/.test(trimmed)
        || /^Suppressed output estimate:/.test(trimmed)
        || /^Token estimate:/.test(trimmed);
}
