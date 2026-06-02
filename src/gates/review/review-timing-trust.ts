import { REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION } from '../../gate-runtime/reviewer-session-contract';
import { normalizeReviewProvenanceUtcTimestamp } from '../../gate-runtime/review-context';

export const HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE =
    `Review evidence is not sufficiently trustworthy. ${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION}`;

const TIMING_ENFORCED_REVIEW_TYPES = new Set([
    'code',
    'db',
    'security',
    'refactor',
    'api',
    'test',
    'performance',
    'infra',
    'dependency'
]);
const SHORT_REVIEW_WITHOUT_STRONG_PROVIDER_EVIDENCE_MS = 10_000;
const MIN_DELEGATED_WORK_WINDOW_MS = 10_000;
const FUTURE_TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

export type HiddenReviewTimingDistrustCode =
    | 'missing_timing'
    | 'future_timestamp'
    | 'impossible_ordering'
    | 'duplicate_provider_invocation_id'
    | 'too_short_delegated_work_window'
    | 'too_short_without_strong_provider_evidence';

export interface ReviewTimingTrustEventLike {
    event_type?: unknown;
    details?: unknown;
    integrity?: {
        task_sequence?: number | string | null;
        prev_event_sha256?: string | null;
        event_sha256?: string | null;
    } | Record<string, unknown> | unknown;
}

export interface ReviewTimingTrustProvenance {
    controller_event_type?: string | null;
    task_sequence?: number | null;
    prev_event_sha256?: string | null;
    event_sha256?: string | null;
    launch_prepared_at_utc?: string | null;
    delegation_started_at_utc?: string | null;
    launched_at_utc?: string | null;
    launch_completed_at_utc?: string | null;
    invocation_attested_at_utc?: string | null;
}

export interface HiddenReviewTimingTrustResult {
    trusted: boolean;
    code: HiddenReviewTimingDistrustCode | null;
    message: string | null;
}

function normalizedEventType(value: unknown): string {
    return String(value || '').trim().toUpperCase();
}

function normalizedSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function normalizedSequence(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function getTimestampMs(value: unknown): number | null {
    const normalized = normalizeReviewProvenanceUtcTimestamp(value);
    if (!normalized) {
        return null;
    }
    const parsed = Date.parse(normalized);
    return Number.isFinite(parsed) ? parsed : null;
}

function getDetailsTimestampMs(
    details: Record<string, unknown> | null | undefined,
    snakeKey: string,
    camelKey: string
): number | null {
    return getTimestampMs(details?.[snakeKey] ?? details?.[camelKey]);
}

function getStringField(details: Record<string, unknown> | null | undefined, ...keys: string[]): string {
    for (const key of keys) {
        const text = String(details?.[key] || '').trim();
        if (text) {
            return text;
        }
    }
    return '';
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function findMatchingInvocationEvent(
    events: readonly ReviewTimingTrustEventLike[],
    provenance: ReviewTimingTrustProvenance
): ReviewTimingTrustEventLike | null {
    const expectedSequence = normalizedSequence(provenance.task_sequence);
    const expectedEventSha256 = normalizedSha256(provenance.event_sha256);
    const expectedPrevEventSha256 = provenance.prev_event_sha256 == null
        ? null
        : normalizedSha256(provenance.prev_event_sha256);
    if (!expectedSequence || !expectedEventSha256) {
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (normalizedEventType(event.event_type) !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = asRecord(event.integrity);
        const sequence = normalizedSequence(integrity?.task_sequence);
        const eventSha256 = normalizedSha256(integrity?.event_sha256);
        const prevEventSha256 = integrity?.prev_event_sha256 == null
            ? null
            : normalizedSha256(integrity.prev_event_sha256);
        if (
            sequence === expectedSequence
            && eventSha256 === expectedEventSha256
            && prevEventSha256 === expectedPrevEventSha256
        ) {
            return event;
        }
    }
    return null;
}

function hasDuplicateProviderInvocationId(options: {
    events: readonly ReviewTimingTrustEventLike[];
    invocationEvent: ReviewTimingTrustEventLike;
    reviewType: string;
    providerInvocationId: string;
    latestCompileSequence: number | null;
}): boolean {
    const providerInvocationId = options.providerInvocationId.trim();
    if (!providerInvocationId) {
        return false;
    }
    for (const event of options.events) {
        if (event === options.invocationEvent || normalizedEventType(event.event_type) !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = asRecord(event.integrity);
        const sequence = normalizedSequence(integrity?.task_sequence);
        if (
            options.latestCompileSequence != null
            && sequence != null
            && sequence <= options.latestCompileSequence
        ) {
            continue;
        }
        const details = asRecord(event.details);
        const otherReviewType = getStringField(details, 'review_type', 'reviewType').toLowerCase();
        if (!otherReviewType || otherReviewType === options.reviewType) {
            continue;
        }
        const otherProviderInvocationId = getStringField(
            details,
            'provider_invocation_id',
            'providerInvocationId'
        );
        if (otherProviderInvocationId && otherProviderInvocationId === providerInvocationId) {
            return true;
        }
    }
    return false;
}

function normalizeEvidenceToken(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function hasStrongProviderInvocationEvidence(details: Record<string, unknown> | null | undefined): boolean {
    const providerInvocationId = getStringField(details, 'provider_invocation_id', 'providerInvocationId');
    if (!providerInvocationId) {
        return false;
    }
    if (/^(?:unknown|n\/a|na|null|none|manual|mock|test|placeholder|<.*>)$/i.test(providerInvocationId)) {
        return false;
    }
    const normalizedProviderInvocationId = normalizeEvidenceToken(providerInvocationId);
    if (/^agent:/i.test(providerInvocationId)) {
        return false;
    }
    const reviewerIdentity = getStringField(
        details,
        'reviewer_identity',
        'reviewerIdentity',
        'reviewer_session_id',
        'reviewerSessionId'
    );
    if (reviewerIdentity && normalizedProviderInvocationId === normalizeEvidenceToken(reviewerIdentity)) {
        return false;
    }
    const attestationSource = getStringField(
        details,
        'reviewer_launch_attestation_source',
        'reviewerLaunchAttestationSource',
        'attestation_source',
        'attestationSource'
    ).toLowerCase();
    if (!attestationSource || [
        'controller',
        'local_controller',
        'manual',
        'mock',
        'orchestrator_mock',
        'garda_prepare_reviewer_launch',
        'provider_subagent'
    ].includes(attestationSource)) {
        return false;
    }
    if (['gemini', 'gemini_cli'].includes(attestationSource)) {
        return /(?:invocation|run|task|spawn|subagent|reviewer)/i.test(providerInvocationId);
    }
    return /(?:spawn|subagent|task|tool|launch|run|invocation)/i.test(attestationSource);
}

function distrust(code: HiddenReviewTimingDistrustCode): HiddenReviewTimingTrustResult {
    return {
        trusted: false,
        code,
        message: HIDDEN_REVIEW_TIMING_DISTRUST_MESSAGE
    };
}

export function evaluateHiddenReviewTimingTrust(options: {
    reviewType: string;
    reusedExistingReview: boolean;
    reviewerProvenance: ReviewTimingTrustProvenance | null | undefined;
    reviewResultRecordedAtUtc?: string | null;
    recordedAtUtc?: string | null;
    reviewOutputSourceMtimeUtc?: string | null;
    timelineEvents: readonly ReviewTimingTrustEventLike[];
    latestCompileSequence?: number | null;
    nowMs?: number;
}): HiddenReviewTimingTrustResult {
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (options.reusedExistingReview || !TIMING_ENFORCED_REVIEW_TYPES.has(reviewType)) {
        return { trusted: true, code: null, message: null };
    }
    const provenance = options.reviewerProvenance;
    if (
        !provenance
        || normalizedEventType(provenance.controller_event_type) !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return { trusted: true, code: null, message: null };
    }

    const invocationEvent = findMatchingInvocationEvent(options.timelineEvents, provenance);
    if (!invocationEvent) {
        return { trusted: true, code: null, message: null };
    }
    const details = asRecord(invocationEvent.details);
    const launchPreparedAtMs = getTimestampMs(provenance.launch_prepared_at_utc)
        ?? getDetailsTimestampMs(details, 'launch_prepared_at_utc', 'launchPreparedAtUtc');
    const launchedAtMs = getTimestampMs(provenance.launched_at_utc)
        ?? getDetailsTimestampMs(details, 'launched_at_utc', 'launchedAtUtc');
    const explicitDelegationStartedAtMs = getTimestampMs(provenance.delegation_started_at_utc)
        ?? getDetailsTimestampMs(details, 'delegation_started_at_utc', 'delegationStartedAtUtc');
    const delegationStartedAtMs = explicitDelegationStartedAtMs ?? launchedAtMs;
    const launchCompletedAtMs = getTimestampMs(provenance.launch_completed_at_utc)
        ?? getDetailsTimestampMs(details, 'launch_completed_at_utc', 'launchCompletedAtUtc');
    const invocationAttestedAtMs = getTimestampMs(provenance.invocation_attested_at_utc)
        ?? getDetailsTimestampMs(details, 'invocation_attested_at_utc', 'invocationAttestedAtUtc');
    const reviewResultRecordedAtMs = getTimestampMs(options.reviewResultRecordedAtUtc)
        ?? getTimestampMs(options.recordedAtUtc);
    const reviewOutputSourceMtimeMs = getTimestampMs(options.reviewOutputSourceMtimeUtc);
    const timestamps = [
        launchPreparedAtMs,
        delegationStartedAtMs,
        launchCompletedAtMs,
        invocationAttestedAtMs,
        reviewResultRecordedAtMs
    ];
    if (timestamps.some((timestamp) => timestamp == null)) {
        return distrust('missing_timing');
    }

    const nowMs = options.nowMs ?? Date.now();
    if (timestamps.some((timestamp) => Number(timestamp) > nowMs + FUTURE_TIMESTAMP_TOLERANCE_MS)) {
        return distrust('future_timestamp');
    }
    if (
        Number(launchPreparedAtMs) > Number(delegationStartedAtMs)
        || Number(delegationStartedAtMs) > Number(launchCompletedAtMs)
        || Number(launchCompletedAtMs) > Number(invocationAttestedAtMs)
        || Number(invocationAttestedAtMs) > Number(reviewResultRecordedAtMs)
    ) {
        return distrust('impossible_ordering');
    }
    if (
        explicitDelegationStartedAtMs != null
        && launchedAtMs != null
        && (
            Number(launchedAtMs) < Number(delegationStartedAtMs)
            || Number(launchedAtMs) > Number(launchCompletedAtMs)
        )
    ) {
        return distrust('impossible_ordering');
    }
    if (reviewOutputSourceMtimeMs != null && reviewOutputSourceMtimeMs < Number(delegationStartedAtMs)) {
        return distrust('impossible_ordering');
    }

    const providerInvocationId = getStringField(details, 'provider_invocation_id', 'providerInvocationId');
    if (hasDuplicateProviderInvocationId({
        events: options.timelineEvents,
        invocationEvent,
        reviewType,
        providerInvocationId,
        latestCompileSequence: options.latestCompileSequence ?? null
    })) {
        return distrust('duplicate_provider_invocation_id');
    }

    const delegationToResultMs = Number(reviewResultRecordedAtMs) - Number(delegationStartedAtMs);
    const delegationToLaunchCompletionMs = Number(launchCompletedAtMs) - Number(delegationStartedAtMs);
    const strongProviderInvocationEvidence = hasStrongProviderInvocationEvidence(details);
    if (
        !strongProviderInvocationEvidence
        && delegationToResultMs >= 0
        && delegationToResultMs < SHORT_REVIEW_WITHOUT_STRONG_PROVIDER_EVIDENCE_MS
    ) {
        return distrust('too_short_without_strong_provider_evidence');
    }
    if (
        delegationToLaunchCompletionMs >= 0
        && delegationToLaunchCompletionMs < MIN_DELEGATED_WORK_WINDOW_MS
    ) {
        return distrust('too_short_delegated_work_window');
    }

    return { trusted: true, code: null, message: null };
}
