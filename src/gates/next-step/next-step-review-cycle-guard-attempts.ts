import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    normalizeReviewCycleGuardConfig
} from '../../core/review-cycle-guard';
import {
    extractReviewVerdictToken
} from '../../gate-runtime/review-context';
import {
    jsonReviewFindingsArtifactHasActiveFindings,
    validateJsonReviewFindingsArtifact
} from '../review/review-findings-artifact-verdict';
import {
    type ReviewCoverageContract
} from '../review/review-coverage-ledger';
import {
    type TimelineEventEntry
} from '../completion/completion-evidence';
import {
    REVIEW_CONTRACTS
} from '../required-reviews/required-reviews-check';
import {
    getReviewLaneScopeSha256,
    normalizeDomainScopeFingerprints,
    type DomainScopeFingerprints
} from '../scope/domain-scope-fingerprints';
import {
    fileSha256,
    joinOrchestratorPath
} from '../shared/helpers';
import {
    reviewCycleAttemptMatchesCurrentScope
} from './next-step-review-cycle-scope';
import {
    type NextStepReviewCycleLatestFailedReview,
    type ReviewCycleArtifactVerdictResult,
    type ReviewCycleGuardReadResult
} from './next-step-review-cycle-guard-types';
import { isPlainRecord } from '../../core/records';

type ReviewCycleGuardConfig = ReturnType<typeof normalizeReviewCycleGuardConfig>;

const REVIEW_VERDICT_PASS_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(REVIEW_CONTRACTS));
const REVIEW_VERDICT_FAIL_TOKENS: Record<string, string> = Object.freeze(Object.fromEntries(
    REVIEW_CONTRACTS.map(([reviewType, passToken]) => [reviewType, passToken.replace(/\bPASSED\b/g, 'FAILED')])
));

function getTimelineDetailText(details: Record<string, unknown> | null, fieldNames: string[]): string | null {
    for (const fieldName of fieldNames) {
        const value = details?.[fieldName];
        if (typeof value === 'string' && value.trim()) {
            return value.trim();
        }
    }
    return null;
}

function getTimelineReviewType(details: Record<string, unknown> | null): string {
    return String(details?.review_type || details?.reviewType || '').trim().toLowerCase();
}

function getTimelineReviewerIdentity(details: Record<string, unknown> | null): string {
    return String(details?.reviewer_identity || details?.reviewerIdentity || '').trim();
}

