import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch
} from '../gate-runtime/review-context';
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
    receiptSha256?: string | null;
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
    receiptSha256: string;
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
    receiptSha256?: string | null;
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
    maxTaskSequenceExclusive?: number | null;
    maxEventSequenceExclusive?: number | null;
    verifyReceiptSnapshot?: boolean;
}

export interface StrictReusedReviewEvidenceValidationInput {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    events: readonly ReviewReuseTelemetryEventLike[];
    receiptPath: string;
    receiptSha256?: string | null;
    reviewContextSha256: string | null;
    reviewContextReuseSha256?: string | null;
    reviewTreeStateSha256: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewArtifactSha256: string | null;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    reusedFromReviewContextSha256: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reviewerProvenance: Record<string, unknown> | null;
    latestCompileTaskSequence?: number | null;
    latestCompileEventSequence?: number | null;
}

export type StrictReusedReviewEvidenceValidationResult =
    | {
        valid: true;
        reason: null;
        currentReuseEventTaskSequence: number;
        currentReuseEventSha256: string;
        historicalReviewRecordedTaskSequence: number;
        historicalReviewRecordedEventSha256: string;
        historicalReviewerInvocationTaskSequence: number;
        historicalReviewerInvocationEventSha256: string;
    }
    | {
        valid: false;
        reason: string;
    };

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
    if (input.maxTaskSequenceExclusive != null && taskSequence != null && taskSequence >= input.maxTaskSequenceExclusive) {
        return { ...base, matched: false, reason: 'after_max_task_sequence' };
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
    const expectedReceiptSha256 = normalizeLowerString(input.receiptSha256);
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
        || (input.receiptSha256 !== undefined
            && normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256) !== expectedReceiptSha256)
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
        const snapshotBindingValidation = validateHistoricalReviewRecordedSnapshotBindings(details);
        if (!snapshotBindingValidation.valid) {
            return { ...base, matched: false, reason: snapshotBindingValidation.reason };
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
    const expectedReceiptSha256 = normalizeLowerString(input.receiptSha256);
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
        || (input.receiptSha256 !== undefined && actual.receiptSha256 !== expectedReceiptSha256)
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
        const taskSequence = normalizeTaskSequence(event.integrity);
        if (options.maxTaskSequenceExclusive != null && taskSequence != null && taskSequence >= options.maxTaskSequenceExclusive) {
            continue;
        }
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

export function validateStrictReusedReviewEvidence(
    input: StrictReusedReviewEvidenceValidationInput
): StrictReusedReviewEvidenceValidationResult {
    const inputError = validateStrictReusedReviewInput(input);
    if (inputError) {
        return { valid: false, reason: inputError };
    }
    const currentReceiptSha256 = resolveStrictCurrentReceiptSha256(input);
    if (!currentReceiptSha256.valid) {
        return { valid: false, reason: currentReceiptSha256.reason };
    }
    const currentReviewArtifactSha256 = resolveStrictCurrentReviewArtifactSha256(input);
    if (!currentReviewArtifactSha256.valid) {
        return { valid: false, reason: currentReviewArtifactSha256.reason };
    }
    const normalizedInput = {
        ...input,
        receiptSha256: currentReceiptSha256.sha256,
        reviewArtifactSha256: currentReviewArtifactSha256.sha256
    };
    const currentReuseEvent = findStrictCurrentReuseRecordedEvent(normalizedInput);
    if (!currentReuseEvent.valid) {
        return currentReuseEvent;
    }
    const historicalReviewRecordedEvent = findStrictHistoricalReviewRecordedSourceEvent(normalizedInput);
    if (!historicalReviewRecordedEvent.valid) {
        return historicalReviewRecordedEvent;
    }
    const historicalReviewerInvocationEvent = findStrictHistoricalReviewerInvocationEvent(normalizedInput);
    if (!historicalReviewerInvocationEvent.valid) {
        return historicalReviewerInvocationEvent;
    }
    return {
        valid: true,
        reason: null,
        currentReuseEventTaskSequence: currentReuseEvent.taskSequence,
        currentReuseEventSha256: currentReuseEvent.eventSha256,
        historicalReviewRecordedTaskSequence: historicalReviewRecordedEvent.taskSequence,
        historicalReviewRecordedEventSha256: historicalReviewRecordedEvent.eventSha256,
        historicalReviewerInvocationTaskSequence: historicalReviewerInvocationEvent.taskSequence,
        historicalReviewerInvocationEventSha256: historicalReviewerInvocationEvent.eventSha256
    };
}

type StrictEventEvidence =
    | { valid: true; taskSequence: number; eventSha256: string }
    | { valid: false; reason: string };

function validateStrictReusedReviewInput(input: StrictReusedReviewEvidenceValidationInput): string | null {
    const requiredShaFields: Array<[unknown, string]> = [
        [input.reviewContextSha256, 'current review_context_sha256'],
        [input.reviewContextReuseSha256, 'current review_context_reuse_sha256'],
        [input.reviewTreeStateSha256, 'current review_tree_state_sha256'],
        [input.reviewScopeSha256, 'current review_scope_sha256'],
        [input.reviewArtifactSha256, 'current review_artifact_sha256'],
        [input.reusedFromReceiptSha256, 'historical reused_from_receipt_sha256'],
        [input.reusedFromReviewContextSha256, 'historical reused_from_review_context_sha256'],
        [input.reusedFromReviewContextReuseSha256, 'historical reused_from_review_context_reuse_sha256'],
        [input.reusedFromReviewTreeStateSha256, 'historical reused_from_review_tree_state_sha256'],
        [input.reusedFromReviewScopeSha256, 'historical reused_from_review_scope_sha256']
    ];
    if (normalizeLowerString(input.reviewType) !== 'test') {
        requiredShaFields.push(
            [input.codeScopeSha256, 'current code_scope_sha256'],
            [input.reusedFromCodeScopeSha256, 'historical reused_from_code_scope_sha256']
        );
    }
    for (const [value, label] of requiredShaFields) {
        if (!isSha256(value)) {
            return `strict reused review evidence is missing ${label}`;
        }
    }
    if (input.receiptSha256 !== undefined && input.receiptSha256 !== null && !isSha256(input.receiptSha256)) {
        return 'strict reused review evidence has invalid current receipt_sha256';
    }
    if (input.codeScopeSha256 !== undefined && input.codeScopeSha256 !== null && !isSha256(input.codeScopeSha256)) {
        return 'strict reused review evidence has invalid current code_scope_sha256';
    }
    if (
        input.reusedFromCodeScopeSha256 !== undefined
        && input.reusedFromCodeScopeSha256 !== null
        && !isSha256(input.reusedFromCodeScopeSha256)
    ) {
        return 'strict reused review evidence has invalid historical reused_from_code_scope_sha256';
    }
    if (!String(input.receiptPath || '').trim()) {
        return 'strict reused review evidence is missing current receipt_path';
    }
    if (!String(input.reusedFromReceiptPath || '').trim()) {
        return 'strict reused review evidence is missing historical reused_from_receipt_path';
    }
    if (normalizeLowerString(input.reviewerExecutionMode) !== 'delegated_subagent') {
        return 'strict reused review evidence requires delegated_subagent reviewer execution mode';
    }
    const reviewerIdentity = String(input.reviewerIdentity || '').trim();
    if (!reviewerIdentity || !reviewerIdentity.startsWith('agent:')) {
        return 'strict reused review evidence requires delegated reviewer identity';
    }
    const provenance = isPlainRecord(input.reviewerProvenance) ? input.reviewerProvenance : null;
    if (!provenance) {
        return 'strict reused review evidence is missing preserved reviewer_provenance';
    }
    if (
        normalizeLowerString(provenance.attestation_type) !== 'reviewer_invocation_attestation'
        || normalizeEventType(provenance.controller_event_type) !== 'REVIEWER_INVOCATION_ATTESTED'
        || String(provenance.task_id || '').trim() !== String(input.taskId || '').trim()
        || normalizeLowerString(provenance.review_type) !== normalizeLowerString(input.reviewType)
        || normalizeLowerString(provenance.reviewer_execution_mode) !== 'delegated_subagent'
        || String(provenance.reviewer_identity || '').trim() !== reviewerIdentity
        || normalizeLowerString(provenance.review_context_sha256) !== normalizeLowerString(input.reusedFromReviewContextSha256)
        || normalizeLowerString(provenance.review_tree_state_sha256) !== normalizeLowerString(input.reusedFromReviewTreeStateSha256)
        || !isSha256(provenance.routing_event_sha256)
        || !isSha256(provenance.event_sha256)
        || !Number.isInteger(normalizeEventSequence(provenance.task_sequence))
    ) {
        return 'strict reused review evidence reviewer_provenance does not bind to the historical delegated invocation';
    }
    return null;
}

function resolveStrictCurrentReceiptSha256(
    input: StrictReusedReviewEvidenceValidationInput
): { valid: true; sha256: string } | { valid: false; reason: string } {
    const taskId = normalizeArtifactSegment(input.taskId);
    const reviewType = normalizeArtifactSegment(input.reviewType).toLowerCase();
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: input.receiptPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt.json`,
        artifactLabel: 'current reused review receipt',
        missingReason: 'current_receipt_path'
    });
    if (!pathValidation.valid) {
        return { valid: false, reason: pathValidation.message };
    }
    const actualSha256 = normalizeLowerString(fileSha256(pathValidation.resolvedPath));
    if (!isSha256(actualSha256)) {
        return { valid: false, reason: 'current reused review receipt hash is unavailable' };
    }
    const expectedSha256 = normalizeLowerString(input.receiptSha256);
    if (expectedSha256 && expectedSha256 !== actualSha256) {
        return {
            valid: false,
            reason: `current reused review receipt hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256})`
        };
    }
    return { valid: true, sha256: actualSha256 };
}

function resolveStrictCurrentReviewArtifactSha256(
    input: StrictReusedReviewEvidenceValidationInput
): { valid: true; sha256: string } | { valid: false; reason: string } {
    const taskId = normalizeArtifactSegment(input.taskId);
    const reviewType = normalizeArtifactSegment(input.reviewType).toLowerCase();
    const artifactPath = joinOrchestratorPath(input.repoRoot, path.join('runtime', 'reviews', `${taskId}-${reviewType}.md`));
    const pathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: artifactPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}.md`,
        artifactLabel: 'current reused review artifact',
        missingReason: 'current_review_artifact_path'
    });
    if (!pathValidation.valid) {
        return { valid: false, reason: pathValidation.message };
    }
    const actualSha256 = normalizeLowerString(fileSha256(pathValidation.resolvedPath));
    if (!isSha256(actualSha256)) {
        return { valid: false, reason: 'current reused review artifact hash is unavailable' };
    }
    const expectedSha256 = normalizeLowerString(input.reviewArtifactSha256);
    if (expectedSha256 && expectedSha256 !== actualSha256) {
        return {
            valid: false,
            reason: `current reused review artifact hash no longer matches telemetry (expected=${expectedSha256}, current=${actualSha256})`
        };
    }
    return { valid: true, sha256: actualSha256 };
}

