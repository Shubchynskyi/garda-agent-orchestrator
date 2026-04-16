import * as path from 'node:path';

import {
    classifyScopeCategory,
    getClassificationConfig
} from './classify-change';
import { normalizePath } from './helpers';

type ClassificationConfigRecord = ReturnType<typeof getClassificationConfig>;

const classificationConfigCache = new Map<string, ClassificationConfigRecord>();

function getCachedClassificationConfig(repoRoot: string): ClassificationConfigRecord {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const cached = classificationConfigCache.get(resolvedRepoRoot);
    if (cached) {
        return cached;
    }
    const loaded = getClassificationConfig(resolvedRepoRoot);
    classificationConfigCache.set(resolvedRepoRoot, loaded);
    return loaded;
}

export function preflightRequiresAnyReview(preflight: Record<string, unknown> | null): boolean {
    if (!preflight) return false;
    const requiredReviews = preflight.required_reviews;
    if (requiredReviews && typeof requiredReviews === 'object' && !Array.isArray(requiredReviews)) {
        for (const value of Object.values(requiredReviews)) {
            if (value === true) {
                return true;
            }
        }
    }
    return false;
}

export function detectCodeChanged(preflight: Record<string, unknown> | null, repoRoot = '.'): boolean {
    if (!preflight) return false;
    const metrics = preflight.metrics as Record<string, unknown> | undefined;
    const runtimeCodeLikeChangedCount = metrics?.runtime_code_like_changed_count;
    if (typeof runtimeCodeLikeChangedCount === 'number' && runtimeCodeLikeChangedCount > 0) {
        return true;
    }
    const codeLikeChangedCount = metrics?.code_like_changed_count;
    if (typeof codeLikeChangedCount === 'number' && codeLikeChangedCount > 0) {
        return true;
    }

    if (preflightRequiresAnyReview(preflight)) {
        return true;
    }

    const triggers = preflight.triggers;
    if (triggers && typeof triggers === 'object' && !Array.isArray(triggers)) {
        const triggerRecord = triggers as Record<string, unknown>;
        if (triggerRecord.runtime_code_changed === true) {
            return true;
        }
    }

    const scopeCategory = typeof preflight.scope_category === 'string'
        ? preflight.scope_category.trim().toLowerCase()
        : '';
    if (scopeCategory === 'code' || scopeCategory === 'mixed') {
        return true;
    }
    if (scopeCategory === 'docs-only'
        || scopeCategory === 'config-only'
        || scopeCategory === 'audit-only'
        || scopeCategory === 'empty') {
        return false;
    }

    const changedFiles = Array.isArray(preflight.changed_files)
        ? preflight.changed_files
            .map((value) => normalizePath(String(value || '')).replace(/^[A-Za-z]:/i, ''))
            .filter((value) => value.length > 0)
        : [];
    if (changedFiles.length > 0) {
        const classificationConfig = getCachedClassificationConfig(repoRoot);
        const fallbackScope = classifyScopeCategory(
            changedFiles,
            classificationConfig.code_like_regexes,
            classificationConfig.runtime_roots
        ).category;
        if (fallbackScope === 'docs-only'
            || fallbackScope === 'config-only'
            || fallbackScope === 'audit-only'
            || fallbackScope === 'empty') {
            return false;
        }
        if (fallbackScope === 'code' || fallbackScope === 'mixed') {
            return true;
        }
    }

    const changedLinesTotal = metrics?.changed_lines_total;
    if (typeof changedLinesTotal === 'number' && changedLinesTotal > 0) {
        return true;
    }
    if (changedFiles.length > 0) {
        return true;
    }

    return false;
}
