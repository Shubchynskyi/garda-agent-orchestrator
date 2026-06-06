import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileSha256, toPosix } from '../shared/helpers';
import {
    LEGACY_REVIEW_EXECUTION_POLICY_MODE,
    resolveReviewExecutionPolicyModeFromPreflight,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import { evaluateHiddenReviewTimingTrust } from '../review/review-timing-trust';
import {
    normalizeCycleBindingPath,
    parseTimestamp,
    type TaskCycleBindingSnapshot
} from '../task-events-summary/task-events-summary';
import { safeReadJson } from './task-audit-summary-collectors';
import type { TaskAuditEvent } from './task-audit-summary-lifecycle';
import type {
    FinalCloseoutReviewTimingAuditEntry,
    FinalCloseoutReviewTimingAuditSummary
} from './task-audit-summary-types';

const REVIEW_TIMING_AUDIT_TYPES = [
    'code',
    'db',
    'security',
    'refactor',
    'test',
    'api',
    'performance',
    'infra',
    'dependency'
] as const;

function asAuditRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function readAuditString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

function readAuditTimestamp(value: unknown): string | null {
    const text = readAuditString(value);
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function readAuditSequence(value: unknown): number | null {
    const parsed = typeof value === 'number' ? value : Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function readAuditSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/u.test(text) ? text : null;
}

function elapsedMs(fromUtc: string | null, toUtc: string | null): number | null {
    if (!fromUtc || !toUtc) {
        return null;
    }
    const from = Date.parse(fromUtc);
    const to = Date.parse(toUtc);
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
        return null;
    }
    return to - from;
}

function readEventIntegrity(event: TaskAuditEvent | null): Record<string, unknown> | null {
    return asAuditRecord(event?.integrity);
}

function findReviewerInvocationEvent(
    events: readonly TaskAuditEvent[],
    provenance: Record<string, unknown> | null
): TaskAuditEvent | null {
    const expectedSequence = readAuditSequence(provenance?.task_sequence);
    const expectedEventSha256 = readAuditSha256(provenance?.event_sha256);
    const expectedPrevEventSha256 = provenance?.prev_event_sha256 == null
        ? null
        : readAuditSha256(provenance.prev_event_sha256);
    if (!expectedSequence || !expectedEventSha256) {
        return null;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = readEventIntegrity(event);
        if (
            readAuditSequence(integrity?.task_sequence) === expectedSequence
            && readAuditSha256(integrity?.event_sha256) === expectedEventSha256
            && (integrity?.prev_event_sha256 == null
                ? null
                : readAuditSha256(integrity.prev_event_sha256)) === expectedPrevEventSha256
        ) {
            return event;
        }
    }
    return null;
}

function latestCompileSequence(events: readonly TaskAuditEvent[]): number | null {
    let latest: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== 'COMPILE_GATE_PASSED') {
            continue;
        }
        const sequence = readAuditSequence(readEventIntegrity(event)?.task_sequence);
        if (sequence != null && (latest == null || sequence > latest)) {
            latest = sequence;
        }
    }
    return latest;
}

function listReviewReceiptPaths(reviewsRoot: string, taskId: string, reviewType: string): string[] {
    const canonicalPath = path.join(reviewsRoot, `${taskId}-${reviewType}-receipt.json`);
    const candidates = new Set<string>();
    if (fs.existsSync(canonicalPath) && fs.statSync(canonicalPath).isFile()) {
        candidates.add(canonicalPath);
    }
    if (fs.existsSync(reviewsRoot) && fs.statSync(reviewsRoot).isDirectory()) {
        const prefix = `${taskId}-${reviewType}-receipt-`;
        for (const entry of fs.readdirSync(reviewsRoot)) {
            if (entry.startsWith(prefix) && entry.endsWith('.json')) {
                candidates.add(path.join(reviewsRoot, entry));
            }
        }
    }
    return [...candidates].sort((left, right) => {
        const leftReceipt = safeReadJson(left);
        const rightReceipt = safeReadJson(right);
        const leftTime = Date.parse(readAuditTimestamp(leftReceipt?.review_result_recorded_at_utc ?? leftReceipt?.recorded_at_utc) || '');
        const rightTime = Date.parse(readAuditTimestamp(rightReceipt?.review_result_recorded_at_utc ?? rightReceipt?.recorded_at_utc) || '');
        const leftOrder = Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER;
        const rightOrder = Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER;
        return leftOrder - rightOrder || left.localeCompare(right);
    });
}