function findStrictCurrentReuseRecordedEvent(input: StrictReusedReviewEvidenceValidationInput): StrictEventEvidence {
    let lastReason: string | null = null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        const match = validateReviewReuseRecordedEventMatch({
            event,
            reviewType: input.reviewType,
            receiptPath: input.receiptPath,
            receiptSha256: input.receiptSha256,
            reviewContextSha256: input.reviewContextSha256,
            reviewContextReuseSha256: input.reviewContextReuseSha256,
            reviewTreeStateSha256: input.reviewTreeStateSha256,
            reviewScopeSha256: input.reviewScopeSha256,
            codeScopeSha256: input.codeScopeSha256,
            reviewArtifactSha256: input.reviewArtifactSha256,
            reusedFromReceiptPath: input.reusedFromReceiptPath,
            reusedFromReceiptSha256: input.reusedFromReceiptSha256,
            reusedFromReviewContextSha256: input.reusedFromReviewContextSha256,
            reusedFromReviewContextReuseSha256: input.reusedFromReviewContextReuseSha256,
            reusedFromReviewTreeStateSha256: input.reusedFromReviewTreeStateSha256,
            reusedFromReviewScopeSha256: input.reusedFromReviewScopeSha256,
            reusedFromCodeScopeSha256: input.reusedFromCodeScopeSha256,
            minTaskSequenceExclusive: input.latestCompileTaskSequence,
            minEventSequenceExclusive: input.latestCompileEventSequence
        });
        if (!match.matched) {
            if (match.reason === 'before_min_task_sequence' || match.reason === 'before_min_event_sequence') {
                break;
            }
            if (match.reason && match.reason !== 'wrong_event_type') {
                lastReason = match.reason;
            }
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const snapshotBindingValidation = validateHistoricalReviewRecordedSnapshotBindings(details);
        if (!snapshotBindingValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid snapshot bindings (${snapshotBindingValidation.reason})`
            };
        }
        const receiptSnapshotValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, {
            taskId: input.taskId,
            reviewType: input.reviewType
        });
        if (!receiptSnapshotValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid receipt snapshot (${receiptSnapshotValidation.reason})`
            };
        }
        const reviewArtifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, {
            taskId: input.taskId,
            reviewType: input.reviewType
        });
        if (!reviewArtifactValidation.valid) {
            return {
                valid: false,
                reason: `current-cycle REVIEW_RECORDED reuse telemetry has invalid review artifact snapshot (${reviewArtifactValidation.reason})`
            };
        }
        return strictEventEvidenceFromMatch(match, 'current-cycle REVIEW_RECORDED reuse telemetry has invalid integrity');
    }
    return {
        valid: false,
        reason: `current-cycle REVIEW_RECORDED reuse telemetry is missing or does not match reused receipt evidence${lastReason ? ` (${lastReason})` : ''}`
    };
}

