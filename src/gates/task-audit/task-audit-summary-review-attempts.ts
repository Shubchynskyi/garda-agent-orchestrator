import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256 } from '../shared/helpers';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    extractReviewVerdictTokenMatch
} from '../../gate-runtime/review-context';
import { withReviewArtifactReadBarrier } from '../../gate-runtime/review-artifacts';
import {
    REVIEW_TRUST_COMPATIBILITY_TYPES,
    isSafeCanonicalArtifactPath,
    normalizeKnownReviewType,
    normalizeSha256Text,
    safeReadJson
} from './task-audit-summary-review-common';
import type { ReviewReuseTelemetryEventLike } from '../review-reuse/review-reuse-telemetry';

export interface ReviewAttemptTypeSummary {
    review_type: string;
    total_attempts: number;
    pass_count: number;
    fail_count: number;
    reused_count: number;
    missing_or_invalid_count: number;
}

export interface ReviewAttemptSummary {
    total_attempts: number;
    review_types: ReviewAttemptTypeSummary[];
    source_mode: 'task_events' | 'current_artifacts_fallback' | 'mixed' | 'none';
    visible_summary_line: string | null;
}

export function readReviewVerdicts(
    requiredReviews: Record<string, boolean>,
    reviewGate: Record<string, unknown> | null
): Record<string, string> {
    const verdictsSource = reviewGate && reviewGate.verdicts && typeof reviewGate.verdicts === 'object'
        ? reviewGate.verdicts as Record<string, unknown>
        : {};
    const reviewVerdicts: Record<string, string> = {};
    for (const reviewType of Object.keys(requiredReviews).filter((key) => requiredReviews[key]).sort()) {
        const verdict = verdictsSource[reviewType];
        reviewVerdicts[reviewType] = typeof verdict === 'string' && verdict.trim()
            ? verdict.trim()
            : 'MISSING';
    }
    return reviewVerdicts;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function buildCanonicalReviewVerdictToken(reviewType: string, outcome: 'PASSED' | 'FAILED'): string {
    return `${reviewType.trim().toUpperCase()} REVIEW ${outcome}`;
}

function resolveReviewArtifactPath(candidatePath: unknown, reviewsRoot: string): string | null {
    const normalizedCandidate = String(candidatePath || '').trim();
    if (!normalizedCandidate) {
        return null;
    }
    const resolvedPath = path.isAbsolute(normalizedCandidate)
        ? path.resolve(normalizedCandidate)
        : path.resolve(reviewsRoot, normalizedCandidate);
    return isSafeCanonicalArtifactPath(resolvedPath, reviewsRoot)
        ? resolvedPath
        : null;
}

function resolveCanonicalReviewSnapshotPath(
    candidatePath: unknown,
    reviewsRoot: string,
    expectedFileName: string
): string | null {
    const resolvedPath = resolveReviewArtifactPath(candidatePath, reviewsRoot);
    const expectedPath = path.resolve(reviewsRoot, expectedFileName);
    return resolvedPath && resolvedPath === expectedPath
        ? resolvedPath
        : null;
}

function readValidatedTextSnapshotArtifact(
    candidatePath: unknown,
    reviewsRoot: string,
    expectedFileName: string,
    expectedSha256?: unknown
): { content: string | null; valid: boolean; sha256: string | null } {
    const resolvedPath = resolveCanonicalReviewSnapshotPath(candidatePath, reviewsRoot, expectedFileName);
    const normalizedExpectedSha256 = normalizeSha256Text(expectedSha256);
    if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return { content: null, valid: false, sha256: null };
    }
    const actualSha256 = fileSha256(resolvedPath);
    if (!actualSha256 || (normalizedExpectedSha256 && actualSha256 !== normalizedExpectedSha256)) {
        return { content: null, valid: false, sha256: actualSha256 };
    }
    return { content: fs.readFileSync(resolvedPath, 'utf8'), valid: true, sha256: actualSha256 };
}

function readValidatedReviewReceiptSnapshot(
    candidatePath: unknown,
    reviewsRoot: string,
    expectedFileName: string,
    taskId: string,
    reviewType: string,
    expectedSha256?: unknown
): { receipt: Record<string, unknown> | null; valid: boolean } {
    const resolvedPath = resolveCanonicalReviewSnapshotPath(candidatePath, reviewsRoot, expectedFileName);
    const normalizedExpectedSha256 = normalizeSha256Text(expectedSha256);
    if (!resolvedPath || !fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return { receipt: null, valid: false };
    }
    const actualSha256 = fileSha256(resolvedPath);
    if (!actualSha256 || (normalizedExpectedSha256 && actualSha256 !== normalizedExpectedSha256)) {
        return { receipt: null, valid: false };
    }
    const receipt = safeReadJson(resolvedPath);
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return { receipt: null, valid: false };
    }
    return { receipt, valid: true };
}

