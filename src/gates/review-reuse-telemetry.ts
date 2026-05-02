import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, joinOrchestratorPath, normalizePath } from './helpers';

export interface ReviewReuseTelemetryEventLike {
    event_type?: unknown;
    sequence?: unknown;
    details?: unknown;
    integrity?: unknown;
}

export interface ReviewReuseTelemetryMatchInput {
    event: ReviewReuseTelemetryEventLike | null | undefined;
    reviewType: string;
    receiptPath: string;
    reviewContextSha256?: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256?: string | null;
    reusedFromReceiptPath?: string | null;
    reusedFromReceiptSha256?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256?: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    minTaskSequenceExclusive?: number | null;
    minEventSequenceExclusive?: number | null;
}

export interface ReviewReuseTelemetryMatchResult {
    matched: boolean;
    hasIntegrity: boolean;
    taskSequence: number | null;
    eventSha256: string | null;
    reason: string | null;
}

export interface ReviewReuseTelemetryDetails {
    reviewType: string;
    receiptPath: string;
    reviewContextSha256: string;
    reviewContextReuseSha256: string;
    reviewTreeStateSha256: string;
    reviewScopeSha256: string;
    codeScopeSha256: string;
    reviewArtifactSha256: string;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string;
    reusedFromReceiptSha256: string;
    reusedFromReviewContextSha256: string;
    reusedFromReviewContextReuseSha256: string;
    reusedFromReviewTreeStateSha256: string;
    reusedFromReviewScopeSha256: string;
    reusedFromCodeScopeSha256: string;
}

export interface HistoricalReviewRecordedTelemetryMatchInput {
    event: ReviewReuseTelemetryEventLike | null | undefined;
    repoRoot?: string | null;
    taskId?: string | null;
    reviewType: string;
    receiptPath: string;
    reviewContextSha256: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256: string | null;
    reusedFromReceiptPath?: string | null;
    reusedFromReceiptSha256?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256?: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    reviewerExecutionMode?: string | null;
    reviewerIdentity?: string | null;
    reviewerProvenance?: Record<string, unknown> | null;
    maxEventSequenceExclusive?: number | null;
    verifyReceiptSnapshot?: boolean;
}

export type HistoricalReviewRecordedSnapshotValidation =
    | {
        valid: true;
        reason: null;
        message: null;
        resolvedPath: string;
        expectedSha256: string;
        actualSha256: string;
    }
    | {
        valid: false;
        reason: string;
        message: string;
        resolvedPath: string | null;
        expectedSha256: string | null;
        actualSha256: string | null;
    };

export type HistoricalReviewRecordedRuntimeReviewPathValidation =
    | {
        valid: true;
        reason: null;
        message: null;
        resolvedPath: string;
    }
    | {
        valid: false;
        reason: string;
        message: string;
        resolvedPath: string | null;
    };

