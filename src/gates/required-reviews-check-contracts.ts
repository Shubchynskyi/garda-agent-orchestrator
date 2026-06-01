// Extracted from required-reviews-check.ts; keep behavior changes in the facade tests.
import * as fs from 'node:fs';
import * as path from 'node:path';
import { buildReviewVerdictTokenSet } from '../gate-runtime/review-context';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { fileSha256 } from './helpers';

export const REVIEW_CONTRACTS = [
    ['code', 'REVIEW PASSED'],
    ['db', 'DB REVIEW PASSED'],
    ['security', 'SECURITY REVIEW PASSED'],
    ['refactor', 'REFACTOR REVIEW PASSED'],
    ['api', 'API REVIEW PASSED'],
    ['test', 'TEST REVIEW PASSED'],
    ['performance', 'PERFORMANCE REVIEW PASSED'],
    ['infra', 'INFRA REVIEW PASSED'],
    ['dependency', 'DEPENDENCY REVIEW PASSED']
];

export function resolveExpectedReviewVerdicts(
    requiredReviews: Record<string, boolean>,
    verdicts?: Record<string, string>,
    skipReviews?: string[]
): Record<string, string> {
    const providedVerdicts = verdicts || {};
    const skipSet = new Set((skipReviews || []).map((item) => String(item || '').trim().toLowerCase()).filter(Boolean));
    const resolved: Record<string, string> = {};

    for (const [reviewKey, passToken] of REVIEW_CONTRACTS) {
        const explicitVerdict = String(providedVerdicts[reviewKey] || '').trim();
        if (explicitVerdict) {
            resolved[reviewKey] = normalizeExplicitReviewVerdict(reviewKey, explicitVerdict, passToken);
            continue;
        }
        resolved[reviewKey] = requiredReviews[reviewKey] && !skipSet.has(reviewKey)
            ? passToken
            : 'NOT_REQUIRED';
    }

    return resolved;
}

function normalizeExplicitReviewVerdict(
    reviewKey: string,
    explicitVerdict: string,
    passToken: string
): string {
    const failToken = passToken.replace(/\bPASSED\b/g, 'FAILED');
    const tokenSet = buildReviewVerdictTokenSet(reviewKey, passToken, failToken);
    if (tokenSet.passTokens.includes(explicitVerdict)) {
        return passToken;
    }
    if (tokenSet.failTokens.includes(explicitVerdict)) {
        return failToken;
    }
    return explicitVerdict;
}

export function parseSkipReviews(value: unknown): string[] {
    if (!value || !String(value).trim()) return [];
    const parts = String(value).trim().toLowerCase().split(/[,; ]+/).filter(s => s.trim());
    return [...new Set(parts)].sort();
}

export function testExpectedVerdict(errors: string[], label: string, required: boolean, skippedByOverride: boolean, actualVerdict: string, passVerdict: string): void {
    if (required && !skippedByOverride) {
        if (actualVerdict !== passVerdict) {
            errors.push(`${label} is required. Expected '${passVerdict}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (skippedByOverride) {
        const allowed = new Set(['NOT_REQUIRED', 'SKIPPED_BY_OVERRIDE', passVerdict]);
        if (!allowed.has(actualVerdict)) {
            const allowedText = [...allowed].sort().join("', '");
            errors.push(`${label} override is active. Expected one of '${allowedText}', got '${actualVerdict}'.`);
        }
        return;
    }
    if (actualVerdict === 'NOT_REQUIRED' || actualVerdict === passVerdict) return;
    errors.push(`${label} is not required. Expected 'NOT_REQUIRED' or '${passVerdict}', got '${actualVerdict}'.`);
}

export function validatePreflightForReview(preflightPath: string, explicitTaskId: string) {
    let preflight;
    try {
        preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    } catch {
        throw new Error(`Preflight artifact is not valid JSON: ${preflightPath}`);
    }

    const errors: string[] = [];
    let resolvedTaskId: string | null = null;
    if (explicitTaskId && explicitTaskId.trim()) {
        try {
            resolvedTaskId = assertValidTaskId(explicitTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(String(message));
        }
    }

    let preflightTaskId: string | null = preflight.task_id != null ? String(preflight.task_id).trim() : '';
    if (preflightTaskId) {
        try {
            preflightTaskId = assertValidTaskId(preflightTaskId);
        } catch (exc: unknown) {
            const message = exc instanceof Error ? exc.message : String(exc);
            errors.push(`preflight.task_id: ${message}`);
            preflightTaskId = null;
        }
    } else {
        preflightTaskId = null;
    }

    if (resolvedTaskId && preflightTaskId && resolvedTaskId !== preflightTaskId) {
        errors.push(`TaskId '${resolvedTaskId}' does not match preflight.task_id '${preflightTaskId}'.`);
    }
    if (!resolvedTaskId && preflightTaskId) resolvedTaskId = preflightTaskId;
    if (!resolvedTaskId) {
        errors.push('TaskId is required and must be provided either via --task-id or preflight.task_id.');
    }

    const requiredReviews = preflight.required_reviews;
    const requiredFlags: Record<string, boolean> = {};
    const requiredKeys = ['code', 'db', 'security', 'refactor', 'api', 'test', 'performance', 'infra', 'dependency'];
    if (!requiredReviews || typeof requiredReviews !== 'object') {
        errors.push('Preflight field `required_reviews` is required and must be an object.');
    }
    for (const key of requiredKeys) {
        const value = requiredReviews ? requiredReviews[key] : undefined;
        if (typeof value !== 'boolean') {
            errors.push(`Preflight field \`required_reviews.${key}\` is required and must be boolean.`);
            requiredFlags[key] = false;
        } else {
            requiredFlags[key] = value;
        }
    }

    return {
        preflight,
        resolved_task_id: resolvedTaskId,
        required_reviews: requiredFlags,
        preflight_path: path.resolve(preflightPath),
        preflight_hash: fileSha256(path.resolve(preflightPath)),
        errors
    };
}

