const QUALITY_BASELINE_VERSION_PATTERN = /^(\d{4})-(\d{2})-(\d{2})(?:\.t(\d+))?$/iu;

export function formatQualityRulePackVersion(value: string | null | undefined): string {
    const text = String(value || '').trim();
    if (!text) {
        return '-';
    }
    const match = QUALITY_BASELINE_VERSION_PATTERN.exec(text);
    if (!match) {
        return text;
    }
    const [, year, month, day, taskNumber] = match;
    const taskSuffix = taskNumber ? ` (T-${taskNumber})` : '';
    return `${year}-${month}-${day}${taskSuffix}`;
}