export function getReviewReuseTelemetryDetails(details: unknown): ReviewReuseTelemetryDetails {
    const record = isPlainRecord(details) ? details : {};
    return {
        reviewType: normalizeLowerString(record.review_type ?? record.reviewType),
        receiptPath: normalizePath(record.receipt_path ?? record.receiptPath ?? '').toLowerCase(),
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

export function validateHistoricalReviewRecordedTelemetryEventMatch(
    input: HistoricalReviewRecordedTelemetryMatchInput
): ReviewReuseTelemetryMatchResult {
    const event = input.event;
    const integrity = isPlainRecord(event?.integrity) ? event?.integrity : {};
    const taskSequence = normalizeTaskSequence(integrity);
    const eventSha256 = normalizeLowerString(integrity.event_sha256);
    const hasIntegrity = Number.isInteger(taskSequence) && !!eventSha256 && /^[0-9a-f]{64}$/.test(eventSha256);
    const base = {
        hasIntegrity,
        taskSequence,
        eventSha256: eventSha256 || null
    };
    if (!event) {
        return { ...base, matched: false, reason: 'missing_event' };
    }
    if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
        return { ...base, matched: false, reason: 'wrong_event_type' };
    }
    if (!hasIntegrity) {
        return { ...base, matched: false, reason: 'missing_integrity' };
    }
    const eventSequence = normalizeEventSequence(event.sequence);
    if (input.maxEventSequenceExclusive != null && eventSequence != null && eventSequence >= input.maxEventSequenceExclusive) {
        return { ...base, matched: false, reason: 'after_max_event_sequence' };
    }

    const details = isPlainRecord(event.details) ? event.details : {};
    const expectedTaskId = String(input.taskId || '').trim();
    const eventTaskId = String(details.task_id ?? details.taskId ?? '').trim();
    const expectedReviewType = normalizeLowerString(input.reviewType);
    const expectedReceiptPath = normalizePath(input.receiptPath).toLowerCase();
    const expectedReviewContextSha256 = normalizeLowerString(input.reviewContextSha256);
    const expectedReviewContextReuseSha256 = normalizeLowerString(input.reviewContextReuseSha256);
    const expectedReviewTreeStateSha256 = normalizeLowerString(input.reviewTreeStateSha256);
    const expectedReviewScopeSha256 = normalizeLowerString(input.reviewScopeSha256);
    const expectedCodeScopeSha256 = normalizeLowerString(input.codeScopeSha256);
    const expectedReviewArtifactSha256 = normalizeLowerString(input.reviewArtifactSha256);
    const expectedExecutionMode = normalizeLowerString(input.reviewerExecutionMode);
    const expectedReviewerIdentity = String(input.reviewerIdentity || '').trim();
    const eventReviewerIdentity = String(
        details.reviewer_identity
            ?? details.reviewerIdentity
            ?? details.reviewer_session_id
            ?? details.reviewerSessionId
            ?? ''
    ).trim();
    const eventProvenance = isPlainRecord(details.reviewer_provenance ?? details.reviewerProvenance)
        ? details.reviewer_provenance ?? details.reviewerProvenance
        : null;
    const expectedProvenance = isPlainRecord(input.reviewerProvenance)
        ? input.reviewerProvenance
        : null;
    const expectedReusedFromReceiptPath = normalizePath(input.reusedFromReceiptPath || '').toLowerCase();
    const expectedReusedFromReceiptSha256 = normalizeLowerString(input.reusedFromReceiptSha256);
    const expectedReusedFromReviewContextSha256 = normalizeLowerString(input.reusedFromReviewContextSha256);
    const expectedReusedFromReviewContextReuseSha256 = normalizeLowerString(input.reusedFromReviewContextReuseSha256);
    const expectedReusedFromReviewTreeStateSha256 = normalizeLowerString(input.reusedFromReviewTreeStateSha256);
    const expectedReusedFromReviewScopeSha256 = normalizeLowerString(input.reusedFromReviewScopeSha256);
    const expectedReusedFromCodeScopeSha256 = normalizeLowerString(input.reusedFromCodeScopeSha256);

    if (
        (expectedTaskId && eventTaskId !== expectedTaskId)
        || normalizeLowerString(details.review_type ?? details.reviewType) !== expectedReviewType
        || normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase() !== expectedReceiptPath
        || normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256) !== expectedReviewContextSha256
        || (input.reviewContextReuseSha256 !== undefined
            && normalizeLowerString(details.review_context_reuse_sha256 ?? details.reviewContextReuseSha256) !== expectedReviewContextReuseSha256)
        || (input.reviewTreeStateSha256 !== undefined
            && normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256) !== expectedReviewTreeStateSha256)
        || (input.reviewScopeSha256 !== undefined
            && normalizeLowerString(details.review_scope_sha256 ?? details.reviewScopeSha256) !== expectedReviewScopeSha256)
        || (input.codeScopeSha256 !== undefined
            && normalizeLowerString(details.code_scope_sha256 ?? details.codeScopeSha256) !== expectedCodeScopeSha256)
        || normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256) !== expectedReviewArtifactSha256
        || (expectedReusedFromReceiptPath
            && normalizePath(details.reused_from_receipt_path ?? details.reusedFromReceiptPath ?? '').toLowerCase() !== expectedReusedFromReceiptPath)
        || (input.reusedFromReceiptSha256 !== undefined
            && normalizeLowerString(details.reused_from_receipt_sha256 ?? details.reusedFromReceiptSha256) !== expectedReusedFromReceiptSha256)
        || (expectedReusedFromReviewContextSha256
            && normalizeLowerString(details.reused_from_review_context_sha256 ?? details.reusedFromReviewContextSha256) !== expectedReusedFromReviewContextSha256)
        || (expectedReusedFromReviewContextReuseSha256
            && normalizeLowerString(details.reused_from_review_context_reuse_sha256 ?? details.reusedFromReviewContextReuseSha256) !== expectedReusedFromReviewContextReuseSha256)
        || (expectedReusedFromReviewTreeStateSha256
            && normalizeLowerString(details.reused_from_review_tree_state_sha256 ?? details.reusedFromReviewTreeStateSha256) !== expectedReusedFromReviewTreeStateSha256)
        || (input.reusedFromReviewScopeSha256 !== undefined
            && normalizeLowerString(details.reused_from_review_scope_sha256 ?? details.reusedFromReviewScopeSha256) !== expectedReusedFromReviewScopeSha256)
        || (input.reusedFromCodeScopeSha256 !== undefined
            && normalizeLowerString(details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256) !== expectedReusedFromCodeScopeSha256)
        || (expectedExecutionMode && normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== expectedExecutionMode)
        || (expectedReviewerIdentity && eventReviewerIdentity !== expectedReviewerIdentity)
    ) {
        return { ...base, matched: false, reason: 'details_mismatch' };
    }
    if (expectedProvenance && !reviewerProvenanceMatches(eventProvenance, expectedProvenance)) {
        return { ...base, matched: false, reason: 'provenance_mismatch' };
    }
    if (input.verifyReceiptSnapshot === true) {
        const reviewArtifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, {
            taskId: expectedTaskId || eventTaskId,
            reviewType: input.reviewType
        });
        if (!reviewArtifactValidation.valid) {
            return { ...base, matched: false, reason: reviewArtifactValidation.reason };
        }
        const receiptSnapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, {
            taskId: expectedTaskId || eventTaskId,
            reviewType: input.reviewType
        });
        if (!receiptSnapshotValidation.valid) {
            return { ...base, matched: false, reason: receiptSnapshotValidation.reason };
        }
    }
    return { ...base, matched: true, reason: null };
}

