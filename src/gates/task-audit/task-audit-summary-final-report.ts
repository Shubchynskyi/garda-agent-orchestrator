import type { FinalCloseoutArtifact } from './task-audit-summary';
import {
    getReviewIntegrityAttestation,
    type ReviewIntegrityAttestation,
    type ReviewTimingAuditEntry
} from './task-audit-summary-renderer-common';
import {
    formatKnownNonBlockingSignalSummaries
} from '../shared/known-nonblocking-signals';

function formatDurationMsAsMinutesSeconds(durationMs: number | null | undefined): string {
    if (durationMs == null || !Number.isFinite(durationMs) || durationMs < 0) {
        return 'unknown';
    }
    const totalSeconds = Math.floor(durationMs / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m ${String(seconds).padStart(2, '0')}s`;
}

function parseReviewTimingAuditTimestamp(value: string | null | undefined): number | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function getReviewTimingAuditSortTimestamp(entry: ReviewTimingAuditEntry): number {
    return parseReviewTimingAuditTimestamp(entry.review_result_recorded_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.review_output_source_mtime_utc)
        ?? parseReviewTimingAuditTimestamp(entry.invocation_attested_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launch_completed_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launched_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.delegation_started_at_utc)
        ?? parseReviewTimingAuditTimestamp(entry.launch_prepared_at_utc)
        ?? Number.NEGATIVE_INFINITY;
}

function selectPreferredFinalUserReportTimingEntries(timingEntries: ReviewTimingAuditEntry[]): ReviewTimingAuditEntry[] {
    const eligibleEntries = timingEntries
        .map((entry, index) => ({ entry, index }))
        .filter(({ entry }) => (
            !entry.reused_existing_review
            && entry.delegation_to_result_ms != null
            && Number.isFinite(entry.delegation_to_result_ms)
            && entry.delegation_to_result_ms >= 0
        ))
        .sort((left, right) => (
            getReviewTimingAuditSortTimestamp(left.entry) - getReviewTimingAuditSortTimestamp(right.entry)
            || left.index - right.index
        ));
    return eligibleEntries.map(({ entry }) => entry);
}

function normalizeFinalUserReportVerdict(value: string): string {
    const text = String(value || '').trim();
    if (!text) {
        return 'unknown';
    }
    if (/\bPASSED\b/iu.test(text)) {
        return 'passed';
    }
    if (/\bFAILED\b/iu.test(text)) {
        return 'failed';
    }
    return text.toLowerCase();
}

function buildFinalUserReportReviewLine(
    reviewType: string,
    verdict: string,
    timingEntries: ReviewTimingAuditEntry[]
): string {
    const normalizedVerdict = normalizeFinalUserReportVerdict(verdict);
    const durations = selectPreferredFinalUserReportTimingEntries(timingEntries)
        .map((entry) => entry.delegation_to_result_ms)
        .filter((durationMs): durationMs is number =>
            durationMs != null && Number.isFinite(durationMs) && durationMs >= 0
        )
        .map((durationMs) => formatDurationMsAsMinutesSeconds(durationMs));
    if (durations.length === 0) {
        return `${reviewType}: ${normalizedVerdict}`;
    }
    return `${reviewType}(${durations.length}): ${normalizedVerdict} (${durations.join(' / ')})`;
}

function buildReviewTimingWarning(closeout: FinalCloseoutArtifact, attestation: ReviewIntegrityAttestation): string {
    const suspiciousEntries = (closeout.review_timing_audit?.entries || [])
        .filter((entry) => entry.hidden_timing_status === 'DISTRUSTED');
    if (suspiciousEntries.length > 0) {
        return 'WARNING: review accepted, but timing looked unusual; operator may double-check.';
    }
    if (attestation.completion_allowed !== true || attestation.status === 'DEGRADED_OR_UNVERIFIABLE') {
        return `WARNING: review evidence is degraded or unverifiable. ${attestation.reason}`;
    }
    return 'none';
}

function buildFullSuiteTimeoutEvidenceLines(closeout: FinalCloseoutArtifact): string[] {
    const timeout = closeout.workflow?.full_suite_timeout;
    if (!timeout) {
        return ['none'];
    }
    const lines = [timeout.visible_summary_line];
    const warnings = [
        ...timeout.warnings,
        ...(timeout.forecast_warning ? [`Forecast: ${timeout.forecast_warning}`] : [])
    ];
    if (warnings.length > 0) {
        lines.push(`Warnings: ${warnings.join(' | ')}`);
    }
    if (timeout.repair_task_proposal) {
        lines.push(
            `RepairTask: ${timeout.repair_task_proposal.suggested_task_id} - ` +
            `${timeout.repair_task_proposal.title}`
        );
    }
    return lines;
}

export function formatFinalUserReport(closeout: FinalCloseoutArtifact): string {
    const reviewIntegrityAttestation = getReviewIntegrityAttestation(closeout);
    const profile = closeout.implementation_summary.active_profile || 'unknown';
    const fullSuiteEnabled = closeout.workflow?.mandatory_full_suite_enabled === true ? 'enabled' : 'disabled';
    const docsUpdated = closeout.implementation_summary.docs_updated ? 'yes' : 'no';
    const taskStatus = closeout.status === 'READY' && closeout.audit_status === 'PASS' ? 'DONE' : 'BLOCKED';
    const timingEntries = new Map<string, ReviewTimingAuditEntry[]>();
    for (const entry of closeout.review_timing_audit?.entries || []) {
        if (entry.review_type) {
            const entries = timingEntries.get(entry.review_type) || [];
            entries.push(entry);
            timingEntries.set(entry.review_type, entries);
        }
    }
    const reviewEntries = Object.entries(closeout.implementation_summary.review_verdicts || {})
        .sort(([left], [right]) => left.localeCompare(right));
    const lines = [
        'GARDA FINAL REPORT',
        '',
        `Task: ${closeout.task_id}`,
        `Status: ${taskStatus}`,
        `Profile: ${profile}`,
        `MandatoryFullSuite: ${fullSuiteEnabled}`,
        `DocsUpdated: ${docsUpdated}`,
        '',
        'Review Verdicts:'
    ];
    if (reviewEntries.length === 0) {
        lines.push('none required');
    } else {
        for (const [reviewType, verdict] of reviewEntries) {
            lines.push(buildFinalUserReportReviewLine(reviewType, verdict, timingEntries.get(reviewType) || []));
        }
    }
    lines.push('');
    lines.push('Full-suite Timeout Evidence:');
    lines.push(...buildFullSuiteTimeoutEvidenceLines(closeout));
    lines.push('');
    lines.push('Review Timing Warning:');
    lines.push(buildReviewTimingWarning(closeout, reviewIntegrityAttestation));
    const advisoryNotes = formatKnownNonBlockingSignalSummaries(closeout.known_non_blocking_signals || []);
    lines.push('');
    lines.push('Advisory Notes:');
    lines.push(advisoryNotes || 'none');
    return lines.join('\n');
}