function getTimelineReviewContextSha256(details: Record<string, unknown> | null): string {
    return String(details?.review_context_sha256 || details?.reviewContextSha256 || '').trim().toLowerCase();
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

function getReviewCycleAttemptScopeHash(
    reviewType: string,
    details: Record<string, unknown> | null
): string | null {
    const normalizedReviewType = reviewType.trim().toLowerCase();
    const detailFingerprints = normalizeDomainScopeFingerprints(details?.domain_scope_fingerprints);
    return getReviewLaneScopeSha256(normalizedReviewType, detailFingerprints)
        || (normalizedReviewType === 'test'
        ? getTimelineReviewScopeHash(details)
        : getTimelineCodeScopeHash(details) || getTimelineReviewScopeHash(details));
}

function getTimelineReviewFailure(eventType: string, details: Record<string, unknown> | null, outcome: string | null): boolean | null {
    const verdictToken = String(details?.verdict_token || details?.verdictToken || '').trim().toUpperCase();
    if (verdictToken.endsWith('FAILED')) {
        return true;
    }
    if (verdictToken.endsWith('PASSED')) {
        return false;
    }
    const normalizedOutcome = String(outcome || '').trim().toUpperCase();
    if (normalizedOutcome === 'FAIL') {
        return true;
    }
    if (
        eventType === 'REVIEW_RECORDED'
        && String(details?.review_artifact_snapshot_path || details?.reviewArtifactSnapshotPath || '').trim()
    ) {
        return null;
    }
    if (normalizedOutcome === 'PASS') {
        return false;
    }
    return null;
}

function normalizeReviewCycleSha256(value: unknown): string | null {
    const normalized = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(normalized) ? normalized : null;
}

function resolveReviewCycleArtifactPath(repoRoot: string, artifactPathText: string): string | null {
    const resolvedArtifactPath = path.isAbsolute(artifactPathText)
        ? path.resolve(artifactPathText)
        : path.resolve(repoRoot, artifactPathText);
    const resolvedRepoRoot = path.resolve(repoRoot);
    const relativeToRepo = path.relative(resolvedRepoRoot, resolvedArtifactPath);
    if (relativeToRepo.startsWith('..') || path.isAbsolute(relativeToRepo)) {
        return null;
    }
    if (!fs.existsSync(resolvedArtifactPath) || !fs.statSync(resolvedArtifactPath).isFile()) {
        return null;
    }
    return resolvedArtifactPath;
}

function resolveReviewCycleReviewsRoot(repoRoot: string): string {
    return path.resolve(joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')));
}

function resolveCanonicalReviewCycleSnapshotPath(
    repoRoot: string,
    candidatePath: unknown,
    expectedFileName: string
): string | null {
    const normalizedCandidate = String(candidatePath || '').trim();
    if (!normalizedCandidate) {
        return null;
    }
    const resolvedPath = resolveReviewCycleArtifactPath(repoRoot, normalizedCandidate);
    if (!resolvedPath) {
        return null;
    }
    const expectedPath = path.resolve(resolveReviewCycleReviewsRoot(repoRoot), expectedFileName);
    return path.resolve(resolvedPath) === expectedPath ? resolvedPath : null;
}

function readReviewCycleJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
        return isPlainRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function readReviewCycleContextCoverageContract(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null
): ReviewCoverageContract | null {
    const contextPath = resolveCanonicalReviewCycleSnapshotPath(
        repoRoot,
        details?.review_context_path ?? details?.reviewContextPath,
        `${taskId}-${reviewType}-review-context.json`
    );
    if (!contextPath) {
        return null;
    }
    const expectedContextSha256 = normalizeReviewCycleSha256(
        details?.review_context_sha256 ?? details?.reviewContextSha256
    );
    if (expectedContextSha256 && fileSha256(contextPath) !== expectedContextSha256) {
        return null;
    }
    const context = readReviewCycleJsonRecord(contextPath);
    const coverageContract = context?.coverage_contract;
    return isPlainRecord(coverageContract) ? coverageContract as unknown as ReviewCoverageContract : null;
}

function validateReviewCycleReceiptSnapshotBinding(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    reviewArtifactSnapshotSha256: string
): boolean {
    const receiptSnapshotPath = details?.receipt_snapshot_path ?? details?.receiptSnapshotPath;
    const receiptSnapshotSha256 = normalizeReviewCycleSha256(details?.receipt_snapshot_sha256 ?? details?.receiptSnapshotSha256);
    const hasReceiptSnapshotEvidence = Boolean(String(receiptSnapshotPath || '').trim() || receiptSnapshotSha256);
    if (!hasReceiptSnapshotEvidence) {
        return true;
    }
    if (!receiptSnapshotSha256) {
        return false;
    }
    const resolvedReceiptPath = resolveCanonicalReviewCycleSnapshotPath(
        repoRoot,
        receiptSnapshotPath,
        `${taskId}-${reviewType}-receipt-${receiptSnapshotSha256}.json`
    );
    if (!resolvedReceiptPath || fileSha256(resolvedReceiptPath) !== receiptSnapshotSha256) {
        return false;
    }
    const receipt = readReviewCycleJsonRecord(resolvedReceiptPath);
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return false;
    }
    return normalizeReviewCycleSha256(receipt.review_artifact_sha256) === reviewArtifactSnapshotSha256;
}

function resolveValidatedReviewCycleArtifactForVerdict(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    details: Record<string, unknown> | null;
}): { resolvedPath: string | null; invalidSnapshot: boolean } {
    const snapshotPathText = String(
        options.details?.review_artifact_snapshot_path
        || options.details?.reviewArtifactSnapshotPath
        || ''
    ).trim();
    if (!snapshotPathText) {
        return { resolvedPath: null, invalidSnapshot: false };
    }
    const snapshotSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_snapshot_sha256
        ?? options.details?.reviewArtifactSnapshotSha256
    );
    if (!snapshotSha256) {
        return { resolvedPath: null, invalidSnapshot: true };
    }
    const recordedArtifactSha256 = normalizeReviewCycleSha256(
        options.details?.review_artifact_sha256
        ?? options.details?.reviewArtifactSha256
    );
    if (recordedArtifactSha256 && recordedArtifactSha256 !== snapshotSha256) {
        return { resolvedPath: null, invalidSnapshot: true };
    }
    const resolvedSnapshotPath = resolveCanonicalReviewCycleSnapshotPath(
        options.repoRoot,
        snapshotPathText,
        `${options.taskId}-${options.reviewType}-artifact-${snapshotSha256}.md`
    );
    if (!resolvedSnapshotPath || fileSha256(resolvedSnapshotPath) !== snapshotSha256) {
        return { resolvedPath: null, invalidSnapshot: true };
    }
    if (!validateReviewCycleReceiptSnapshotBinding(
        options.repoRoot,
        options.taskId,
        options.reviewType,
        options.details,
        snapshotSha256
    )) {
        return { resolvedPath: null, invalidSnapshot: true };
    }
    return { resolvedPath: resolvedSnapshotPath, invalidSnapshot: false };
}