export function validateReviewReuseRecordedEventMatch(
    input: ReviewReuseTelemetryMatchInput
): ReviewReuseTelemetryMatchResult {
    const event = input.event;
    const taskSequence = normalizeTaskSequence(event?.integrity);
    const integrity = isPlainRecord(event?.integrity) ? event?.integrity : {};
    const eventSha256 = normalizeLowerString(integrity.event_sha256);
    const hasIntegrity = Number.isInteger(taskSequence) && !!eventSha256 && /^[0-9a-f]{64}$/.test(eventSha256);
    const base = {
        hasIntegrity,
        taskSequence,
        eventSha256: eventSha256 || null
    };
    if (!event) {
        return { ...base, matched: false, reason: 'missing_event' };
    }
    if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
        return { ...base, matched: false, reason: 'wrong_event_type' };
    }
    if (!hasIntegrity) {
        return { ...base, matched: false, reason: 'missing_integrity' };
    }
    if (input.minTaskSequenceExclusive != null && taskSequence != null && taskSequence <= input.minTaskSequenceExclusive) {
        return { ...base, matched: false, reason: 'before_min_task_sequence' };
    }
    const eventSequence = normalizeEventSequence(event.sequence);
    if (input.minEventSequenceExclusive != null && eventSequence != null && eventSequence <= input.minEventSequenceExclusive) {
        return { ...base, matched: false, reason: 'before_min_event_sequence' };
    }

    const actual = getReviewReuseTelemetryDetails(event.details);
    const expectedReviewType = normalizeLowerString(input.reviewType);
    const expectedReceiptPath = normalizePath(input.receiptPath).toLowerCase();
    const expectedReviewContextSha256 = normalizeLowerString(input.reviewContextSha256);
    const expectedReviewContextReuseSha256 = normalizeLowerString(input.reviewContextReuseSha256);
    const expectedReviewTreeStateSha256 = normalizeLowerString(input.reviewTreeStateSha256);
    const expectedReviewScopeSha256 = normalizeLowerString(input.reviewScopeSha256);
    const expectedCodeScopeSha256 = normalizeLowerString(input.codeScopeSha256);
    const expectedReviewArtifactSha256 = normalizeLowerString(input.reviewArtifactSha256);
    const expectedReusedFromReceiptPath = normalizePath(input.reusedFromReceiptPath || '').toLowerCase();
    const expectedReusedFromReceiptSha256 = normalizeLowerString(input.reusedFromReceiptSha256);
    const expectedReusedFromReviewContextSha256 = normalizeLowerString(input.reusedFromReviewContextSha256);
    const expectedReusedFromReviewContextReuseSha256 = normalizeLowerString(input.reusedFromReviewContextReuseSha256);
    const expectedReusedFromReviewTreeStateSha256 = normalizeLowerString(input.reusedFromReviewTreeStateSha256);
    const expectedReusedFromReviewScopeSha256 = normalizeLowerString(input.reusedFromReviewScopeSha256);
    const expectedReusedFromCodeScopeSha256 = normalizeLowerString(input.reusedFromCodeScopeSha256);

    if (
        actual.reviewType !== expectedReviewType
        || actual.reusedExistingReview !== true
        || actual.receiptPath !== expectedReceiptPath
        || (expectedReviewContextSha256 && actual.reviewContextSha256 !== expectedReviewContextSha256)
        || (input.reviewContextReuseSha256 !== undefined && actual.reviewContextReuseSha256 !== expectedReviewContextReuseSha256)
        || (input.reviewTreeStateSha256 !== undefined && actual.reviewTreeStateSha256 !== expectedReviewTreeStateSha256)
        || (input.reviewScopeSha256 !== undefined && actual.reviewScopeSha256 !== expectedReviewScopeSha256)
        || (input.codeScopeSha256 !== undefined && actual.codeScopeSha256 !== expectedCodeScopeSha256)
        || (expectedReviewArtifactSha256 && actual.reviewArtifactSha256 !== expectedReviewArtifactSha256)
        || (expectedReusedFromReceiptPath && actual.reusedFromReceiptPath !== expectedReusedFromReceiptPath)
        || (input.reusedFromReceiptSha256 !== undefined && actual.reusedFromReceiptSha256 !== expectedReusedFromReceiptSha256)
        || (expectedReusedFromReviewContextSha256 && actual.reusedFromReviewContextSha256 !== expectedReusedFromReviewContextSha256)
        || (expectedReusedFromReviewContextReuseSha256 && actual.reusedFromReviewContextReuseSha256 !== expectedReusedFromReviewContextReuseSha256)
        || (expectedReusedFromReviewTreeStateSha256 && actual.reusedFromReviewTreeStateSha256 !== expectedReusedFromReviewTreeStateSha256)
        || (input.reusedFromReviewScopeSha256 !== undefined
            && actual.reusedFromReviewScopeSha256 !== expectedReusedFromReviewScopeSha256)
        || (input.reusedFromCodeScopeSha256 !== undefined
            && actual.reusedFromCodeScopeSha256 !== expectedReusedFromCodeScopeSha256)
    ) {
        return { ...base, matched: false, reason: 'details_mismatch' };
    }
    return { ...base, matched: true, reason: null };
}

