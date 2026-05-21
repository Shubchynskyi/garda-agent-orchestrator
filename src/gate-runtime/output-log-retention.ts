import { stringSha256 } from './hash';

export type RawOutputRetentionReason = 'FULL_OUTPUT_RETAINED' | 'SUCCESS_LOG_OMITTED';

export interface RawOutputRetentionEvidence {
    raw_output_retained: boolean;
    retention_reason: RawOutputRetentionReason;
    raw_output_sha256: string | null;
    raw_output_line_count: number;
    raw_output_char_count: number;
}

export function serializeCapturedOutputLines(lines: string[]): string {
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function buildRawOutputRetentionEvidence(
    rawOutputText: string,
    rawOutputRetained: boolean
): RawOutputRetentionEvidence {
    const normalizedText = String(rawOutputText || '');
    const rawLineCount = normalizedText.length === 0
        ? 0
        : normalizedText
            .replace(/\r\n/g, '\n')
            .replace(/\n$/u, '')
            .split('\n')
            .length;
    return {
        raw_output_retained: rawOutputRetained,
        retention_reason: rawOutputRetained ? 'FULL_OUTPUT_RETAINED' : 'SUCCESS_LOG_OMITTED',
        raw_output_sha256: normalizedText.length > 0 ? stringSha256(normalizedText) : null,
        raw_output_line_count: rawLineCount,
        raw_output_char_count: normalizedText.length
    };
}