function findStrictHistoricalReviewRecordedSourceEvent(input: StrictReusedReviewEvidenceValidationInput): StrictEventEvidence {
    let lastReason: string | null = null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        if (normalizeEventType(event.event_type) !== 'REVIEW_RECORDED') {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        if (!strictHistoricalRecordedEventCanRepresentSource(details, input)) {
            continue;
        }
        const sourceIsReusedReview = details.reused_existing_review === true;
        const match = validateHistoricalReviewRecordedTelemetryEventMatch({
            event,
            repoRoot: input.repoRoot,
            taskId: input.taskId,
            reviewType: input.reviewType,
            receiptPath: input.reusedFromReceiptPath || '',
            receiptSha256: input.reusedFromReceiptSha256,
            reviewContextSha256: details.review_context_sha256 as string | null,
            reviewContextReuseSha256: details.review_context_reuse_sha256 as string | null,
            reviewTreeStateSha256: details.review_tree_state_sha256 as string | null,
            reviewScopeSha256: details.review_scope_sha256 as string | null,
            codeScopeSha256: details.code_scope_sha256 as string | null,
            reviewArtifactSha256: input.reviewArtifactSha256,
            reusedFromReceiptPath: sourceIsReusedReview ? input.reusedFromReceiptPath : undefined,
            reusedFromReceiptSha256: sourceIsReusedReview ? input.reusedFromReceiptSha256 : undefined,
            reusedFromReviewContextSha256: sourceIsReusedReview ? input.reusedFromReviewContextSha256 : undefined,
            reusedFromReviewContextReuseSha256: sourceIsReusedReview ? input.reusedFromReviewContextReuseSha256 : undefined,
            reusedFromReviewTreeStateSha256: sourceIsReusedReview ? input.reusedFromReviewTreeStateSha256 : undefined,
            reusedFromReviewScopeSha256: sourceIsReusedReview ? input.reusedFromReviewScopeSha256 : undefined,
            reusedFromCodeScopeSha256: sourceIsReusedReview ? input.reusedFromCodeScopeSha256 : undefined,
            reviewerExecutionMode: input.reviewerExecutionMode,
            reviewerIdentity: input.reviewerIdentity,
            reviewerProvenance: input.reviewerProvenance,
            maxTaskSequenceExclusive: input.latestCompileTaskSequence,
            maxEventSequenceExclusive: input.latestCompileEventSequence,
            verifyReceiptSnapshot: true
        });
        if (!match.matched) {
            if (match.reason && match.reason !== 'wrong_event_type') {
                lastReason = match.reason;
            }
            continue;
        }
        const strictDetailsError = validateStrictReviewRecordedDetails(details, input, 'historical REVIEW_RECORDED source telemetry');
        if (strictDetailsError) {
            return { valid: false, reason: strictDetailsError };
        }
        return strictEventEvidenceFromMatch(match, 'historical REVIEW_RECORDED source telemetry has invalid integrity');
    }
    return {
        valid: false,
        reason: `historical REVIEW_RECORDED telemetry source is missing or does not match reused receipt evidence${lastReason ? ` (${lastReason})` : ''}`
    };
}

