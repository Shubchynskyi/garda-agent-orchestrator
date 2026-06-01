import * as gateHelpers from '../../../gates/helpers';

export function normalizeChangedFiles(values: readonly unknown[]): string[] {
    return [...new Set(values.map((entry) => gateHelpers.normalizePath(String(entry || '').trim())).filter(Boolean))].sort();
}
