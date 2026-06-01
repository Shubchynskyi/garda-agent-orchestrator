import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import {
    BOOLEAN_FALSE_VALUES,
    BOOLEAN_TRUE_VALUES
} from '../../core/constants';
import { recordToxinMetricsSnapshot } from '../../runtime/toxin-metrics';

export interface ToStringArrayOptions {
    trimValues?: boolean;
}

/**
 * Convert unknown value to a plain object record or null.
 */
export function toPlainRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

/**
 * Parse boolean-like values, matching Python/PS parse_bool.
 */
export function parseBool(value: unknown, defaultValue = false): boolean {
    if (value == null) return !!defaultValue;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (BOOLEAN_TRUE_VALUES.includes(text)) return true;
    if (BOOLEAN_FALSE_VALUES.includes(text)) return false;
    return !!defaultValue;
}

/**
 * SHA-256 hash of a string.
 */
export function stringSha256(value: unknown): string | null {
    if (value == null) return null;
    return crypto.createHash('sha256').update(String(value), 'utf8').digest('hex').toLowerCase();
}

/**
 * SHA-256 hash of a file.
 */
export function fileSha256(filePath: string): string | null {
    if (!filePath) return null;
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return null;
        const content = fs.readFileSync(filePath);
        return crypto.createHash('sha256').update(content).digest('hex').toLowerCase();
    } catch {
        return null;
    }
}

/**
 * Count non-empty lines in a file.
 */
export function countFileLines(filePath: string): number {
    try {
        if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return 0;
        const content = fs.readFileSync(filePath, 'utf8');
        return content.split('\n').filter(line => line.trimEnd() !== '').length;
    } catch {
        return 0;
    }
}

/**
 * Append a JSON line to a metrics file.
 */
export function appendMetricsEvent(
    metricsPath: string,
    eventObject: Record<string, unknown>,
    emitMetrics: boolean,
    repoRoot?: string
): void {
    if (!emitMetrics || !metricsPath) return;
    const resolvedMetricsPath = String(metricsPath);
    try {
        fs.mkdirSync(path.dirname(resolvedMetricsPath), { recursive: true });
        fs.appendFileSync(resolvedMetricsPath, JSON.stringify(eventObject) + '\n', 'utf8');
    } catch {
        // metrics are best-effort
        return;
    }
    if (!repoRoot) {
        return;
    }
    try {
        recordToxinMetricsSnapshot(repoRoot, { metricsPath: resolvedMetricsPath });
    } catch {
        // toxin metrics are best-effort
    }
}

/**
 * Convert value(s) to a flat string array, matching gate_utils.to_string_array.
 */
export function toStringArray(value: unknown, options: ToStringArrayOptions = {}): string[] {
    const trimValues = options.trimValues || false;
    if (value == null) return [];
    if (typeof value === 'string') {
        const text = trimValues ? value.trim() : value;
        return (text && text.trim()) ? [text] : [];
    }
    if (Array.isArray(value)) {
        const result = [];
        for (const item of value) {
            if (item == null) continue;
            let text = String(item);
            if (trimValues) text = text.trim();
            if (!text || !text.trim()) continue;
            result.push(text);
        }
        return result;
    }
    const text = trimValues ? String(value).trim() : String(value);
    return (text && text.trim()) ? [text] : [];
}
