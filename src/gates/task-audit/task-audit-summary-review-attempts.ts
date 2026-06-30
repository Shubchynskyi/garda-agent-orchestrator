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
import {
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';

export interface ReviewAttemptTypeSummary {
    review_type: string;
    total_attempts: number;
    pass_count: number;
    fail_count: number;
    reused_count: number;
    missing_or_invalid_count: number;
}

export interface ReviewAttemptCountSummary {
    total: number;
    pass: number;
    fail: number;
    missing_or_invalid: number;
}

export interface ReviewAttemptFreshReuseSummary {
    fresh: number;
    reused: number;
}

export interface ReviewAttemptScopeHashSummary extends ReviewAttemptCountSummary, ReviewAttemptFreshReuseSummary {
    scope_hash: string;
    current_scope: boolean;
}

export interface ReviewAttemptSummary {
    total_attempts: number;
    review_types: ReviewAttemptTypeSummary[];
    source_mode: 'task_events' | 'current_artifacts_fallback' | 'mixed' | 'none';
    visible_summary_line: string | null;
    total_non_test_attempts?: number;
    current_scope_total_attempts?: number;
    current_scope_non_test_attempts?: number;
    fresh_non_test_attempts?: number;
    reused_non_test_attempts?: number;
    current_scope_counts_by_review_type?: Record<string, ReviewAttemptCountSummary>;
    fresh_reused_by_review_type?: Record<string, ReviewAttemptFreshReuseSummary>;
    scope_hash_count_by_review_type?: Record<string, number>;
    top_scope_hashes_by_review_type?: Record<string, ReviewAttemptScopeHashSummary[]>;
    review_cycle_summary_line?: string | null;
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

function normalizeReviewAttemptScopeHash(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function getReviewAttemptScopeHash(reviewType: string, details: Record<string, unknown> | null): string | null {
    const normalizedReviewType = reviewType.trim().toLowerCase();
    const detailFingerprints = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    return getReviewLaneScopeSha256(normalizedReviewType, detailFingerprints)
        || (normalizedReviewType === 'test'
            ? normalizeReviewAttemptScopeHash(details?.review_scope_sha256 ?? details?.reviewScopeSha256)
            : normalizeReviewAttemptScopeHash(details?.code_scope_sha256 ?? details?.codeScopeSha256)
                || normalizeReviewAttemptScopeHash(details?.review_scope_sha256 ?? details?.reviewScopeSha256));
}

function readPreflightDomainScopeFingerprints(preflight: Record<string, unknown> | null | undefined): DomainScopeFingerprints | null {
    const metrics = isPlainRecord(preflight?.metrics) ? preflight.metrics : {};
    return normalizeDomainScopeFingerprints(metrics.domain_scope_fingerprints);
}

function reviewAttemptMatchesCurrentScope(
    reviewType: string,
    details: Record<string, unknown> | null,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): boolean {
    const expectedScopeSha256 = getReviewLaneScopeSha256(reviewType, currentPreflightFingerprints);
    if (!expectedScopeSha256) {
        return true;
    }
    const detailScopeSha256 = getReviewAttemptScopeHash(reviewType, details);
    if (!detailScopeSha256) {
        return true;
    }
    return detailScopeSha256 === expectedScopeSha256;
}

function createReviewAttemptCountSummary(): ReviewAttemptCountSummary {
    return { total: 0, pass: 0, fail: 0, missing_or_invalid: 0 };
}

function recordReviewAttemptCount(
    summary: ReviewAttemptCountSummary,
    attempt: ReviewAttemptDiagnosticInput
): void {
    summary.total += 1;
    if (attempt.verdict === 'PASS') {
        summary.pass += 1;
    } else if (attempt.verdict === 'FAIL') {
        summary.fail += 1;
    } else {
        summary.missing_or_invalid += 1;
    }
}

function createReviewAttemptFreshReuseSummary(): ReviewAttemptFreshReuseSummary {
    return { fresh: 0, reused: 0 };
}

function recordReviewAttemptFreshReuse(
    summary: ReviewAttemptFreshReuseSummary,
    attempt: ReviewAttemptDiagnosticInput
): void {
    if (attempt.reusedExistingReview) {
        summary.reused += 1;
    } else {
        summary.fresh += 1;
    }
}

function sortRecord<T>(record: Record<string, T>): Record<string, T> {
    return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

interface ReviewAttemptDiagnosticInput {
    reviewType: string;
    verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID';
    reusedExistingReview: boolean;
    scopeHash: string | null;
    currentScope: boolean;
}

function buildReviewAttemptCycleSummaryLine(summary: Pick<
    ReviewAttemptSummary,
    | 'total_attempts'
    | 'total_non_test_attempts'
    | 'current_scope_non_test_attempts'
    | 'fresh_non_test_attempts'
    | 'reused_non_test_attempts'
    | 'scope_hash_count_by_review_type'
>): string | null {
    if (summary.total_attempts === 0) {
        return null;
    }
    const scopeHashText = Object.entries(summary.scope_hash_count_by_review_type || {})
        .map(([reviewType, count]) => `${reviewType}=${count}`)
        .join(', ');
    return `Review cycle attempts: total=${summary.total_attempts}; non_test=${summary.total_non_test_attempts ?? 0}; ` +
        `current_scope_non_test=${summary.current_scope_non_test_attempts ?? 0}; ` +
        `fresh_non_test=${summary.fresh_non_test_attempts ?? 0}; reused_non_test=${summary.reused_non_test_attempts ?? 0}; ` +
        `scope_hashes_by_type=${scopeHashText || 'none'}`;
}

function buildReviewAttemptDiagnostics(
    attempts: ReviewAttemptDiagnosticInput[],
    excludedReviewTypes: string[]
): Omit<ReviewAttemptSummary, 'review_types' | 'source_mode' | 'visible_summary_line' | 'review_cycle_summary_line'> {
    const excluded = new Set(excludedReviewTypes.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    const currentScopeCountsByType = new Map<string, ReviewAttemptCountSummary>();
    const freshReusedByType = new Map<string, ReviewAttemptFreshReuseSummary>();
    const scopeHashCountsByType = new Map<string, Map<string, ReviewAttemptScopeHashSummary>>();
    let totalNonTestAttempts = 0;
    let currentScopeTotalAttempts = 0;
    let currentScopeNonTestAttempts = 0;
    let freshNonTestAttempts = 0;
    let reusedNonTestAttempts = 0;

    for (const attempt of attempts) {
        const reviewType = attempt.reviewType.trim().toLowerCase();
        if (!reviewType) {
            continue;
        }
        const countsTowardNonTest = !excluded.has(reviewType);
        const freshReused = freshReusedByType.get(reviewType) || createReviewAttemptFreshReuseSummary();
        recordReviewAttemptFreshReuse(freshReused, attempt);
        freshReusedByType.set(reviewType, freshReused);
        if (countsTowardNonTest) {
            totalNonTestAttempts += 1;
            if (attempt.reusedExistingReview) {
                reusedNonTestAttempts += 1;
            } else {
                freshNonTestAttempts += 1;
            }
        }
        if (attempt.currentScope) {
            currentScopeTotalAttempts += 1;
            if (countsTowardNonTest) {
                const currentScopeCounts = currentScopeCountsByType.get(reviewType) || createReviewAttemptCountSummary();
                recordReviewAttemptCount(currentScopeCounts, attempt);
                currentScopeCountsByType.set(reviewType, currentScopeCounts);
                currentScopeNonTestAttempts += 1;
            }
        }
        if (!attempt.scopeHash) {
            continue;
        }
        let scopeHashCounts = scopeHashCountsByType.get(reviewType);
        if (!scopeHashCounts) {
            scopeHashCounts = new Map();
            scopeHashCountsByType.set(reviewType, scopeHashCounts);
        }
        const scopeCounts = scopeHashCounts.get(attempt.scopeHash) || {
            scope_hash: attempt.scopeHash,
            total: 0,
            pass: 0,
            fail: 0,
            missing_or_invalid: 0,
            fresh: 0,
            reused: 0,
            current_scope: false
        };
        recordReviewAttemptCount(scopeCounts, attempt);
        recordReviewAttemptFreshReuse(scopeCounts, attempt);
        scopeCounts.current_scope = scopeCounts.current_scope || attempt.currentScope;
        scopeHashCounts.set(attempt.scopeHash, scopeCounts);
    }

    const sortedScopeHashEntries = [...scopeHashCountsByType.entries()].sort(([left], [right]) => left.localeCompare(right));
    return {
        total_attempts: attempts.length,
        total_non_test_attempts: totalNonTestAttempts,
        current_scope_total_attempts: currentScopeTotalAttempts,
        current_scope_non_test_attempts: currentScopeNonTestAttempts,
        fresh_non_test_attempts: freshNonTestAttempts,
        reused_non_test_attempts: reusedNonTestAttempts,
        current_scope_counts_by_review_type: sortRecord(Object.fromEntries(currentScopeCountsByType.entries())),
        fresh_reused_by_review_type: sortRecord(Object.fromEntries(freshReusedByType.entries())),
        scope_hash_count_by_review_type: Object.fromEntries(
            sortedScopeHashEntries.map(([reviewType, scopeHashCounts]) => [reviewType, scopeHashCounts.size])
        ),
        top_scope_hashes_by_review_type: Object.fromEntries(
            sortedScopeHashEntries.map(([reviewType, scopeHashCounts]) => [
                reviewType,
                [...scopeHashCounts.values()]
                    .sort((left, right) => right.total - left.total || left.scope_hash.localeCompare(right.scope_hash))
                    .slice(0, 5)
            ])
        )
    };
}

function summarizeReviewAttemptFromEvent(
    event: ReviewReuseTelemetryEventLike,
    reviewsRoot: string,
    taskId: string,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): {
    reviewType: string;
    verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID';
    reusedExistingReview: boolean;
    receiptSha256: string | null;
    reviewArtifactSha256: string | null;
    scopeHash: string | null;
    currentScope: boolean;
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
    const scopeHash = getReviewAttemptScopeHash(reviewType, details);
    const currentScope = reviewAttemptMatchesCurrentScope(reviewType, details, currentPreflightFingerprints);
    const explicitReceiptPath = details.receipt_snapshot_path ?? details.receiptSnapshotPath;
    const explicitReviewArtifactPath = details.review_artifact_snapshot_path ?? details.reviewArtifactSnapshotPath;
    if (!String(explicitReceiptPath || '').trim() && !String(explicitReviewArtifactPath || '').trim()) {
        return {
            reviewType,
            verdict: 'MISSING_OR_INVALID',
            reusedExistingReview,
            receiptSha256: null,
            reviewArtifactSha256: null,
            scopeHash,
            currentScope
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
            reviewArtifactSha256: null,
            scopeHash,
            currentScope
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
            reviewArtifactSha256: null,
            scopeHash,
            currentScope
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
        reviewArtifactSha256: reviewArtifactSnapshotSha256,
        scopeHash,
        currentScope
    };
}

function summarizeReviewAttemptsFromSnapshotArtifacts(
    reviewsRoot: string,
    taskId: string,
    reviewType: string,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): {
    verdict: 'PASS' | 'FAIL' | 'MISSING_OR_INVALID';
    reusedExistingReview: boolean;
    receiptSha256: string | null;
    reviewArtifactSha256: string | null;
    scopeHash: string | null;
    currentScope: boolean;
}[] {
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
        const scopeHash = getReviewAttemptScopeHash(reviewType, receiptResult.receipt);
        const currentScope = reviewAttemptMatchesCurrentScope(reviewType, receiptResult.receipt, currentPreflightFingerprints);
        return {
            verdict,
            reusedExistingReview,
            receiptSha256,
            reviewArtifactSha256,
            scopeHash,
            currentScope
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
    currentPreflight?: Record<string, unknown> | null;
    excludedReviewTypes?: string[];
}): ReviewAttemptSummary | null {
    return withReviewArtifactReadBarrier(options.reviewsRoot, () => {
        const attemptCounts = new Map<string, ReviewAttemptTypeSummary>();
        const eventEvidenceKeysByType = new Map<string, Set<string>>();
        const diagnosticAttempts: ReviewAttemptDiagnosticInput[] = [];
        const currentPreflightFingerprints = readPreflightDomainScopeFingerprints(options.currentPreflight);
        const excludedReviewTypes = options.excludedReviewTypes ?? ['test'];
        let taskEventAttemptCount = 0;
        let fallbackAttemptCount = 0;

        for (const event of options.timelineEvents || []) {
            const eventAttempt = summarizeReviewAttemptFromEvent(
                event,
                options.reviewsRoot,
                options.taskId,
                currentPreflightFingerprints
            );
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
            diagnosticAttempts.push({
                reviewType: eventAttempt.reviewType,
                verdict: eventAttempt.verdict,
                reusedExistingReview: eventAttempt.reusedExistingReview,
                scopeHash: eventAttempt.scopeHash,
                currentScope: eventAttempt.currentScope
            });
            if (eventEvidenceKey) {
                reviewTypeEvidenceKeys.add(eventEvidenceKey);
                eventEvidenceKeysByType.set(eventAttempt.reviewType, reviewTypeEvidenceKeys);
            }
            taskEventAttemptCount += 1;
        }

        for (const reviewType of REVIEW_TRUST_COMPATIBILITY_TYPES) {
            for (const fallbackAttempt of summarizeReviewAttemptsFromSnapshotArtifacts(
                options.reviewsRoot,
                options.taskId,
                reviewType,
                currentPreflightFingerprints
            )) {
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
                diagnosticAttempts.push({
                    reviewType,
                    verdict: fallbackAttempt.verdict,
                    reusedExistingReview: fallbackAttempt.reusedExistingReview,
                    scopeHash: fallbackAttempt.scopeHash,
                    currentScope: fallbackAttempt.currentScope
                });
                fallbackAttemptCount += 1;
            }
        }

        const reviewTypes = [...attemptCounts.values()]
            .filter((entry) => entry.total_attempts > 0)
            .sort((left, right) => left.review_type.localeCompare(right.review_type));
        if (reviewTypes.length === 0) {
            return null;
        }

        const sourceMode: ReviewAttemptSummary['source_mode'] = taskEventAttemptCount > 0 && fallbackAttemptCount > 0
            ? 'mixed'
            : taskEventAttemptCount > 0
                ? 'task_events'
                : fallbackAttemptCount > 0
                    ? 'current_artifacts_fallback'
                    : 'none';
        const diagnostics = buildReviewAttemptDiagnostics(diagnosticAttempts, excludedReviewTypes);
        const reviewCycleSummaryLine = buildReviewAttemptCycleSummaryLine(diagnostics);

        return {
            ...diagnostics,
            review_types: reviewTypes,
            source_mode: sourceMode,
            visible_summary_line: buildReviewAttemptVisibleSummaryLine(reviewTypes),
            review_cycle_summary_line: reviewCycleSummaryLine
        };
    });
}