function isReviewReceiptBoundToArtifact(
    receipt: Record<string, unknown> | null,
    artifactSha256: string | null
): boolean {
    const recordedReviewArtifactHash = normalizeSha256Text(receipt?.review_artifact_sha256);
    return !!recordedReviewArtifactHash && !!artifactSha256 && recordedReviewArtifactHash === artifactSha256;
}

function classifyReviewAttemptVerdict(
    reviewType: string,
    reviewContent: string | null
): 'PASS' | 'FAIL' | 'MISSING_OR_INVALID' {
    if (!reviewContent) {
        return 'MISSING_OR_INVALID';
    }
    const verdictTokens = buildReviewVerdictTokenSet(
        reviewType,
        buildCanonicalReviewVerdictToken(reviewType, 'PASSED'),
        buildCanonicalReviewVerdictToken(reviewType, 'FAILED')
    );
    const verdictMatch = extractReviewVerdictSectionTokenMatch(reviewContent, verdictTokens)
        || extractReviewVerdictTokenMatch(reviewContent, verdictTokens);
    if (!verdictMatch) {
        return 'MISSING_OR_INVALID';
    }
    return verdictMatch.outcome === 'pass' ? 'PASS' : 'FAIL';
}

function createReviewAttemptTypeSummary(reviewType: string): ReviewAttemptTypeSummary {
    return {
        review_type: reviewType,
        total_attempts: 0,
        pass_count: 0,
        fail_count: 0,
        reused_count: 0,
        missing_or_invalid_count: 0
    };
}

function recordReviewAttempt(
    summary: ReviewAttemptTypeSummary,
    verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID',
    reusedExistingReview: boolean
): void {
    summary.total_attempts += 1;
    if (verdict === 'PASS') {
        summary.pass_count += 1;
    } else if (verdict === 'FAIL') {
        summary.fail_count += 1;
    } else {
        summary.missing_or_invalid_count += 1;
    }
    if (reusedExistingReview) {
        summary.reused_count += 1;
    }
}

function buildReviewAttemptVisibleSummaryLine(reviewTypes: ReviewAttemptTypeSummary[]): string | null {
    if (reviewTypes.length === 0) {
        return null;
    }
    const totalAttempts = reviewTypes.reduce((sum, entry) => sum + entry.total_attempts, 0);
    const parts = reviewTypes.map((entry) => (
        `${entry.review_type}(pass=${entry.pass_count}, fail=${entry.fail_count}, reused=${entry.reused_count}, missing/invalid=${entry.missing_or_invalid_count})`
    ));
    return `Review attempts: total=${totalAttempts}; ${parts.join('; ')}`;
}