function readReviewCycleArtifactPrefix(resolvedArtifactPath: string): string {
    const file = fs.openSync(resolvedArtifactPath, 'r');
    try {
        const buffer = Buffer.alloc(128 * 1024);
        const bytesRead = fs.readSync(file, buffer, 0, buffer.length, 0);
        return buffer.subarray(0, bytesRead).toString('utf8');
    } finally {
        fs.closeSync(file);
    }
}

function readReviewCycleArtifactContentForVerdict(resolvedArtifactPath: string): string {
    const prefix = readReviewCycleArtifactPrefix(resolvedArtifactPath);
    return prefix.trimStart().startsWith('{')
        ? fs.readFileSync(resolvedArtifactPath, 'utf8')
        : prefix;
}

function getReviewCycleArtifactVerdict(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    details: Record<string, unknown> | null,
    verdictCache: Map<string, ReviewCycleArtifactVerdictResult>
): ReviewCycleArtifactVerdictResult {
    const passToken = REVIEW_VERDICT_PASS_TOKENS[reviewType] || '';
    const failToken = REVIEW_VERDICT_FAIL_TOKENS[reviewType] || '';
    if (!passToken || !failToken) {
        return { failed: null, invalidSnapshot: false };
    }
    const artifactResolution = resolveValidatedReviewCycleArtifactForVerdict({
        repoRoot,
        taskId,
        reviewType,
        details
    });
    if (artifactResolution.invalidSnapshot) {
        return { failed: null, invalidSnapshot: true };
    }
    const resolvedArtifactPath = artifactResolution.resolvedPath;
    if (!resolvedArtifactPath) {
        return { failed: null, invalidSnapshot: false };
    }
    const cacheKey = `${reviewType}|${resolvedArtifactPath}`;
    const cached = verdictCache.get(cacheKey);
    if (cached !== undefined) {
        return cached;
    }
    const content = readReviewCycleArtifactContentForVerdict(resolvedArtifactPath);
    const jsonValidation = validateJsonReviewFindingsArtifact({
        content,
        expectedTaskId: taskId,
        expectedReviewType: reviewType,
        expectedReviewContextSha256: getTimelineReviewContextSha256(details) || undefined,
        expectedTreeStateSha256: normalizeReviewCycleSha256(
            details?.review_tree_state_sha256 ?? details?.reviewTreeStateSha256
        ) || undefined,
        coverageContract: readReviewCycleContextCoverageContract(repoRoot, taskId, reviewType, details)
    });
    if (jsonValidation.detected) {
        const result = {
            failed: jsonValidation.report
                ? jsonReviewFindingsArtifactHasActiveFindings(jsonValidation.report)
                : null,
            invalidSnapshot: false
        };
        verdictCache.set(cacheKey, result);
        return result;
    }
    if (!content.includes(passToken) && !content.includes(failToken)) {
        const result = { failed: null, invalidSnapshot: false };
        verdictCache.set(cacheKey, result);
        return result;
    }
    const verdictToken = extractReviewVerdictToken(content, passToken, failToken, reviewType);
    const result = {
        failed: verdictToken === failToken
            ? true
            : verdictToken === passToken
                ? false
                : null,
        invalidSnapshot: false
    };
    verdictCache.set(cacheKey, result);
    return result;
}

