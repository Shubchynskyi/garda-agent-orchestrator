import { toStringArray } from '../text-utils';
import { AddUniqueLinesOptions, ResolveFilterStrOptions, SelectMatchingLinesOptions } from './types';

export function asRecord(value: unknown): Record<string, unknown> | null {
    if (!value || typeof value !== 'object') {
        return null;
    }
    return value as Record<string, unknown>;
}

/**
 * Resolve a context-lookup integer value, matching Python _resolve_filter_int.
 */
export function resolveFilterInt(
    value: unknown,
    context: Record<string, unknown> | null | undefined,
    fieldName: string,
    minimum: number = 0
): number {
    let resolvedValue: unknown = value;
    if (
        resolvedValue
        && typeof resolvedValue === 'object'
        && 'context_key' in resolvedValue
        && typeof resolvedValue.context_key === 'string'
        && resolvedValue.context_key.trim()
    ) {
        const contextKey = resolvedValue.context_key.trim();
        if (!context || typeof context !== 'object' || !(contextKey in context)) {
            throw new Error(`${fieldName} references missing context key '${contextKey}'.`);
        }
        resolvedValue = context[contextKey];
    }

    if (typeof resolvedValue === 'boolean') {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    let result: number;
    if (typeof resolvedValue === 'number' && Number.isInteger(resolvedValue)) {
        result = resolvedValue;
    } else if (typeof resolvedValue === 'number' && Number.isFinite(resolvedValue) && resolvedValue === Math.floor(resolvedValue)) {
        result = Math.floor(resolvedValue);
    } else if (typeof resolvedValue === 'string' && /^\s*-?\d+\s*$/.test(resolvedValue.trim())) {
        result = parseInt(resolvedValue.trim(), 10);
    } else {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    if (result < minimum) {
        throw new Error(`${fieldName} must resolve to integer >= ${minimum}.`);
    }
    return result;
}

/**
 * Resolve a context-lookup string value, matching Python _resolve_filter_str.
 */
export function resolveFilterStr(
    value: unknown,
    context: Record<string, unknown> | null | undefined,
    fieldName: string,
    options: ResolveFilterStrOptions = {}
): string {
    const allowEmpty = options.allowEmpty || false;
    let resolvedValue: unknown = value;
    if (
        resolvedValue
        && typeof resolvedValue === 'object'
        && 'context_key' in resolvedValue
        && typeof resolvedValue.context_key === 'string'
        && resolvedValue.context_key.trim()
    ) {
        const contextKey = resolvedValue.context_key.trim();
        if (!context || typeof context !== 'object' || !(contextKey in context)) {
            throw new Error(`${fieldName} references missing context key '${contextKey}'.`);
        }
        resolvedValue = context[contextKey];
    }

    if (resolvedValue == null) {
        if (allowEmpty) {
            return '';
        }
        throw new Error(`${fieldName} must resolve to non-empty string.`);
    }

    const text = String(resolvedValue).trim();
    if (!text && !allowEmpty) {
        throw new Error(`${fieldName} must resolve to non-empty string.`);
    }
    return text;
}

/**
 * Get filter patterns from operation config, matching Python _get_filter_patterns.
 */
export function getFilterPatterns(operation: Record<string, unknown>): string[] {
    const patternsValue = operation.patterns || operation.pattern;
    const patterns = toStringArray(patternsValue, { trimValues: true });
    if (patterns.length === 0) {
        throw new Error("Filter operation requires non-empty `pattern` or `patterns`.");
    }
    for (const pattern of patterns) {
        new RegExp(pattern); // validate
    }
    return patterns;
}

export function selectHeadLines(lines: string[], count: number): string[] {
    if (count <= 0) return [];
    return lines.slice(0, count);
}

export function selectTailLines(lines: string[], count: number): string[] {
    if (count <= 0) return [];
    return lines.slice(-count);
}

export function addUniqueLines(
    destination: string[],
    seen: Set<string>,
    lines: unknown,
    options: AddUniqueLinesOptions = {}
): void {
    const limit = options.limit || 0;
    for (const lineValue of toStringArray(lines)) {
        const lineText = String(lineValue);
        if (!lineText.trim() || seen.has(lineText)) {
            continue;
        }
        destination.push(lineText);
        seen.add(lineText);
        if (limit > 0 && destination.length >= limit) {
            break;
        }
    }
}

export function selectMatchingLines(
    lines: string[],
    patterns: string[],
    options: SelectMatchingLinesOptions = {}
): string[] {
    const limit = options.limit || 0;
    const compiledPatterns = patterns.map((pattern) => new RegExp(pattern));
    const matches: string[] = [];
    for (const line of lines) {
        if (compiledPatterns.some((pattern) => pattern.test(line))) {
            matches.push(line);
            if (limit > 0 && matches.length >= limit) {
                break;
            }
        }
    }
    return matches;
}
