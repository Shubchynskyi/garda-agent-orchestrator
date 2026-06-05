import * as fs from 'node:fs';
import { stringSha256 } from './hash';
import { withReviewArtifactLock, writeArtifactFileAtomically } from './review-artifacts';

export interface ReviewContextRoutingMetadataUpdate {
    actualExecutionMode: string | null;
    reviewerSessionId: string | null;
    fallbackReason: string | null;
}

export interface RestoreReviewerRoutingMetadataResult {
    restored: boolean;
    contextSha256: string | null;
    reason: 'missing_context' | 'hash_mismatch' | null;
}

export function applyReviewerRoutingMetadata(
    reviewContextPath: string,
    update: ReviewContextRoutingMetadataUpdate
): { updated: boolean; contextSha256: string | null } {
    const restored = restoreReviewerRoutingMetadata(reviewContextPath, update);
    return {
        updated: restored.restored,
        contextSha256: restored.contextSha256
    };
}

export function restoreReviewerRoutingMetadata(
    reviewContextPath: string,
    update: ReviewContextRoutingMetadataUpdate,
    expectedContextSha256: string | null = null
): RestoreReviewerRoutingMetadataResult {
    if (!reviewContextPath || !fs.existsSync(reviewContextPath) || !fs.statSync(reviewContextPath).isFile()) {
        return { restored: false, contextSha256: null, reason: 'missing_context' };
    }
    const normalizedExpectedHash = String(expectedContextSha256 || '').trim().toLowerCase() || null;
    return withReviewArtifactLock(reviewContextPath, () => {
        if (!fs.existsSync(reviewContextPath) || !fs.statSync(reviewContextPath).isFile()) {
            return { restored: false, contextSha256: null, reason: 'missing_context' as const };
        }

        const parsed = JSON.parse(fs.readFileSync(reviewContextPath, 'utf8')) as Record<string, unknown>;
        const currentRouting = parsed.reviewer_routing && typeof parsed.reviewer_routing === 'object' && !Array.isArray(parsed.reviewer_routing)
            ? parsed.reviewer_routing as Record<string, unknown>
            : {};

        parsed.reviewer_routing = {
            ...currentRouting,
            actual_execution_mode: update.actualExecutionMode ?? null,
            reviewer_session_id: update.reviewerSessionId ?? null,
            fallback_reason: update.fallbackReason ?? null
        };

        const serialized = JSON.stringify(parsed, null, 2) + '\n';
        const contextSha256 = stringSha256(serialized);
        if (normalizedExpectedHash && contextSha256 !== normalizedExpectedHash) {
            return {
                restored: false,
                contextSha256,
                reason: 'hash_mismatch' as const
            };
        }

        writeArtifactFileAtomically(reviewContextPath, serialized);
        return {
            restored: true,
            contextSha256,
            reason: null
        };
    }).result;
}
