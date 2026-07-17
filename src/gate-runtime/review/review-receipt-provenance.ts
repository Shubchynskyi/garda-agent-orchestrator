import type { DomainScopeFingerprints } from '../../gates/scope/domain-scope-fingerprints';
import type { TaskEventIntegrity } from '../task-events';

export interface ReviewReceipt {
    schema_version: number;
    task_id: string;
    review_type: string;
    preflight_sha256: string | null;
    scope_sha256: string | null;
    review_scope_sha256?: string | null;
    code_scope_sha256?: string | null;
    domain_scope_fingerprints?: DomainScopeFingerprints | null;
    review_context_sha256: string | null;
    review_tree_state_sha256?: string | null;
    review_context_reuse_sha256?: string | null;
    review_artifact_sha256: string | null;
    reviewer_execution_mode: string | null;
    reviewer_identity: string | null;
    reviewer_fallback_reason: string | null;
    reviewer_provenance?: ReviewReceiptReviewerProvenance | null;
    trust_level?: string;
    reused_existing_review?: boolean;
    reused_from_receipt_path?: string | null;
    reused_from_receipt_sha256?: string | null;
    reused_from_review_context_sha256?: string | null;
    reused_from_review_context_reuse_sha256?: string | null;
    reused_from_review_tree_state_sha256?: string | null;
    reused_from_review_scope_sha256?: string | null;
    reused_from_code_scope_sha256?: string | null;
    reused_from_domain_scope_fingerprints?: DomainScopeFingerprints | null;
    recorded_at_utc: string;
    review_result_recorded_at_utc?: string | null;
    review_output_source_mtime_utc?: string | null;
}

export type ReviewReceiptReviewerProvenance =
    | ControllerEventIntegrityReviewReceiptReviewerProvenance
    | ReviewerInvocationAttestationReviewReceiptReviewerProvenance;

export interface ControllerEventIntegrityReviewReceiptReviewerProvenance {
    schema_version: number;
    attestation_type: 'controller_event_integrity';
    controller_event_type: 'REVIEWER_DELEGATION_ROUTED';
    task_sequence: number;
    prev_event_sha256: string | null;
    event_sha256: string;
}

export interface ReviewerInvocationAttestationReviewReceiptReviewerProvenance {
    schema_version: number;
    attestation_type: 'reviewer_invocation_attestation';
    controller_event_type: 'REVIEWER_INVOCATION_ATTESTED';
    task_sequence: number;
    prev_event_sha256: string | null;
    event_sha256: string;
    task_id: string;
    review_type: string;
    reviewer_execution_mode: 'delegated_subagent';
    reviewer_identity: string;
    review_context_sha256: string;
    review_tree_state_sha256?: string | null;
    routing_event_sha256: string;
    launch_prepared_at_utc?: string | null;
    delegation_started_at_utc?: string | null;
    launched_at_utc?: string | null;
    launch_completed_at_utc?: string | null;
    invocation_attested_at_utc?: string | null;
}

export const REVIEWER_EXECUTION_MODES = Object.freeze([
    'delegated_subagent'
] as const);

export const COMPATIBILITY_REVIEWER_EXECUTION_MODES = Object.freeze([
    'delegated_subagent',
    'same_agent_fallback'
] as const);

export type ReviewerExecutionMode = (typeof REVIEWER_EXECUTION_MODES)[number];
export type CompatibilityReviewerExecutionMode = (typeof COMPATIBILITY_REVIEWER_EXECUTION_MODES)[number];

export function normalizeReviewerExecutionMode(value: unknown): ReviewerExecutionMode | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    return REVIEWER_EXECUTION_MODES.includes(text as ReviewerExecutionMode)
        ? text as ReviewerExecutionMode
        : null;
}

export function normalizeCompatibilityReviewerExecutionMode(value: unknown): CompatibilityReviewerExecutionMode | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    return COMPATIBILITY_REVIEWER_EXECUTION_MODES.includes(text as CompatibilityReviewerExecutionMode)
        ? text as CompatibilityReviewerExecutionMode
        : null;
}

function normalizeProvenanceSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

function normalizeProvenanceText(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

const UTC_ISO_8601_TIMESTAMP_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?Z$/;

export function normalizeReviewProvenanceUtcTimestamp(value: unknown): string | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const match = UTC_ISO_8601_TIMESTAMP_PATTERN.exec(text);
    if (!match) {
        return null;
    }
    const timestampMs = Date.parse(text);
    if (!Number.isFinite(timestampMs)) {
        return null;
    }
    const parsed = new Date(timestampMs);
    const [, year, month, day, hour, minute, second] = match.map(Number);
    return parsed.getUTCFullYear() === year
        && parsed.getUTCMonth() + 1 === month
        && parsed.getUTCDate() === day
        && parsed.getUTCHours() === hour
        && parsed.getUTCMinutes() === minute
        && parsed.getUTCSeconds() === second
        ? text
        : null;
}

export function normalizeReviewReceiptReviewerProvenance(value: unknown): ReviewReceiptReviewerProvenance | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Record<string, unknown>;
    const schemaVersion = typeof record.schema_version === 'number'
        ? record.schema_version
        : Number(record.schema_version);
    const attestationType = String(record.attestation_type || '').trim();
    const controllerEventType = String(record.controller_event_type || '').trim().toUpperCase();
    const taskSequence = typeof record.task_sequence === 'number'
        ? record.task_sequence
        : Number(record.task_sequence);
    const eventSha256 = normalizeProvenanceSha256(record.event_sha256);
    const prevEventSha256 = record.prev_event_sha256 == null
        ? null
        : normalizeProvenanceSha256(record.prev_event_sha256);
    if (attestationType === 'reviewer_invocation_attestation') {
        const taskId = normalizeProvenanceText(record.task_id);
        const reviewType = normalizeProvenanceText(record.review_type)?.toLowerCase() || null;
        const reviewerExecutionMode = normalizeProvenanceText(record.reviewer_execution_mode);
        const reviewerIdentity = normalizeProvenanceText(record.reviewer_identity);
        const reviewContextSha256 = normalizeProvenanceSha256(record.review_context_sha256);
        const rawReviewTreeStateSha256 = record.review_tree_state_sha256 ?? record.reviewTreeStateSha256;
        const reviewTreeStateSha256 = rawReviewTreeStateSha256 == null
            ? null
            : normalizeProvenanceSha256(rawReviewTreeStateSha256);
        const routingEventSha256 = normalizeProvenanceSha256(record.routing_event_sha256);
        const rawLaunchPreparedAtUtc = record.launch_prepared_at_utc ?? record.launchPreparedAtUtc;
        const rawDelegationStartedAtUtc = record.delegation_started_at_utc ?? record.delegationStartedAtUtc;
        const rawLaunchedAtUtc = record.launched_at_utc ?? record.launchedAtUtc;
        const rawLaunchCompletedAtUtc = record.launch_completed_at_utc ?? record.launchCompletedAtUtc;
        const rawInvocationAttestedAtUtc = record.invocation_attested_at_utc ?? record.invocationAttestedAtUtc;
        const launchPreparedAtUtc = normalizeReviewProvenanceUtcTimestamp(rawLaunchPreparedAtUtc);
        const delegationStartedAtUtc = normalizeReviewProvenanceUtcTimestamp(rawDelegationStartedAtUtc);
        const launchedAtUtc = normalizeReviewProvenanceUtcTimestamp(rawLaunchedAtUtc);
        const launchCompletedAtUtc = normalizeReviewProvenanceUtcTimestamp(rawLaunchCompletedAtUtc);
        const invocationAttestedAtUtc = normalizeReviewProvenanceUtcTimestamp(rawInvocationAttestedAtUtc);
        if (
            schemaVersion !== 1
            || controllerEventType !== 'REVIEWER_INVOCATION_ATTESTED'
            || !Number.isInteger(taskSequence)
            || taskSequence <= 0
            || !eventSha256
            || (record.prev_event_sha256 != null && prevEventSha256 == null)
            || !taskId
            || !reviewType
            || reviewerExecutionMode !== 'delegated_subagent'
            || !reviewerIdentity
            || !reviewContextSha256
            || (rawReviewTreeStateSha256 != null && !reviewTreeStateSha256)
            || !routingEventSha256
            || (rawLaunchPreparedAtUtc != null && String(rawLaunchPreparedAtUtc).trim() !== '' && !launchPreparedAtUtc)
            || (rawDelegationStartedAtUtc != null && String(rawDelegationStartedAtUtc).trim() !== '' && !delegationStartedAtUtc)
            || (rawLaunchedAtUtc != null && String(rawLaunchedAtUtc).trim() !== '' && !launchedAtUtc)
            || (rawLaunchCompletedAtUtc != null && String(rawLaunchCompletedAtUtc).trim() !== '' && !launchCompletedAtUtc)
            || (rawInvocationAttestedAtUtc != null && String(rawInvocationAttestedAtUtc).trim() !== '' && !invocationAttestedAtUtc)
        ) {
            return null;
        }
        return {
            schema_version: 1,
            attestation_type: 'reviewer_invocation_attestation',
            controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
            task_sequence: taskSequence,
            prev_event_sha256: prevEventSha256,
            event_sha256: eventSha256,
            task_id: taskId,
            review_type: reviewType,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_identity: reviewerIdentity,
            review_context_sha256: reviewContextSha256,
            review_tree_state_sha256: reviewTreeStateSha256,
            routing_event_sha256: routingEventSha256,
            launch_prepared_at_utc: launchPreparedAtUtc,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: launchedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc,
            invocation_attested_at_utc: invocationAttestedAtUtc
        };
    }
    if (
        schemaVersion !== 1
        || attestationType !== 'controller_event_integrity'
        || controllerEventType !== 'REVIEWER_DELEGATION_ROUTED'
        || !Number.isInteger(taskSequence)
        || taskSequence <= 0
        || !eventSha256
        || (record.prev_event_sha256 != null && prevEventSha256 == null)
    ) {
        return null;
    }
    return {
        schema_version: 1,
        attestation_type: 'controller_event_integrity',
        controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
        task_sequence: taskSequence,
        prev_event_sha256: prevEventSha256,
        event_sha256: eventSha256
    };
}

