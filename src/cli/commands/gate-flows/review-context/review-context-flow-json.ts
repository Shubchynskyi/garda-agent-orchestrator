import * as fs from 'node:fs';

import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    normalizeReceiptSha256
} from '../../../../gates/review-reuse/review-reuse-validation';

export function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function normalizeLowerText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function normalizeOptionalSha256(value: unknown): string | null {
    return normalizeReceiptSha256(value);
}

export function normalizeOptionalPath(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? gateHelpers.normalizePath(text).toLowerCase() : null;
}

export function readJsonRecord(pathToRead: string): Record<string, unknown> | null {
    if (!fs.existsSync(pathToRead) || !fs.statSync(pathToRead).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(pathToRead, 'utf8')) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

export function getReviewTreeStateSha256FromContext(reviewContext: Record<string, unknown>): string | null {
    if (!isRecord(reviewContext.tree_state)) {
        return null;
    }
    const normalized = String(
        reviewContext.tree_state.tree_state_sha256
        || reviewContext.tree_state.treeStateSha256
        || ''
    ).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

export function getRuleContextArtifactPathFromContext(reviewContext: Record<string, unknown>): string | null {
    if (!isRecord(reviewContext.rule_context)) {
        return null;
    }
    const artifactPath = String(
        reviewContext.rule_context.artifact_path
        || reviewContext.rule_context.artifactPath
        || ''
    ).trim();
    return artifactPath || null;
}

export function getTokenEconomyActiveFromContext(reviewContext: Record<string, unknown>): boolean {
    if (typeof reviewContext.token_economy_active === 'boolean') {
        return reviewContext.token_economy_active;
    }
    if (isRecord(reviewContext.token_economy) && typeof reviewContext.token_economy.active === 'boolean') {
        return reviewContext.token_economy.active;
    }
    return false;
}

export function getScopedDiffMetadata(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    if (!isRecord(reviewContext.scoped_diff) || !isRecord(reviewContext.scoped_diff.metadata)) {
        return null;
    }
    return reviewContext.scoped_diff.metadata;
}

export function hasFullDiffFallbackScopedDiff(reviewContext: Record<string, unknown>): boolean {
    const metadata = getScopedDiffMetadata(reviewContext);
    return metadata?.fallback_to_full_diff === true;
}
