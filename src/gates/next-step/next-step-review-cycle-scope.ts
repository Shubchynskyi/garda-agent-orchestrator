import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';

export type { DomainScopeFingerprints };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeReviewCycleScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getTimelineReviewScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.review_scope_sha256 ?? details?.reviewScopeSha256);
}

function getTimelineCodeScopeHash(details: Record<string, unknown> | null): string | null {
    return normalizeReviewCycleScopeHash(details?.code_scope_sha256 ?? details?.codeScopeSha256);
}

export function readCurrentReviewCyclePreflightFingerprints(
    eventsRoot: string,
    taskId: string
): DomainScopeFingerprints | null {
    const preflightPath = path.resolve(eventsRoot, '..', 'reviews', `${taskId}-preflight.json`);
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        return null;
    }
    try {
        const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const metrics = isPlainRecord(preflight.metrics) ? preflight.metrics : {};
        return normalizeDomainScopeFingerprints(metrics.domain_scope_fingerprints);
    } catch {
        return null;
    }
}

export function reviewCycleAttemptMatchesCurrentScope(
    reviewType: string,
    details: Record<string, unknown> | null,
    currentFingerprints: DomainScopeFingerprints | null
): boolean {
    const expectedScopeSha256 = getReviewLaneScopeSha256(reviewType, currentFingerprints);
    if (!expectedScopeSha256) {
        return true;
    }
    const detailFingerprints = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    const detailScopeSha256 = getReviewLaneScopeSha256(reviewType, detailFingerprints)
        || (reviewType === 'test'
            ? getTimelineReviewScopeHash(details)
            : getTimelineCodeScopeHash(details) || getTimelineReviewScopeHash(details));
    if (!detailScopeSha256) {
        return true;
    }
    return detailScopeSha256 === expectedScopeSha256;
}
