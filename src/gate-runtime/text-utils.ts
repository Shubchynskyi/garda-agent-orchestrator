interface ToStringArrayOptions {
    trimValues?: boolean;
}

/**
 * Convert any value to a string array, matching Python/PS gate_utils.to_string_array.
 */
export function toStringArray(value: unknown, options: ToStringArrayOptions = {}): string[] {
    const trimValues = options.trimValues || false;

    if (value == null) {
        return [];
    }

    if (typeof value === 'string') {
        const text = trimValues ? value.trim() : value;
        return (text && text.trim()) ? [text] : [];
    }

    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if (item == null) {
                continue;
            }
            let text = String(item);
            if (trimValues) {
                text = text.trim();
            }
            if (!text || !text.trim()) {
                continue;
            }
            result.push(text);
        }
        return result;
    }

    const text = trimValues ? String(value).trim() : String(value);
    return (text && text.trim()) ? [text] : [];
}

/**
 * Count total characters of lines joined by newlines, matching Python count_text_chars.
 */
export function countTextChars(lines: unknown): number {
    const normalized = toStringArray(lines);
    if (normalized.length === 0) {
        return 0;
    }
    let total = 0;
    for (const line of normalized) {
        total += line.length;
    }
    total += Math.max(normalized.length - 1, 0);
    return total;
}

interface MatchAnyRegexOptions {
    skipInvalidRegex?: boolean;
    invalidRegexContext?: string;
    caseInsensitive?: boolean;
}

/**
 * Test if a path matches any of the provided regex patterns.
 */
export function matchAnyRegex(pathValue: string, regexes: string[], options: MatchAnyRegexOptions = {}): boolean {
    const skipInvalid = options.skipInvalidRegex || false;
    const context = options.invalidRegexContext || '';
    const flags = options.caseInsensitive ? 'i' : '';

    for (const pattern of regexes) {
        if (!pattern) {
            continue;
        }
        try {
            if (new RegExp(pattern, flags).test(pathValue)) {
                return true;
            }
        } catch (err) {
            if (!skipInvalid) {
                throw err;
            }
            const ctxStr = context ? ` for ${context}` : '';
            process.stderr.write(`WARNING: invalid regex '${pattern}'${ctxStr}: ${err instanceof Error ? err.message : String(err)}\n`);
        }
    }
    return false;
}