function buildReviewTimingAuditEntry(
    taskId: string,
    reviewType: string,
    receiptPath: string,
    events: readonly TaskAuditEvent[],
    compileSequence: number | null
): FinalCloseoutReviewTimingAuditEntry | null {
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return null;
    }
    const receipt = safeReadJson(receiptPath);
    if (!receipt || receipt.task_id !== taskId || receipt.review_type !== reviewType) {
        return null;
    }
    const provenance = asAuditRecord(receipt.reviewer_provenance);
    const invocationEvent = findReviewerInvocationEvent(events, provenance);
    const invocationDetails = asAuditRecord(invocationEvent?.details);
    const launchPreparedAtUtc = readAuditTimestamp(
        provenance?.launch_prepared_at_utc ?? invocationDetails?.launch_prepared_at_utc
    );
    const delegationStartedAtUtc = readAuditTimestamp(
        provenance?.delegation_started_at_utc ?? invocationDetails?.delegation_started_at_utc
    );
    const launchedAtUtc = readAuditTimestamp(
        provenance?.launched_at_utc ?? invocationDetails?.launched_at_utc
    );
    const launchCompletedAtUtc = readAuditTimestamp(
        provenance?.launch_completed_at_utc ?? invocationDetails?.launch_completed_at_utc
    );
    const invocationAttestedAtUtc = readAuditTimestamp(
        provenance?.invocation_attested_at_utc ?? invocationDetails?.invocation_attested_at_utc
    );
    const reviewResultRecordedAtUtc = readAuditTimestamp(
        receipt.review_result_recorded_at_utc ?? receipt.recorded_at_utc
    );
    const reviewOutputSourceMtimeUtc = readAuditTimestamp(receipt.review_output_source_mtime_utc);
    const reusedExistingReview = receipt.reused_existing_review === true;
    const timingTrust = evaluateHiddenReviewTimingTrust({
        reviewType,
        reusedExistingReview,
        reviewerProvenance: provenance,
        reviewResultRecordedAtUtc,
        recordedAtUtc: readAuditTimestamp(receipt.recorded_at_utc),
        reviewOutputSourceMtimeUtc,
        timelineEvents: events,
        latestCompileSequence: compileSequence
    });
    return {
        review_type: reviewType,
        reviewer_identity: readAuditString(receipt.reviewer_identity),
        reviewer_execution_mode: readAuditString(receipt.reviewer_execution_mode),
        reused_existing_review: reusedExistingReview,
        receipt_path: toPosix(receiptPath),
        receipt_sha256: fileSha256(receiptPath),
        review_output_path: readAuditString(receipt.review_output_path),
        review_output_sha256: readAuditSha256(receipt.review_output_sha256),
        provider: readAuditString(
            invocationDetails?.execution_provider
            ?? invocationDetails?.provider
            ?? invocationDetails?.provider_family
            ?? invocationDetails?.reviewer_launch_tool
        ),
        provider_invocation_id: readAuditString(invocationDetails?.provider_invocation_id),
        reviewer_launch_attestation_source: readAuditString(invocationDetails?.reviewer_launch_attestation_source),
        launch_prepared_at_utc: launchPreparedAtUtc,
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: launchedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        invocation_attested_at_utc: invocationAttestedAtUtc,
        review_result_recorded_at_utc: reviewResultRecordedAtUtc,
        review_output_source_mtime_utc: reviewOutputSourceMtimeUtc,
        delegation_to_result_ms: elapsedMs(delegationStartedAtUtc, reviewResultRecordedAtUtc),
        delegation_to_source_mtime_ms: elapsedMs(delegationStartedAtUtc, reviewOutputSourceMtimeUtc),
        gate_finalize_ms: elapsedMs(launchCompletedAtUtc, reviewResultRecordedAtUtc),
        launch_to_result_ms: elapsedMs(launchedAtUtc, reviewResultRecordedAtUtc),
        launch_to_source_mtime_ms: elapsedMs(launchedAtUtc, reviewOutputSourceMtimeUtc),
        hidden_timing_status: reusedExistingReview
            ? 'SKIPPED_REUSED'
            : timingTrust.trusted
                ? 'TRUSTED'
                : 'DISTRUSTED',
        hidden_timing_distrust_code: timingTrust.code
    };
}