function parseReviewCycleTimelineLine(line: string, sequence: number): TimelineEventEntry | null {
    const parsed = JSON.parse(line) as Record<string, unknown>;
    const eventType = String(parsed.event_type || '').trim().toUpperCase();
    if (!eventType) {
        return null;
    }
    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
        ? parsed.details as Record<string, unknown>
        : null;
    return {
        event_type: eventType,
        outcome: String(parsed.outcome || '').trim().toUpperCase() || undefined,
        timestamp_utc: String(parsed.timestamp_utc || '').trim(),
        sequence,
        details
    };
}

function buildLatestFailedReviewSummary(
    event: TimelineEventEntry,
    reviewType: string,
    details: Record<string, unknown> | null
): NextStepReviewCycleLatestFailedReview {
    return {
        review_type: reviewType,
        event_type: event.event_type,
        outcome: event.outcome || null,
        verdict_token: getTimelineDetailText(details, ['verdict_token', 'verdictToken']),
        reviewer_identity: getTimelineReviewerIdentity(details) || null,
        review_artifact_path: getTimelineDetailText(details, ['review_artifact_path', 'reviewArtifactPath']),
        summary: getTimelineDetailText(details, ['summary', 'finding_summary', 'findingSummary', 'reason', 'message']),
        sequence: event.sequence,
        timestamp_utc: event.timestamp_utc || null
    };
}