function summarizeReviewAttemptFromEvent(
    event: ReviewReuseTelemetryEventLike,
    reviewsRoot: string,
    taskId: string
): {
    reviewType: string;
    verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID';
    reusedExistingReview: boolean;
    receiptSha256: string | null;
    reviewArtifactSha256: string | null;
} | null {
    if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_RECORDED') {
        return null;
    }
    const details = isPlainRecord(event.details) ? event.details : {};
    const reviewType = normalizeKnownReviewType(details.review_type ?? details.reviewType);
    if (!reviewType) {
        return null;
    }
    const reusedExistingReview = details.reused_existing_review === true;
    const explicitReceiptPath = details.receipt_snapshot_path ?? details.receiptSnapshotPath;
    const explicitReviewArtifactPath = details.review_artifact_snapshot_path ?? details.reviewArtifactSnapshotPath;
    if (!String(explicitReceiptPath || '').trim() && !String(explicitReviewArtifactPath || '').trim()) {
        return {
            reviewType,
            verdict: 'MISSING_OR_INVALID',
            reusedExistingReview,
            receiptSha256: null,
            reviewArtifactSha256: null
        };
    }
    const explicitReceiptSha256 = details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256;
    const explicitReviewArtifactSha256 = details.review_artifact_snapshot_sha256 ?? details.reviewArtifactSnapshotSha256;
    const recordedReceiptSha256 = normalizeSha256Text(details.receipt_sha256 ?? details.receiptSha256);
    const recordedReviewArtifactSha256 = normalizeSha256Text(details.review_artifact_sha256 ?? details.reviewArtifactSha256);
    if (!normalizeSha256Text(explicitReceiptSha256) || !normalizeSha256Text(explicitReviewArtifactSha256)) {
        return {
            reviewType,
            verdict: 'MISSING_OR_INVALID',
            reusedExistingReview,
            receiptSha256: null,
            reviewArtifactSha256: null
        };
    }
    if (
        (recordedReceiptSha256 && recordedReceiptSha256 !== normalizeSha256Text(explicitReceiptSha256))
        || (recordedReviewArtifactSha256 && recordedReviewArtifactSha256 !== normalizeSha256Text(explicitReviewArtifactSha256))
    ) {
        return {
            reviewType,
            verdict: 'MISSING_OR_INVALID',
            reusedExistingReview,
            receiptSha256: null,
            reviewArtifactSha256: null
        };
    }
    const receiptSnapshotSha256 = normalizeSha256Text(explicitReceiptSha256);
    const reviewArtifactSnapshotSha256 = normalizeSha256Text(explicitReviewArtifactSha256);
    const receiptResult = readValidatedReviewReceiptSnapshot(
        explicitReceiptPath,
        reviewsRoot,
        `${taskId}-${reviewType}-receipt-${receiptSnapshotSha256}.json`,
        taskId,
        reviewType,
        receiptSnapshotSha256
    );
    const reviewArtifactResult = readValidatedTextSnapshotArtifact(
        explicitReviewArtifactPath,
        reviewsRoot,
        `${taskId}-${reviewType}-artifact-${reviewArtifactSnapshotSha256}.md`,
        reviewArtifactSnapshotSha256
    );
    const reusedExistingReviewFromArtifacts = reusedExistingReview
        || receiptResult.receipt?.reused_existing_review === true;
    const verdict = receiptResult.valid
        && reviewArtifactResult.valid
        && isReviewReceiptBoundToArtifact(receiptResult.receipt, reviewArtifactResult.sha256)
        ? classifyReviewAttemptVerdict(reviewType, reviewArtifactResult.content)
        : 'MISSING_OR_INVALID';
    return {
        reviewType,
        verdict,
        reusedExistingReview: reusedExistingReviewFromArtifacts,
        receiptSha256: receiptSnapshotSha256,
        reviewArtifactSha256: reviewArtifactSnapshotSha256
    };
}

function summarizeReviewAttemptsFromSnapshotArtifacts(
    reviewsRoot: string,
    taskId: string,
    reviewType: string
): { verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID'; reusedExistingReview: boolean; receiptSha256: string | null; reviewArtifactSha256: string | null }[] {
    const receiptFilePrefix = `${taskId}-${reviewType}-receipt-`;
    const receiptFileSuffix = '.json';
    const receiptSnapshotFiles = fs.existsSync(reviewsRoot) && fs.statSync(reviewsRoot).isDirectory()
        ? fs.readdirSync(reviewsRoot)
            .filter((entry) => entry.startsWith(receiptFilePrefix) && entry.endsWith(receiptFileSuffix))
            .sort()
        : [];
    return receiptSnapshotFiles.map((receiptSnapshotFileName) => {
        const receiptSha256 = normalizeSha256Text(receiptSnapshotFileName.slice(
            receiptFilePrefix.length,
            receiptSnapshotFileName.length - receiptFileSuffix.length
        ));
        const receiptResult = readValidatedReviewReceiptSnapshot(
            path.join(reviewsRoot, receiptSnapshotFileName),
            reviewsRoot,
            receiptSnapshotFileName,
            taskId,
            reviewType,
            receiptSha256
        );
        const reusedExistingReview = receiptResult.receipt?.reused_existing_review === true;
        const reviewArtifactSha256 = normalizeSha256Text(receiptResult.receipt?.review_artifact_sha256);
        const reviewArtifactSnapshotFileName = reviewArtifactSha256
            ? `${taskId}-${reviewType}-artifact-${reviewArtifactSha256}.md`
            : null;
        const reviewArtifactResult = reviewArtifactSnapshotFileName
            ? readValidatedTextSnapshotArtifact(
                path.join(reviewsRoot, reviewArtifactSnapshotFileName),
                reviewsRoot,
                reviewArtifactSnapshotFileName,
                reviewArtifactSha256
            )
            : { content: null, valid: false, sha256: null };
        const verdict = receiptResult.valid
            && reviewArtifactResult.valid
            && isReviewReceiptBoundToArtifact(receiptResult.receipt, reviewArtifactResult.sha256)
            ? classifyReviewAttemptVerdict(reviewType, reviewArtifactResult.content)
            : 'MISSING_OR_INVALID';
        return {
            verdict,
            reusedExistingReview,
            receiptSha256,
            reviewArtifactSha256
        };
    });
}