function strictHistoricalRecordedEventCanRepresentSource(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput
): boolean {
    const receiptPath = normalizePath(details.receipt_path ?? details.receiptPath ?? '').toLowerCase();
    if (
        String(details.task_id ?? details.taskId ?? '').trim() !== String(input.taskId || '').trim()
        || normalizeLowerString(details.review_type ?? details.reviewType) !== normalizeLowerString(input.reviewType)
        || receiptPath !== normalizePath(input.reusedFromReceiptPath || '').toLowerCase()
        || normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256) !== normalizeLowerString(input.reusedFromReceiptSha256)
        || normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256) !== normalizeLowerString(input.reviewArtifactSha256)
    ) {
        return false;
    }
    if (details.reused_existing_review === true) {
        return normalizeLowerString(details.reused_from_receipt_path ?? details.reusedFromReceiptPath)
                === normalizeLowerString(input.reusedFromReceiptPath)
            && normalizeLowerString(details.reused_from_receipt_sha256 ?? details.reusedFromReceiptSha256)
                === normalizeLowerString(input.reusedFromReceiptSha256)
            && normalizeLowerString(details.reused_from_review_context_sha256 ?? details.reusedFromReviewContextSha256)
                === normalizeLowerString(input.reusedFromReviewContextSha256)
            && normalizeLowerString(details.reused_from_review_context_reuse_sha256 ?? details.reusedFromReviewContextReuseSha256)
                === normalizeLowerString(input.reusedFromReviewContextReuseSha256)
            && normalizeLowerString(details.reused_from_review_tree_state_sha256 ?? details.reusedFromReviewTreeStateSha256)
                === normalizeLowerString(input.reusedFromReviewTreeStateSha256)
            && normalizeLowerString(details.reused_from_review_scope_sha256 ?? details.reusedFromReviewScopeSha256)
                === normalizeLowerString(input.reusedFromReviewScopeSha256)
            && normalizeLowerString(details.reused_from_code_scope_sha256 ?? details.reusedFromCodeScopeSha256)
                === normalizeLowerString(input.reusedFromCodeScopeSha256);
    }
    return normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256)
            === normalizeLowerString(input.reusedFromReviewContextSha256)
        && normalizeLowerString(details.review_context_reuse_sha256 ?? details.reviewContextReuseSha256)
            === normalizeLowerString(input.reusedFromReviewContextReuseSha256)
        && normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256)
            === normalizeLowerString(input.reusedFromReviewTreeStateSha256)
        && normalizeLowerString(details.review_scope_sha256 ?? details.reviewScopeSha256)
            === normalizeLowerString(input.reusedFromReviewScopeSha256)
        && normalizeLowerString(details.code_scope_sha256 ?? details.codeScopeSha256)
            === normalizeLowerString(input.reusedFromCodeScopeSha256);
}