export function findMatchingHistoricalReviewRecordedTelemetryEvent<T extends ReviewReuseTelemetryEventLike>(
    events: readonly T[],
    options: Omit<HistoricalReviewRecordedTelemetryMatchInput, 'event'>
): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventSequence = normalizeEventSequence(event.sequence);
        if (options.maxEventSequenceExclusive != null && eventSequence != null && eventSequence >= options.maxEventSequenceExclusive) {
            continue;
        }
        if (validateHistoricalReviewRecordedTelemetryEventMatch({ ...options, event }).matched) {
            return event;
        }
    }
    return null;
}

export function findMatchingReviewReuseRecordedTelemetryEvent<T extends ReviewReuseTelemetryEventLike>(
    events: readonly T[],
    options: Omit<ReviewReuseTelemetryMatchInput, 'event'>
): T | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventSequence = normalizeEventSequence(event.sequence);
        if (options.minEventSequenceExclusive != null && eventSequence != null && eventSequence <= options.minEventSequenceExclusive) {
            break;
        }
        if (validateReviewReuseRecordedEventMatch({ ...options, event }).matched) {
            return event;
        }
    }
    return null;
}

function normalizeEventType(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function normalizeLowerString(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function normalizeTaskSequence(integrity: unknown): number | null {
    const record = isPlainRecord(integrity) ? integrity : {};
    const sequence = typeof record.task_sequence === 'number'
        ? record.task_sequence
        : Number(record.task_sequence);
    return Number.isInteger(sequence) ? sequence : null;
}

function normalizeEventSequence(value: unknown): number | null {
    const sequence = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(sequence) ? sequence : null;
}

function normalizePathForComparison(value: string): string {
    const resolved = path.resolve(value);
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathsEqual(left: string, right: string): boolean {
    return normalizePathForComparison(left) === normalizePathForComparison(right);
}

function pathIsInsideOrEqual(candidatePath: string, rootPath: string): boolean {
    const normalizedCandidate = normalizePathForComparison(candidatePath);
    const normalizedRoot = normalizePathForComparison(rootPath);
    const relativePath = path.relative(normalizedRoot, normalizedCandidate);
    return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath));
}

function hasParentPathSegment(rawPath: string): boolean {
    return rawPath.replace(/\\/g, '/').split('/').includes('..');
}

function normalizeArtifactSegment(value: unknown): string {
    return String(value || '').trim();
}

function isSafeArtifactSegment(value: string): boolean {
    return /^[A-Za-z0-9._-]+$/.test(value) && !value.includes('..');
}

export function validateHistoricalReviewRecordedRuntimeReviewPath(options: {
    repoRoot?: string | null;
    rawPath: unknown;
    taskId?: string | null;
    reviewType?: string | null;
    expectedFileName: string;
    artifactLabel: string;
    missingReason: string;
    hashForMessage?: string | null;
}): HistoricalReviewRecordedRuntimeReviewPathValidation {
    const rawPath = String(options.rawPath || '').trim();
    const artifactLabel = String(options.artifactLabel || 'historical review artifact').trim();
    const expectedFileName = String(options.expectedFileName || '').trim();
    const taskId = normalizeArtifactSegment(options.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType).toLowerCase();
    if (!rawPath) {
        return {
            valid: false,
            reason: options.missingReason,
            message: `${artifactLabel} path is missing from REVIEW_RECORDED telemetry`,
            resolvedPath: null
        };
    }
    if (!isSafeArtifactSegment(taskId) || !isSafeArtifactSegment(reviewType) || !expectedFileName) {
        return {
            valid: false,
            reason: `${options.missingReason}_expected_identity_invalid`,
            message: `${artifactLabel} cannot be validated because task or review identity is invalid`,
            resolvedPath: null
        };
    }
    const root = String(options.repoRoot || '').trim();
    if (!root) {
        return {
            valid: false,
            reason: `${options.missingReason}_repo_root_missing`,
            message: `${artifactLabel} path cannot be validated because repo root is unavailable`,
            resolvedPath: null
        };
    }
    if (hasParentPathSegment(rawPath)) {
        return {
            valid: false,
            reason: `${options.missingReason}_path_traversal`,
            message: `${artifactLabel} path must not contain parent-directory traversal segments`,
            resolvedPath: null
        };
    }
    const reviewsRoot = path.resolve(joinOrchestratorPath(root, path.join('runtime', 'reviews')));
    const expectedPath = path.join(reviewsRoot, expectedFileName);
    const resolvedPath = path.isAbsolute(rawPath)
        ? path.resolve(rawPath)
        : path.resolve(root, rawPath);
    if (!pathsEqual(resolvedPath, expectedPath)) {
        return {
            valid: false,
            reason: `${options.missingReason}_noncanonical_path`,
            message: `${artifactLabel} path must reference canonical runtime review artifact ${normalizePath(expectedPath)}`,
            resolvedPath
        };
    }
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        return {
            valid: false,
            reason: `${options.missingReason}_missing`,
            message: `${artifactLabel} is missing at ${normalizePath(resolvedPath)}`,
            resolvedPath
        };
    }
    const realReviewsRoot = fs.existsSync(reviewsRoot)
        ? fs.realpathSync.native(reviewsRoot)
        : reviewsRoot;
    const realResolvedPath = fs.realpathSync.native(resolvedPath);
    if (!pathIsInsideOrEqual(realResolvedPath, realReviewsRoot)) {
        return {
            valid: false,
            reason: `${options.missingReason}_realpath_escape`,
            message: `${artifactLabel} real path escapes the runtime review artifacts directory`,
            resolvedPath
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath
    };
}

export function validateHistoricalReviewRecordedReviewArtifactPath(
    details: Record<string, unknown>,
    repoRoot?: string | null,
    options: { taskId?: string | null; reviewType?: string | null } = {}
): HistoricalReviewRecordedSnapshotValidation {
    const taskId = normalizeArtifactSegment(options.taskId ?? details.task_id ?? details.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType ?? details.review_type ?? details.reviewType).toLowerCase();
    const artifactPathRaw = String(
        details.review_artifact_snapshot_path
            ?? details.reviewArtifactSnapshotPath
            ?? ''
    ).trim();
    const expectedSha256 = normalizeLowerString(
        details.review_artifact_snapshot_sha256
            ?? details.reviewArtifactSnapshotSha256
    );
    if (!artifactPathRaw) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_path_missing',
            message: 'historical review artifact snapshot path is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: expectedSha256 || null,
            actualSha256: null
        };
    }
    if (!expectedSha256) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_missing',
            message: 'historical review artifact snapshot hash is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: null,
            actualSha256: null
        };
    }
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_invalid',
            message: `historical review artifact snapshot hash is invalid in REVIEW_RECORDED telemetry: ${expectedSha256}`,
            resolvedPath: null,
            expectedSha256,
            actualSha256: null
        };
    }
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot,
        rawPath: artifactPathRaw,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-artifact-${expectedSha256}.md`,
        artifactLabel: 'historical review artifact snapshot',
        missingReason: 'review_artifact_snapshot_path'
    });
    if (!pathValidation.valid) {
        return {
            valid: false,
            reason: pathValidation.reason,
            message: pathValidation.message,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: null
        };
    }
    const actualSha256 = normalizeLowerString(fileSha256(pathValidation.resolvedPath));
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: 'review_artifact_snapshot_hash_mismatch',
            message: `historical review artifact snapshot hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256 || 'missing'})`,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: actualSha256 || null
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath: pathValidation.resolvedPath,
        expectedSha256,
        actualSha256
    };
}

export function validateHistoricalReviewRecordedReceiptSnapshot(
    details: Record<string, unknown>,
    repoRoot?: string | null,
    options: { taskId?: string | null; reviewType?: string | null } = {}
): HistoricalReviewRecordedSnapshotValidation {
    const receiptPathRaw = String(
        details.receipt_snapshot_path
            ?? details.receiptSnapshotPath
            ?? ''
    ).trim();
    const expectedSha256 = normalizeLowerString(
        details.receipt_snapshot_sha256
            ?? details.receiptSnapshotSha256
    );
    if (!receiptPathRaw) {
        return {
            valid: false,
            reason: 'receipt_snapshot_path_missing',
            message: 'historical review receipt snapshot path is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: expectedSha256 || null,
            actualSha256: null
        };
    }
    if (!expectedSha256) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_missing',
            message: 'historical review receipt snapshot hash is missing from REVIEW_RECORDED telemetry',
            resolvedPath: null,
            expectedSha256: null,
            actualSha256: null
        };
    }
    if (!/^[0-9a-f]{64}$/.test(expectedSha256)) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_invalid',
            message: `historical review receipt snapshot hash is invalid in REVIEW_RECORDED telemetry: ${expectedSha256}`,
            resolvedPath: null,
            expectedSha256,
            actualSha256: null
        };
    }
    const taskId = normalizeArtifactSegment(options.taskId ?? details.task_id ?? details.taskId);
    const reviewType = normalizeArtifactSegment(options.reviewType ?? details.review_type ?? details.reviewType).toLowerCase();
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot,
        rawPath: receiptPathRaw,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt-${expectedSha256}.json`,
        artifactLabel: 'historical review receipt snapshot',
        missingReason: 'receipt_snapshot_path'
    });
    if (!pathValidation.valid) {
        return {
            valid: false,
            reason: pathValidation.reason,
            message: pathValidation.message,
            resolvedPath: pathValidation.resolvedPath,
            expectedSha256,
            actualSha256: null
        };
    }
    const resolvedPath = pathValidation.resolvedPath;
    const actualSha256 = normalizeLowerString(fileSha256(resolvedPath));
    if (actualSha256 !== expectedSha256) {
        return {
            valid: false,
            reason: 'receipt_snapshot_hash_mismatch',
            message: `historical review receipt snapshot hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256 || 'missing'})`,
            resolvedPath,
            expectedSha256,
            actualSha256: actualSha256 || null
        };
    }
    return {
        valid: true,
        reason: null,
        message: null,
        resolvedPath,
        expectedSha256,
        actualSha256
    };
}

function reviewerProvenanceMatches(actual: unknown, expected: Record<string, unknown>): boolean {
    const actualRecord = isPlainRecord(actual) ? actual : {};
    const stringFields = [
        'attestation_type',
        'controller_event_type',
        'event_sha256',
        'prev_event_sha256',
        'task_id',
        'review_type',
        'reviewer_execution_mode',
        'reviewer_identity',
        'review_context_sha256',
        'routing_event_sha256'
    ];
    for (const field of stringFields) {
        const actualValue = actualRecord[field] == null
            ? null
            : String(actualRecord[field]).trim().toLowerCase() || null;
        const expectedValue = expected[field] == null
            ? null
            : String(expected[field]).trim().toLowerCase() || null;
        if (actualValue !== expectedValue) {
            return false;
        }
    }
    const actualTaskSequence = normalizeEventSequence(actualRecord.task_sequence);
    const expectedTaskSequence = normalizeEventSequence(expected.task_sequence);
    return actualTaskSequence === expectedTaskSequence;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}