export function readReviewCycleGuardAttempts(
    repoRoot: string,
    timelinePath: string,
    taskId: string,
    reviewCycleGuardConfig: ReviewCycleGuardConfig,
    currentPreflightFingerprints: DomainScopeFingerprints | null
): ReviewCycleGuardReadResult {
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            attempts: [],
            timelineValid: false,
            latestFailedReview: null
        };
    }

    const attemptsByKey = new Map<string, {
        reviewType: string;
        failed: boolean;
        passed: boolean;
        latestEventFailed: boolean;
        reused: boolean;
        scopeHash: string | null;
        currentScope: boolean;
        lastSequence: number;
    }>();
    const verdictCache = new Map<string, ReviewCycleArtifactVerdictResult>();
    const excludedReviewTypes = new Set(reviewCycleGuardConfig.excluded_review_types.map((entry) => entry.trim().toLowerCase()).filter(Boolean));
    let malformedReviewCycleEvent = false;
    let latestFailedReview: NextStepReviewCycleLatestFailedReview | null = null;
    let sequence = 0;
    let pending = '';
    const file = fs.openSync(resolvedPath, 'r');
    const buffer = Buffer.alloc(64 * 1024);

    const handleLine = (rawLine: string): boolean => {
        const line = rawLine.trim();
        if (!line) {
            return false;
        }
        let event: TimelineEventEntry | null = null;
        try {
            event = parseReviewCycleTimelineLine(line, sequence);
        } catch {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        } finally {
            sequence += 1;
        }
        if (!event || event.event_type !== 'REVIEW_RECORDED') {
            return false;
        }
        const reviewType = getTimelineReviewType(event.details);
        if (!reviewType) {
            malformedReviewCycleEvent = true;
            return reviewCycleGuardConfig.action === 'BLOCK_FOR_OPERATOR_DECISION';
        }
        const reviewerIdentity = getTimelineReviewerIdentity(event.details);
        const reviewContextSha256 = getTimelineReviewContextSha256(event.details);
        const key = reviewerIdentity && reviewContextSha256
            ? `${reviewType}|${reviewerIdentity}|${reviewContextSha256}`
            : `${event.event_type}:${event.sequence}`;
        const timelineFailure = getTimelineReviewFailure(event.event_type, event.details, event.outcome || null);
        const hasArtifactEvidence = Boolean(getTimelineDetailText(event.details, [
            'review_artifact_snapshot_path',
            'reviewArtifactSnapshotPath',
            'review_artifact_path',
            'reviewArtifactPath'
        ]));
        const artifactVerdict = event.event_type === 'REVIEW_RECORDED' && hasArtifactEvidence
            ? getReviewCycleArtifactVerdict(repoRoot, taskId, reviewType, event.details, verdictCache)
            : { failed: null, invalidSnapshot: false };
        if (artifactVerdict.invalidSnapshot) {
            malformedReviewCycleEvent = true;
        }
        const failed = timelineFailure ?? artifactVerdict.failed ?? false;
        const hasReviewArtifactPath = Boolean(getTimelineDetailText(event.details, ['review_artifact_path', 'reviewArtifactPath']));
        const passed = !failed && (
            timelineFailure === false
            || artifactVerdict.failed === false
            || (event.outcome === 'PASS' && !hasReviewArtifactPath)
        );
        const reused = event.details?.reused_existing_review === true || event.details?.reusedExistingReview === true;
        const scopeHash = getReviewCycleAttemptScopeHash(reviewType, event.details);
        const currentScope = reviewCycleAttemptMatchesCurrentScope(reviewType, event.details, currentPreflightFingerprints);
        const existing = attemptsByKey.get(key);
        const existingFailed = Boolean(existing?.failed);
        const existingPassed = Boolean(existing?.passed);
        const nextFailed = Boolean(existingFailed || failed);
        const nextPassed = Boolean(!nextFailed && (existingPassed || passed));
        attemptsByKey.set(key, {
            reviewType,
            failed: nextFailed,
            passed: nextPassed,
            latestEventFailed: Boolean(failed),
            reused: existing ? Boolean(existing.reused && reused) : reused,
            scopeHash: existing?.scopeHash || scopeHash,
            currentScope: Boolean(existing?.currentScope || currentScope),
            lastSequence: event.sequence
        });
        const countedReviewType = reviewType.trim().toLowerCase();
        const countsTowardGuard = countedReviewType && !excludedReviewTypes.has(countedReviewType);
        if (!existingFailed && nextFailed && countsTowardGuard && !reused) {
            latestFailedReview = buildLatestFailedReviewSummary(event, countedReviewType, event.details);
        }
        return false;
    };

    try {
        let bytesRead = 0;
        do {
            bytesRead = fs.readSync(file, buffer, 0, buffer.length, null);
            if (bytesRead <= 0) {
                break;
            }
            pending += buffer.subarray(0, bytesRead).toString('utf8');
            let newlineIndex = pending.indexOf('\n');
            while (newlineIndex >= 0) {
                const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
                pending = pending.slice(newlineIndex + 1);
                if (handleLine(line)) {
                    return {
                        attempts: [...attemptsByKey.values()].sort((left, right) => left.lastSequence - right.lastSequence),
                        timelineValid: !malformedReviewCycleEvent,
                        latestFailedReview
                    };
                }
                newlineIndex = pending.indexOf('\n');
            }
        } while (bytesRead > 0);
        if (pending.trim() && handleLine(pending.replace(/\r$/, ''))) {
            return {
                attempts: [...attemptsByKey.values()].sort((left, right) => left.lastSequence - right.lastSequence),
                timelineValid: !malformedReviewCycleEvent,
                latestFailedReview
            };
        }
    } finally {
        fs.closeSync(file);
    }

    return {
        attempts: [...attemptsByKey.values()].sort((left, right) => left.lastSequence - right.lastSequence),
        timelineValid: !malformedReviewCycleEvent,
        latestFailedReview
    };
}
