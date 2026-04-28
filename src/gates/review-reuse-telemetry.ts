import { normalizePath } from './helpers';

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
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256?: string | null;
    reusedFromReceiptPath?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
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
    reviewScopeSha256: string;
    codeScopeSha256: string;
    reviewArtifactSha256: string;
    reusedExistingReview: boolean;
    reusedFromReceiptPath: string;
    reusedFromReviewContextSha256: string;
    reusedFromReviewContextReuseSha256: string;
    reusedFromReviewScopeSha256: string;
    reusedFromCodeScopeSha256: string;
}

export interface HistoricalReviewRecordedTelemetryMatchInput {
    event: ReviewReuseTelemetryEventLike | null | undefined;
    taskId?: string | null;
    reviewType: string;
    receiptPath: string;
    reviewContextSha256: string | null;
    reviewContextReuseSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256: string | null;
    reviewerExecutionMode?: string | null;
    reviewerIdentity?: string | null;
    reviewerProvenance?: Record<string, unknown> | null;
    maxEventSequenceExclusive?: number | null;
}

export function getReviewReuseTelemetryDetails(details: unknown): ReviewReuseTelemetryDetails {
    const record = isPlainRecord(details) ? details : {};
    return {
        reviewType: normalizeLowerString(record.review_type ?? record.reviewType),
        receiptPath: normalizePath(record.receipt_path ?? record.receiptPath ?? '').toLowerCase(),
        reviewContextSha256: normalizeLowerString(record.review_context_sha256 ?? record.reviewContextSha256),
        reviewContextReuseSha256: normalizeLowerString(record.review_context_reuse_sha256 ?? record.reviewContextReuseSha256),
        reviewScopeSha256: normalizeLowerString(record.review_scope_sha256 ?? record.reviewScopeSha256),
        codeScopeSha256: normalizeLowerString(record.code_scope_sha256 ?? record.codeScopeSha256),
        reviewArtifactSha256: normalizeLowerString(record.review_artifact_sha256 ?? record.reviewArtifactSha256),
        reusedExistingReview: record.reused_existing_review === true,
        reusedFromReceiptPath: normalizePath(record.reused_from_receipt_path ?? record.reusedFromReceiptPath ?? '').toLowerCase(),
        reusedFromReviewContextSha256: normalizeLowerString(
            record.reused_from_review_context_sha256 ?? record.reusedFromReviewContextSha256
        ),
        reusedFromReviewContextReuseSha256: normalizeLowerString(
            record.reused_from_review_context_reuse_sha256 ?? record.reusedFromReviewContextReuseSha256
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

    if (
        (expectedTaskId && eventTaskId !== expectedTaskId)
        || normalizeLowerString(details.review_type ?? details.reviewType) !== expectedReviewType
        || normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase() !== expectedReceiptPath
        || normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256) !== expectedReviewContextSha256
        || (input.reviewContextReuseSha256 !== undefined
            && normalizeLowerString(details.review_context_reuse_sha256 ?? details.reviewContextReuseSha256) !== expectedReviewContextReuseSha256)
        || (input.reviewScopeSha256 !== undefined
            && normalizeLowerString(details.review_scope_sha256 ?? details.reviewScopeSha256) !== expectedReviewScopeSha256)
        || (input.codeScopeSha256 !== undefined
            && normalizeLowerString(details.code_scope_sha256 ?? details.codeScopeSha256) !== expectedCodeScopeSha256)
        || normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256) !== expectedReviewArtifactSha256
        || (expectedExecutionMode && normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== expectedExecutionMode)
        || (expectedReviewerIdentity && eventReviewerIdentity !== expectedReviewerIdentity)
    ) {
        return { ...base, matched: false, reason: 'details_mismatch' };
    }
    if (expectedProvenance && !reviewerProvenanceMatches(eventProvenance, expectedProvenance)) {
        return { ...base, matched: false, reason: 'provenance_mismatch' };
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
    const expectedReviewScopeSha256 = normalizeLowerString(input.reviewScopeSha256);
    const expectedCodeScopeSha256 = normalizeLowerString(input.codeScopeSha256);
    const expectedReviewArtifactSha256 = normalizeLowerString(input.reviewArtifactSha256);
    const expectedReusedFromReceiptPath = normalizePath(input.reusedFromReceiptPath || '').toLowerCase();
    const expectedReusedFromReviewContextSha256 = normalizeLowerString(input.reusedFromReviewContextSha256);
    const expectedReusedFromReviewContextReuseSha256 = normalizeLowerString(input.reusedFromReviewContextReuseSha256);
    const expectedReusedFromReviewScopeSha256 = normalizeLowerString(input.reusedFromReviewScopeSha256);
    const expectedReusedFromCodeScopeSha256 = normalizeLowerString(input.reusedFromCodeScopeSha256);

    if (
        actual.reviewType !== expectedReviewType
        || actual.reusedExistingReview !== true
        || actual.receiptPath !== expectedReceiptPath
        || (expectedReviewContextSha256 && actual.reviewContextSha256 !== expectedReviewContextSha256)
        || (input.reviewContextReuseSha256 !== undefined && actual.reviewContextReuseSha256 !== expectedReviewContextReuseSha256)
        || (input.reviewScopeSha256 !== undefined && actual.reviewScopeSha256 !== expectedReviewScopeSha256)
        || (input.codeScopeSha256 !== undefined && actual.codeScopeSha256 !== expectedCodeScopeSha256)
        || (expectedReviewArtifactSha256 && actual.reviewArtifactSha256 !== expectedReviewArtifactSha256)
        || (expectedReusedFromReceiptPath && actual.reusedFromReceiptPath !== expectedReusedFromReceiptPath)
        || (expectedReusedFromReviewContextSha256 && actual.reusedFromReviewContextSha256 !== expectedReusedFromReviewContextSha256)
        || (expectedReusedFromReviewContextReuseSha256 && actual.reusedFromReviewContextReuseSha256 !== expectedReusedFromReviewContextReuseSha256)
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
