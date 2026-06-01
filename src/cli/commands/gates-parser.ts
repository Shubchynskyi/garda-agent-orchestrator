import type { RulePackStageLabel } from '../../gates/rule-pack/rule-pack';
import * as gateHelpers from '../../gates/shared/helpers';

export interface ExpandValueListOptions {
    splitDelimiters?: boolean;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function toStringArray(value: unknown, options: gateHelpers.ToStringArrayOptions = {}): string[] {
    return gateHelpers.toStringArray(value, options);
}

export function parseJsonOption(value: unknown, label: string): unknown {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${getErrorMessage(error)}`);
    }
}

export function parseIntOption(value: unknown, fallback: number, minimum = 0): number {
    if (value == null || String(value).trim() === '') {
        return fallback;
    }
    const parsed = Number.parseInt(String(value).trim(), 10);
    if (!Number.isInteger(parsed) || parsed < minimum) {
        throw new Error(`Expected integer >= ${minimum}, got '${value}'.`);
    }
    return parsed;
}

export function parseBooleanOption(value: unknown, fallback: boolean): boolean {
    if (value == null || String(value).trim() === '') {
        return fallback;
    }
    return gateHelpers.parseBool(value, fallback);
}

export function expandValueList(value: unknown, options: ExpandValueListOptions = {}): string[] {
    const splitDelimiters = options.splitDelimiters || false;
    const values: string[] = [];
    for (const item of toStringArray(value)) {
        if (!splitDelimiters) {
            values.push(String(item).trim());
            continue;
        }
        for (const part of String(item).split(/[\r\n,;]+/)) {
            const trimmed = part.trim();
            if (trimmed) {
                values.push(trimmed);
            }
        }
    }
    return [...new Set(values.filter(Boolean))];
}

export function normalizeRulePackStage(value: unknown): RulePackStageLabel {
    const rawValue = String(value || '').trim();
    if (!rawValue) {
        return 'TASK_ENTRY';
    }
    const normalized = rawValue.toLowerCase().replace(/[\s-]+/g, '_');
    switch (normalized) {
        case 'task_entry':
        case 'entry':
            return 'TASK_ENTRY';
        case 'post_preflight':
        case 'preflight':
        case 'post_classify':
            return 'POST_PREFLIGHT';
        default:
            throw new Error('Stage must be one of: TASK_ENTRY, POST_PREFLIGHT. Supported aliases: entry, preflight.');
    }
}