function findStrictHistoricalReviewerInvocationEvent(input: StrictReusedReviewEvidenceValidationInput): StrictEventEvidence {
    const provenance = isPlainRecord(input.reviewerProvenance) ? input.reviewerProvenance : {};
    const expectedTaskSequence = normalizeEventSequence(provenance.task_sequence);
    const expectedEventSha256 = normalizeLowerString(provenance.event_sha256);
    const expectedPrevEventSha256 = normalizeLowerString(provenance.prev_event_sha256) || null;
    for (let index = input.events.length - 1; index >= 0; index -= 1) {
        const event = input.events[index];
        if (normalizeEventType(event.event_type) !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const taskSequence = normalizeTaskSequence(event.integrity);
        const eventSha256 = normalizeLowerString(isPlainRecord(event.integrity) ? event.integrity.event_sha256 : null);
        const prevEventSha256 = normalizeLowerString(isPlainRecord(event.integrity) ? event.integrity.prev_event_sha256 : null) || null;
        if (
            input.latestCompileTaskSequence != null
            && taskSequence != null
            && taskSequence >= input.latestCompileTaskSequence
        ) {
            continue;
        }
        const eventSequence = normalizeEventSequence(event.sequence);
        if (
            input.latestCompileEventSequence != null
            && eventSequence != null
            && eventSequence >= input.latestCompileEventSequence
        ) {
            continue;
        }
        if (
            taskSequence !== expectedTaskSequence
            || eventSha256 !== expectedEventSha256
            || prevEventSha256 !== expectedPrevEventSha256
        ) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const detailsReviewerIdentity = String(
            details.reviewer_identity
                ?? details.reviewerIdentity
                ?? details.reviewer_session_id
                ?? details.reviewerSessionId
                ?? ''
        ).trim();
        if (
            String(details.task_id ?? details.taskId ?? '').trim() !== String(input.taskId || '').trim()
            || normalizeLowerString(details.review_type ?? details.reviewType) !== normalizeLowerString(input.reviewType)
            || normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== 'delegated_subagent'
            || detailsReviewerIdentity !== String(input.reviewerIdentity || '').trim()
            || normalizeLowerString(details.review_context_sha256 ?? details.reviewContextSha256)
                !== normalizeLowerString(input.reusedFromReviewContextSha256)
            || normalizeLowerString(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256)
                !== normalizeLowerString(input.reusedFromReviewTreeStateSha256)
            || normalizeLowerString(details.routing_event_sha256 ?? details.routingEventSha256)
                !== normalizeLowerString(provenance.routing_event_sha256)
        ) {
            continue;
        }
        if (taskSequence == null || !eventSha256) {
            return { valid: false, reason: 'historical REVIEWER_INVOCATION_ATTESTED telemetry has invalid integrity' };
        }
        return { valid: true, taskSequence, eventSha256 };
    }
    return {
        valid: false,
        reason: 'historical REVIEWER_INVOCATION_ATTESTED telemetry is missing or does not match preserved reviewer_provenance'
    };
}

function validateStrictReviewRecordedDetails(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const pathError = validateReviewRecordedCanonicalPaths(details, input, label);
    if (pathError) {
        return pathError;
    }
    const snapshotError = validateReviewRecordedSnapshots(details, input, label);
    if (snapshotError) {
        return snapshotError;
    }
    const reviewerError = validateReviewRecordedReviewerBinding(details, input, label);
    if (reviewerError) {
        return reviewerError;
    }
    const verdictError = validateReviewRecordedPassVerdict(details, input, label);
    if (verdictError) {
        return verdictError;
    }
    return null;
}

function validateReviewRecordedCanonicalPaths(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const taskId = String(input.taskId || '').trim();
    const reviewType = normalizeLowerString(input.reviewType);
    const receiptPathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: details.receipt_path ?? details.receiptPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}-receipt.json`,
        artifactLabel: `${label} receipt`,
        missingReason: 'receipt_path'
    });
    if (!receiptPathValidation.valid) {
        return `${label}: ${receiptPathValidation.message}`;
    }
    const reviewArtifactPathValidation = validateHistoricalReviewRecordedRuntimeReviewPath({
        repoRoot: input.repoRoot,
        rawPath: details.review_artifact_path ?? details.reviewArtifactPath,
        taskId,
        reviewType,
        expectedFileName: `${taskId}-${reviewType}.md`,
        artifactLabel: `${label} review artifact`,
        missingReason: 'review_artifact_path'
    });
    if (!reviewArtifactPathValidation.valid) {
        return `${label}: ${reviewArtifactPathValidation.message}`;
    }
    return null;
}

function validateReviewRecordedSnapshots(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const identity = { taskId: input.taskId, reviewType: input.reviewType };
    const artifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(details, input.repoRoot, identity);
    if (!artifactValidation.valid) {
        return `${label}: ${artifactValidation.message}`;
    }
    const receiptValidation = validateHistoricalReviewRecordedReceiptSnapshot(details, input.repoRoot, identity);
    if (!receiptValidation.valid) {
        return `${label}: ${receiptValidation.message}`;
    }
    return null;
}

function validateReviewRecordedReviewerBinding(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const reviewerIdentity = String(
        details.reviewer_identity
            ?? details.reviewerIdentity
            ?? details.reviewer_session_id
            ?? details.reviewerSessionId
            ?? ''
    ).trim();
    if (
        normalizeLowerString(details.reviewer_execution_mode ?? details.reviewerExecutionMode) !== 'delegated_subagent'
        || reviewerIdentity !== String(input.reviewerIdentity || '').trim()
    ) {
        return `${label}: reviewer identity or execution mode does not match reused receipt`;
    }
    const eventProvenance = isPlainRecord(details.reviewer_provenance ?? details.reviewerProvenance)
        ? details.reviewer_provenance ?? details.reviewerProvenance
        : null;
    if (!isPlainRecord(input.reviewerProvenance) || !reviewerProvenanceMatches(eventProvenance, input.reviewerProvenance)) {
        return `${label}: reviewer_provenance does not match preserved historical invocation provenance`;
    }
    return null;
}

function validateReviewRecordedPassVerdict(
    details: Record<string, unknown>,
    input: StrictReusedReviewEvidenceValidationInput,
    label: string
): string | null {
    const artifactValidation = validateHistoricalReviewRecordedReviewArtifactPath(
        details,
        input.repoRoot,
        { taskId: input.taskId, reviewType: input.reviewType }
    );
    if (!artifactValidation.valid) {
        return `${label}: ${artifactValidation.message}`;
    }
    const artifactText = fs.readFileSync(artifactValidation.resolvedPath, 'utf8');
    const verdict = extractReviewVerdictSectionTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(input.reviewType, getReviewPassVerdict(input.reviewType))
    );
    if (verdict?.outcome !== 'pass') {
        return `${label}: review artifact snapshot does not contain a PASS verdict`;
    }
    return null;
}

function strictEventEvidenceFromMatch(match: ReviewReuseTelemetryMatchResult, reason: string): StrictEventEvidence {
    if (match.taskSequence == null || !match.eventSha256) {
        return { valid: false, reason };
    }
    return {
        valid: true,
        taskSequence: match.taskSequence,
        eventSha256: match.eventSha256
    };
}

function isSha256(value: unknown): boolean {
    return /^[0-9a-f]{64}$/.test(normalizeLowerString(value));
}

function getReviewPassVerdict(reviewType: string): string {
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

function validateHistoricalReviewRecordedSnapshotBindings(
    details: Record<string, unknown>
): { valid: true; reason: null } | { valid: false; reason: string } {
    const receiptSha256 = normalizeLowerString(details.receipt_sha256 ?? details.receiptSha256);
    const receiptSnapshotSha256 = normalizeLowerString(details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256);
    if (!receiptSha256) {
        return { valid: false, reason: 'receipt_hash_missing' };
    }
    if (receiptSnapshotSha256 !== receiptSha256) {
        return { valid: false, reason: 'receipt_snapshot_hash_not_bound_to_receipt_hash' };
    }
    const reviewArtifactSha256 = normalizeLowerString(details.review_artifact_sha256 ?? details.reviewArtifactSha256);
    const reviewArtifactSnapshotSha256 = normalizeLowerString(
        details.review_artifact_snapshot_sha256
            ?? details.reviewArtifactSnapshotSha256
    );
    if (!reviewArtifactSha256) {
        return { valid: false, reason: 'review_artifact_hash_missing' };
    }
    if (reviewArtifactSnapshotSha256 !== reviewArtifactSha256) {
        return { valid: false, reason: 'review_artifact_snapshot_hash_not_bound_to_artifact_hash' };
    }
    return { valid: true, reason: null };
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
        'review_tree_state_sha256',
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