export function buildReviewReceiptReviewerProvenance(
    eventType: string,
    integrity: TaskEventIntegrity | null | undefined
): ReviewReceiptReviewerProvenance | null {
    if (String(eventType || '').trim().toUpperCase() !== 'REVIEWER_DELEGATION_ROUTED' || !integrity) {
        return null;
    }
    return normalizeReviewReceiptReviewerProvenance({
        schema_version: 1,
        attestation_type: 'controller_event_integrity',
        controller_event_type: 'REVIEWER_DELEGATION_ROUTED',
        task_sequence: integrity.task_sequence,
        prev_event_sha256: integrity.prev_event_sha256 ?? null,
        event_sha256: integrity.event_sha256 ?? null
    });
}

export function buildReviewReceiptReviewerInvocationProvenance(
    eventType: string,
    integrity: TaskEventIntegrity | null | undefined,
    details: unknown
): ReviewReceiptReviewerProvenance | null {
    if (String(eventType || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED' || !integrity) {
        return null;
    }
    const record = details && typeof details === 'object' && !Array.isArray(details)
        ? details as Record<string, unknown>
        : {};
    return normalizeReviewReceiptReviewerProvenance({
        schema_version: 1,
        attestation_type: 'reviewer_invocation_attestation',
        controller_event_type: 'REVIEWER_INVOCATION_ATTESTED',
        task_sequence: integrity.task_sequence,
        prev_event_sha256: integrity.prev_event_sha256 ?? null,
        event_sha256: integrity.event_sha256 ?? null,
        task_id: record.task_id,
        review_type: record.review_type ?? record.reviewType,
        reviewer_execution_mode: record.reviewer_execution_mode ?? record.reviewerExecutionMode,
        reviewer_identity: record.reviewer_identity ?? record.reviewerIdentity ?? record.reviewer_session_id ?? record.reviewerSessionId,
        review_context_sha256: record.review_context_sha256 ?? record.reviewContextSha256,
        review_tree_state_sha256: record.review_tree_state_sha256 ?? record.reviewTreeStateSha256,
        routing_event_sha256: record.routing_event_sha256 ?? record.routingEventSha256,
        launch_prepared_at_utc: record.launch_prepared_at_utc ?? record.launchPreparedAtUtc,
        delegation_started_at_utc: record.delegation_started_at_utc ?? record.delegationStartedAtUtc,
        launched_at_utc: record.launched_at_utc ?? record.launchedAtUtc,
        launch_completed_at_utc: record.launch_completed_at_utc ?? record.launchCompletedAtUtc,
        invocation_attested_at_utc: record.invocation_attested_at_utc ?? record.invocationAttestedAtUtc
    });
}

/**
 * Build a review receipt artifact.
 */
export function buildReviewReceipt(options: {
    taskId: string;
    reviewType: string;
    preflightSha256: string | null;
    scopeSha256: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    domainScopeFingerprints?: DomainScopeFingerprints | null;
    reviewContextSha256: string | null;
    reviewTreeStateSha256?: string | null;
    reviewContextReuseSha256?: string | null;
    reviewArtifactSha256: string | null;
    reviewerExecutionMode?: string | null;
    reviewerIdentity?: string | null;
    reviewerFallbackReason?: string | null;
    reviewerProvenance?: ReviewReceiptReviewerProvenance | null;
    trustLevel?: string;
    reusedExistingReview?: boolean;
    reusedFromReceiptPath?: string | null;
    reusedFromReceiptSha256?: string | null;
    reusedFromReviewContextSha256?: string | null;
    reusedFromReviewContextReuseSha256?: string | null;
    reusedFromReviewTreeStateSha256?: string | null;
    reusedFromReviewScopeSha256?: string | null;
    reusedFromCodeScopeSha256?: string | null;
    reusedFromDomainScopeFingerprints?: DomainScopeFingerprints | null;
}): ReviewReceipt {
    return {
        schema_version: 2,
        task_id: options.taskId,
        review_type: options.reviewType,
        preflight_sha256: options.preflightSha256,
        scope_sha256: options.scopeSha256,
        review_scope_sha256: options.reviewScopeSha256 ?? null,
        code_scope_sha256: options.codeScopeSha256 ?? null,
        domain_scope_fingerprints: options.domainScopeFingerprints ?? null,
        review_context_sha256: options.reviewContextSha256,
        review_tree_state_sha256: options.reviewTreeStateSha256 ?? null,
        review_context_reuse_sha256: options.reviewContextReuseSha256 ?? null,
        review_artifact_sha256: options.reviewArtifactSha256,
        reviewer_execution_mode: options.reviewerExecutionMode ?? null,
        reviewer_identity: options.reviewerIdentity ?? null,
        reviewer_fallback_reason: options.reviewerFallbackReason ?? null,
        reviewer_provenance: options.reviewerProvenance ?? null,
        trust_level: options.trustLevel || 'LOCAL_ASSERTED',
        reused_existing_review: options.reusedExistingReview === true,
        reused_from_receipt_path: options.reusedFromReceiptPath ?? null,
        reused_from_receipt_sha256: options.reusedFromReceiptSha256 ?? null,
        reused_from_review_context_sha256: options.reusedFromReviewContextSha256 ?? null,
        reused_from_review_context_reuse_sha256: options.reusedFromReviewContextReuseSha256 ?? null,
        reused_from_review_tree_state_sha256: options.reusedFromReviewTreeStateSha256 ?? null,
        reused_from_review_scope_sha256: options.reusedFromReviewScopeSha256 ?? null,
        reused_from_code_scope_sha256: options.reusedFromCodeScopeSha256 ?? null,
        reused_from_domain_scope_fingerprints: options.reusedFromDomainScopeFingerprints ?? null,
        recorded_at_utc: new Date().toISOString()
    };
}