function buildReviewAttemptEvidenceKey(
    receiptSha256: string | null | undefined,
    reviewArtifactSha256: string | null | undefined
): string | null {
    const normalizedReceiptSha256 = normalizeSha256Text(receiptSha256);
    const normalizedReviewArtifactSha256 = normalizeSha256Text(reviewArtifactSha256);
    return normalizedReceiptSha256 || normalizedReviewArtifactSha256 || null;
}

export function buildReviewAttemptSummary(options: {
    reviewsRoot: string;
    taskId: string;
    timelineEvents?: readonly ReviewReuseTelemetryEventLike[];
}): ReviewAttemptSummary | null {
    return withReviewArtifactReadBarrier(options.reviewsRoot, () => {
        const attemptCounts = new Map<string, ReviewAttemptTypeSummary>();
        const eventEvidenceKeysByType = new Map<string, Set<string>>();
        let taskEventAttemptCount = 0;
        let fallbackAttemptCount = 0;

        for (const event of options.timelineEvents || []) {
            const eventAttempt = summarizeReviewAttemptFromEvent(event, options.reviewsRoot, options.taskId);
            if (!eventAttempt) {
                continue;
            }
            const eventEvidenceKey = buildReviewAttemptEvidenceKey(eventAttempt.receiptSha256, eventAttempt.reviewArtifactSha256);
            const reviewTypeEvidenceKeys = eventEvidenceKeysByType.get(eventAttempt.reviewType) || new Set<string>();
            if (eventEvidenceKey && reviewTypeEvidenceKeys.has(eventEvidenceKey)) {
                continue;
            }
            const summary = attemptCounts.get(eventAttempt.reviewType) || createReviewAttemptTypeSummary(eventAttempt.reviewType);
            recordReviewAttempt(summary, eventAttempt.verdict, eventAttempt.reusedExistingReview);
            attemptCounts.set(eventAttempt.reviewType, summary);
            if (eventEvidenceKey) {
                reviewTypeEvidenceKeys.add(eventEvidenceKey);
                eventEvidenceKeysByType.set(eventAttempt.reviewType, reviewTypeEvidenceKeys);
            }
            taskEventAttemptCount += 1;
        }

        for (const reviewType of REVIEW_TRUST_COMPATIBILITY_TYPES) {
            for (const fallbackAttempt of summarizeReviewAttemptsFromSnapshotArtifacts(options.reviewsRoot, options.taskId, reviewType)) {
                const fallbackEvidenceKey = buildReviewAttemptEvidenceKey(
                    fallbackAttempt.receiptSha256,
                    fallbackAttempt.reviewArtifactSha256
                );
                if (fallbackEvidenceKey && eventEvidenceKeysByType.get(reviewType)?.has(fallbackEvidenceKey)) {
                    continue;
                }
                const summary = attemptCounts.get(reviewType) || createReviewAttemptTypeSummary(reviewType);
                recordReviewAttempt(summary, fallbackAttempt.verdict, fallbackAttempt.reusedExistingReview);
                attemptCounts.set(reviewType, summary);
                fallbackAttemptCount += 1;
            }
        }

        const reviewTypes = [...attemptCounts.values()]
            .filter((entry) => entry.total_attempts > 0)
            .sort((left, right) => left.review_type.localeCompare(right.review_type));
        if (reviewTypes.length === 0) {
            return null;
        }

        const totalAttempts = reviewTypes.reduce((sum, entry) => sum + entry.total_attempts, 0);
        const sourceMode: ReviewAttemptSummary['source_mode'] = taskEventAttemptCount > 0 && fallbackAttemptCount > 0
            ? 'mixed'
            : taskEventAttemptCount > 0
                ? 'task_events'
                : fallbackAttemptCount > 0
                    ? 'current_artifacts_fallback'
                    : 'none';

        return {
            total_attempts: totalAttempts,
            review_types: reviewTypes,
            source_mode: sourceMode,
            visible_summary_line: buildReviewAttemptVisibleSummaryLine(reviewTypes)
        };
    });
}