export function buildReviewTimingAuditSummary(
    reviewsRoot: string,
    taskId: string,
    events: readonly TaskAuditEvent[]
): FinalCloseoutReviewTimingAuditSummary | null {
    const compileSequence = latestCompileSequence(events);
    const entries: FinalCloseoutReviewTimingAuditEntry[] = [];
    const seenReceiptHashes = new Set<string>();

    for (const reviewType of REVIEW_TIMING_AUDIT_TYPES) {
        for (const receiptPath of listReviewReceiptPaths(reviewsRoot, taskId, reviewType)) {
            const entry = buildReviewTimingAuditEntry(taskId, reviewType, receiptPath, events, compileSequence);
            if (entry) {
                const receiptIdentity = entry.receipt_sha256
                    ? `${entry.review_type}:${entry.receipt_sha256}`
                    : `${entry.review_type}:${entry.receipt_path}`;
                if (seenReceiptHashes.has(receiptIdentity)) {
                    continue;
                }
                seenReceiptHashes.add(receiptIdentity);
                entries.push(entry);
            }
        }
    }

    if (entries.length === 0) {
        return null;
    }
    const compactEntries = entries.map((entry) => {
        const resultMs = entry.delegation_to_result_ms == null ? 'unknown' : `${entry.delegation_to_result_ms}ms`;
        const sourceMs = entry.delegation_to_source_mtime_ms == null ? 'unknown' : `${entry.delegation_to_source_mtime_ms}ms`;
        const finalizeMs = entry.gate_finalize_ms == null ? 'unknown' : `${entry.gate_finalize_ms}ms`;
        const flag = entry.hidden_timing_distrust_code
            ? `${entry.hidden_timing_status}:${entry.hidden_timing_distrust_code}`
            : entry.hidden_timing_status;
        return `${entry.review_type}(${flag}, delegation_to_result=${resultMs}, delegation_to_source_mtime=${sourceMs}, gate_finalize=${finalizeMs})`;
    });
    return {
        entries,
        visible_summary_line: `Review timing audit: ${compactEntries.join('; ')}.`
    };
}

export function readReviewExecutionPolicyModeFromCurrentCycleTimeline(
    events: TaskAuditEvent[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): EffectiveReviewExecutionPolicyMode | null {
    const expectedPreflightPath = currentCycle?.preflight_path
        ? toPosix(currentCycle.preflight_path)
        : null;
    const compileGateTime = currentCycle?.compile_gate_timestamp
        ? parseTimestamp(currentCycle.compile_gate_timestamp).getTime()
        : 0;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== 'PREFLIGHT_CLASSIFIED') {
            continue;
        }

        const eventTime = parseTimestamp(event.timestamp_utc).getTime();
        if (compileGateTime > 0 && eventTime > 0 && eventTime > compileGateTime) {
            continue;
        }

        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        if (!details) {
            continue;
        }

        const eventPreflightPath = normalizeCycleBindingPath(details.output_path, repoRoot);
        if (expectedPreflightPath && eventPreflightPath && eventPreflightPath !== expectedPreflightPath) {
            continue;
        }

        const rawPolicy = details.review_execution_policy;
        if (rawPolicy && typeof rawPolicy === 'object' && !Array.isArray(rawPolicy)) {
            return resolveReviewExecutionPolicyModeFromPreflight(
                { review_execution_policy: rawPolicy },
                LEGACY_REVIEW_EXECUTION_POLICY_MODE
            );
        }
        return LEGACY_REVIEW_EXECUTION_POLICY_MODE;
    }

    return null;
}
