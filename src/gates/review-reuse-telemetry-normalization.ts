// Extracted from review-reuse-telemetry.ts; keep behavior changes covered by facade tests.
import * as path from 'node:path';
import { normalizePath } from './helpers';
import { type ReviewReuseTelemetryDetails } from './review-reuse-telemetry-types';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function getReviewReuseTelemetryDetails(details: unknown): ReviewReuseTelemetryDetails {
    const record = isPlainRecord(details) ? details : {};
    return {
        reviewType: normalizeLowerString(record.review_type ?? record.reviewType),
        receiptPath: normalizePath(record.receipt_path ?? record.receiptPath ?? '').toLowerCase(),
        receiptSha256: normalizeLowerString(record.receipt_sha256 ?? record.receiptSha256),
        reviewContextSha256: normalizeLowerString(record.review_context_sha256 ?? record.reviewContextSha256),
        reviewContextReuseSha256: normalizeLowerString(record.review_context_reuse_sha256 ?? record.reviewContextReuseSha256),
        reviewTreeStateSha256: normalizeLowerString(record.review_tree_state_sha256 ?? record.reviewTreeStateSha256),
        reviewScopeSha256: normalizeLowerString(record.review_scope_sha256 ?? record.reviewScopeSha256),
        codeScopeSha256: normalizeLowerString(record.code_scope_sha256 ?? record.codeScopeSha256),
        reviewArtifactSha256: normalizeLowerString(record.review_artifact_sha256 ?? record.reviewArtifactSha256),
        reusedExistingReview: record.reused_existing_review === true,
        reusedFromReceiptPath: normalizePath(record.reused_from_receipt_path ?? record.reusedFromReceiptPath ?? '').toLowerCase(),
        reusedFromReceiptSha256: normalizeLowerString(record.reused_from_receipt_sha256 ?? record.reusedFromReceiptSha256),
        reusedFromReviewContextSha256: normalizeLowerString(
            record.reused_from_review_context_sha256 ?? record.reusedFromReviewContextSha256
        ),
        reusedFromReviewContextReuseSha256: normalizeLowerString(
            record.reused_from_review_context_reuse_sha256 ?? record.reusedFromReviewContextReuseSha256
        ),
        reusedFromReviewTreeStateSha256: normalizeLowerString(
            record.reused_from_review_tree_state_sha256 ?? record.reusedFromReviewTreeStateSha256
        ),
        reusedFromReviewScopeSha256: normalizeLowerString(
            record.reused_from_review_scope_sha256 ?? record.reusedFromReviewScopeSha256
        ),
        reusedFromCodeScopeSha256: normalizeLowerString(
            record.reused_from_code_scope_sha256 ?? record.reusedFromCodeScopeSha256
        )
    };
}


export function isSha256(value: unknown): boolean {
    return /^[0-9a-f]{64}$/.test(normalizeLowerString(value));
}

export function optionalTestReviewCodeScopeMatches(actualValue: unknown, expectedValue: unknown): boolean {
    const actual = String(actualValue || '').trim().toLowerCase();
    const expected = normalizeLowerString(expectedValue);
    if (actual && !isSha256(actual)) {
        return false;
    }
    if (expected && !isSha256(expected)) {
        return false;
    }
    if (!actual || !expected) {
        return true;
    }
    return actual === expected;
}

export function getReviewPassVerdict(reviewType: string): string {
    const passVerdicts: Record<string, string> = {
        code: 'REVIEW PASSED',
        db: 'DB REVIEW PASSED',
        security: 'SECURITY REVIEW PASSED',
        refactor: 'REFACTOR REVIEW PASSED',
        api: 'API REVIEW PASSED',
        test: 'TEST REVIEW PASSED',
        performance: 'PERFORMANCE REVIEW PASSED',
        infra: 'INFRA REVIEW PASSED',
        dependency: 'DEPENDENCY REVIEW PASSED'
    };
    return passVerdicts[normalizeLowerString(reviewType)] || `${String(reviewType || '').trim().toUpperCase()} REVIEW PASSED`;
}

export function normalizeEventType(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

export function normalizeLowerString(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

export function normalizeTaskSequence(integrity: unknown): number | null {
    const record = isPlainRecord(integrity) ? integrity : {};
    const sequence = typeof record.task_sequence === 'number'
        ? record.task_sequence
        : Number(record.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

export function normalizeEventSequence(value: unknown): number | null {
    const sequence = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(sequence) ? sequence : null;
}

export function normalizePathForComparison(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

export function pathsEqual(left: string, right: string): boolean {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

export function pathIsInsideOrEqual(candidatePath: string, rootPath: string): boolean {
    const normalizedCandidate = normalizePathForComparison(candidatePath);
    const normalizedRoot = normalizePathForComparison(rootPath);
    const relativePath = path.relative(normalizedRoot, normalizedCandidate);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

export function hasParentPathSegment(rawPath: string): boolean {
    return rawPath.replace(/\\/g, '/').split('/').includes('..');
}

export function normalizeArtifactSegment(value: unknown): string {
    return String(value || '').trim();
}

export function isSafeArtifactSegment(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}
