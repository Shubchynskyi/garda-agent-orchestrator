import * as path from 'node:path';

import { normalizePath } from '../../../../gates/shared/helpers';

export function getObjectField(record: Record<string, unknown>, key: string): Record<string, unknown> | null {
    const value = record[key];
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

export function getStringField(record: Record<string, unknown>, ...keys: string[]): string {
    for (const key of keys) {
        const value = record[key];
        if (value == null) {
            continue;
        }
        const text = String(value).trim();
        if (text) {
            return text;
        }
    }
    return '';
}

export function toReviewerHandoffAbsolutePath(repoRoot: string, artifactPath: string): string {
    const trimmedPath = String(artifactPath || '').trim();
    if (!trimmedPath) {
        return '';
    }
    return normalizePath(path.isAbsolute(trimmedPath) ? trimmedPath : path.resolve(repoRoot, trimmedPath));
}
