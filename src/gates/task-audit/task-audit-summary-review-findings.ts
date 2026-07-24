import * as path from 'node:path';

import type { ReviewFindingDispositionAction } from '../../policy/profile-resolver';
import type { TaskQueueEntry } from '../../core/task-queue-read';
import type { ReviewReuseTelemetryEventLike } from '../review-reuse/review-reuse-telemetry';
import {
    resolveLockedReviewFindingPolicyFromPreflight,
    resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence
} from '../review/review-finding-disposition';
import { validateReviewFindingsDispositionEvidence } from '../review/review-findings-disposition-evidence';
import type { ReviewFindingsDispositionArtifactItem } from '../review/review-findings-disposition-artifact';
import type { ReviewFindingsSeverity } from '../review/review-findings-schema';
import {
    validateReviewFindingsValidationArtifactForReceipt,
    type NormalizedReviewFindingInventoryEntry,
    type NormalizedReviewResidualRiskInventoryEntry
} from '../review/review-findings-validation-artifact';
import { normalizePath } from '../shared/helpers';
import type { ReviewAttemptSummary } from './task-audit-summary-review-attempts';
import {
    collectKnownRequiredReviewTypes,
    isPlainRecord,
    safeReadJson
} from './task-audit-summary-review-common';

const REVIEW_FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const satisfies readonly ReviewFindingsSeverity[];

export interface ReviewFindingsAuditItem {
    id: string;
    kind: 'finding' | 'residual_risk';
    severity: ReviewFindingsSeverity | 'residual_risk';
    title: string | null;
    description: string;
    evidence_locations: string[];
    coverage_obligation_ids: string[];
    action: ReviewFindingDispositionAction | null;
    materialization_status: string | null;
    follow_up_task_id: string | null;
    blocking: boolean;
}

export interface ReviewFindingsAuditLane {
    review_type: string;
    source_mode: 'fresh' | 'reused';
    validation_status: 'ACCEPTED' | 'REJECTED' | 'MISSING_OR_INVALID';
    validation_violations: string[];
    disposition_status: 'SATISFIED' | 'BLOCKED' | 'NOT_AVAILABLE';
    disposition_counts: {
        fix_now: number;
        create_follow_up: number;
        ignore: number;
    };
    disposition_violations: string[];
    findings: ReviewFindingsAuditItem[];
    remaining_blocker_ids: string[];
}

export interface ReviewFindingsValidationFailureAudit {
    timestamp_utc: string | null;
    review_type: string;
    reviewer_identity: string | null;
    violation: string;
    validation_artifact_sha256: string | null;
}

export interface ReviewFindingsRemediationCycleAudit {
    timestamp_utc: string | null;
    reason: string | null;
    invalidated_review_types: string[];
    preserved_review_types: string[];
    launch_required_review_types: string[];
    reused_review_types: string[];
}

export interface ReviewFindingsAuditSummary {
    status: 'CLEAR' | 'BLOCKED' | 'INCOMPLETE';
    lanes: ReviewFindingsAuditLane[];
    finding_count: number;
    residual_risk_count: number;
    disposition_counts: {
        fix_now: number;
        create_follow_up: number;
        ignore: number;
    };
    remaining_blocker_count: number;
    validation_failures: ReviewFindingsValidationFailureAudit[];
    remediation_cycles: ReviewFindingsRemediationCycleAudit[];
    fresh_review_count: number;
    reused_review_count: number;
    visible_summary_line: string;
}

function stringValue(value: unknown): string | null {
    const normalized = String(value || '').trim();
    return normalized || null;
}

function stringArray(value: unknown): string[] {
    return Array.isArray(value)
        ? value.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
}

function uniqueStrings(values: readonly string[]): string[] {
    return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

function readOutputContractString(receipt: Record<string, unknown>, key: string): string | null {
    const contract = isPlainRecord(receipt.review_output_contract) ? receipt.review_output_contract : null;
    return stringValue(contract?.[key]);
}

function readCoverageContractSha256(receipt: Record<string, unknown>): string | null {
    const coverage = isPlainRecord(receipt.review_coverage) ? receipt.review_coverage : null;
    return readOutputContractString(receipt, 'coverage_contract_sha256')
        || stringValue(coverage?.contract_sha256);
}

function followUpTaskIdsByFinding(followUpArtifactPath: string | null, evidenceValid: boolean): Map<string, string> {
    if (!evidenceValid || !followUpArtifactPath) {
        return new Map();
    }
    const artifact = safeReadJson(followUpArtifactPath);
    const items = Array.isArray(artifact?.items) ? artifact.items : [];
    return new Map(items
        .filter((item): item is Record<string, unknown> => isPlainRecord(item))
        .map((item) => [stringValue(item.source_item_id), stringValue(item.task_id)] as const)
        .filter((entry): entry is [string, string] => !!entry[0] && !!entry[1]));
}

function buildFindingItem(
    finding: NormalizedReviewFindingInventoryEntry,
    disposition: ReviewFindingsDispositionArtifactItem | undefined,
    followUpTaskId: string | null
): ReviewFindingsAuditItem {
    return {
        id: finding.id,
        kind: 'finding',
        severity: finding.severity,
        title: finding.title,
        description: finding.description,
        evidence_locations: [...finding.evidence_locations],
        coverage_obligation_ids: [...finding.coverage_obligation_ids],
        action: disposition?.action ?? null,
        materialization_status: disposition?.materialization_status ?? null,
        follow_up_task_id: followUpTaskId,
        blocking: disposition?.blocking === true
    };
}

function buildResidualRiskItem(
    risk: NormalizedReviewResidualRiskInventoryEntry,
    disposition: ReviewFindingsDispositionArtifactItem | undefined,
    followUpTaskId: string | null
): ReviewFindingsAuditItem {
    return {
        id: risk.id,
        kind: 'residual_risk',
        severity: 'residual_risk',
        title: null,
        description: risk.description,
        evidence_locations: [...risk.evidence_locations],
        coverage_obligation_ids: [],
        action: disposition?.action ?? null,
        materialization_status: disposition?.materialization_status ?? null,
        follow_up_task_id: followUpTaskId,
        blocking: disposition?.blocking === true
    };
}

function buildMissingLane(reviewType: string, reason: string): ReviewFindingsAuditLane {
    return {
        review_type: reviewType,
        source_mode: 'fresh',
        validation_status: 'MISSING_OR_INVALID',
        validation_violations: [reason],
        disposition_status: 'NOT_AVAILABLE',
        disposition_counts: { fix_now: 0, create_follow_up: 0, ignore: 0 },
        disposition_violations: [],
        findings: [],
        remaining_blocker_ids: []
    };
}

function buildCurrentFindingsLane(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    reviewType: string;
    currentPreflight: Record<string, unknown> | null;
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>;
}): ReviewFindingsAuditLane | null {
    const receiptPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-receipt.json`);
    const receipt = safeReadJson(receiptPath);
    if (!receipt) {
        return buildMissingLane(options.reviewType, `Structured review receipt is missing: ${normalizePath(receiptPath)}.`);
    }
    if (stringValue(receipt.review_output_format) !== 'findings_json') {
        return null;
    }

    const reviewArtifactPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const reviewContextPath = path.join(options.reviewsRoot, `${options.taskId}-${options.reviewType}-review-context.json`);
    const preflightPath = path.join(options.reviewsRoot, `${options.taskId}-preflight.json`);
    const reused = receipt.reused_existing_review === true;
    const validation = validateReviewFindingsValidationArtifactForReceipt({
        receipt,
        reviewArtifactPath,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewOutputSha256: stringValue(receipt.review_output_sha256),
        expectedReviewArtifactSha256: stringValue(receipt.review_artifact_sha256),
        expectedReviewContextPath: reused ? null : reviewContextPath,
        expectedReviewContextSha256: reused
            ? stringValue(receipt.reused_from_review_context_sha256)
            : stringValue(receipt.review_context_sha256),
        expectedPreflightPath: reused ? null : preflightPath,
        expectedPreflightSha256: reused ? null : stringValue(receipt.preflight_sha256),
        expectedScopeSha256: reused ? null : stringValue(receipt.scope_sha256),
        expectedReviewScopeSha256: reused
            ? stringValue(receipt.reused_from_review_scope_sha256)
            : stringValue(receipt.review_scope_sha256),
        expectedCodeScopeSha256: reused
            ? stringValue(receipt.reused_from_code_scope_sha256)
            : stringValue(receipt.code_scope_sha256),
        expectedReviewTreeStateSha256: reused
            ? stringValue(receipt.reused_from_review_tree_state_sha256)
            : stringValue(receipt.review_tree_state_sha256),
        expectedCoverageContractSha256: readCoverageContractSha256(receipt),
        requireAccepted: true,
        preferSnapshot: reused
    });
    const validationViolations = uniqueStrings([
        ...validation.violations,
        ...(validation.artifact?.validation_result.violations || [])
    ]);
    if (!validation.artifact || !validation.reference || !validation.artifact_sha256) {
        return {
            ...buildMissingLane(options.reviewType, validationViolations[0] || 'Structured findings validation evidence is unavailable.'),
            source_mode: reused ? 'reused' : 'fresh',
            validation_violations: validationViolations
        };
    }

    const policyResolution = reused
        ? resolveLockedReviewFindingPolicyFromReceiptDispositionEvidence(receipt)
        : resolveLockedReviewFindingPolicyFromPreflight(options.currentPreflight);
    const disposition = validation.valid && validation.accepted
        ? validateReviewFindingsDispositionEvidence({
            repoRoot: options.repoRoot,
            receipt,
            receiptPath,
            reviewArtifactPath,
            expectedTaskId: options.taskId,
            expectedReviewType: options.reviewType,
            validationArtifact: validation.artifact,
            validationArtifactPath: validation.reference.artifact_path,
            validationArtifactSha256: validation.artifact_sha256,
            policyResolution,
            expectedReceiptPath: reused ? stringValue(receipt.reused_from_receipt_path) : null,
            expectedReceiptSha256: reused ? stringValue(receipt.reused_from_receipt_sha256) : null,
            preferSnapshot: reused,
            taskQueueRows: options.taskQueueEntries
                ? [...options.taskQueueEntries.values()]
                : undefined
        })
        : null;
    const dispositionItems = new Map((disposition?.artifact?.items || []).map((item) => [item.id, item]));
    const followUpTaskIds = followUpTaskIdsByFinding(
        disposition?.follow_up_artifact_path || null,
        disposition?.valid === true
    );
    const inventory = validation.artifact.validation_result.normalized_inventory;
    const findings: ReviewFindingsAuditItem[] = [];
    for (const severity of REVIEW_FINDING_SEVERITIES) {
        for (const finding of inventory.findings_by_severity[severity]) {
            findings.push(buildFindingItem(
                finding,
                dispositionItems.get(finding.id),
                followUpTaskIds.get(finding.id) || null
            ));
        }
    }
    for (const risk of inventory.residual_risks) {
        findings.push(buildResidualRiskItem(
            risk,
            dispositionItems.get(risk.id),
            followUpTaskIds.get(risk.id) || null
        ));
    }
    const dispositionCounts = disposition?.artifact?.disposition_result.counts_by_action || {
        fix_now: 0,
        create_follow_up: 0,
        ignore: 0
    };
    const dispositionViolations = uniqueStrings(disposition?.violations || []);
    const remainingBlockerIds = uniqueStrings([
        ...(disposition?.artifact?.disposition_result.blocking_ids || []),
        ...findings
            .filter((item) => item.action === 'create_follow_up' && !item.follow_up_task_id)
            .map((item) => item.id)
    ]);

    return {
        review_type: options.reviewType,
        source_mode: reused ? 'reused' : 'fresh',
        validation_status: validation.accepted
            ? validation.valid ? 'ACCEPTED' : 'MISSING_OR_INVALID'
            : 'REJECTED',
        validation_violations: validationViolations,
        disposition_status: !disposition
            ? 'NOT_AVAILABLE'
            : disposition.valid ? 'SATISFIED' : 'BLOCKED',
        disposition_counts: { ...dispositionCounts },
        disposition_violations: dispositionViolations,
        findings,
        remaining_blocker_ids: remainingBlockerIds
    };
}

function collectValidationFailures(events: readonly ReviewReuseTelemetryEventLike[]): ReviewFindingsValidationFailureAudit[] {
    return events.flatMap((event) => {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEWER_LAUNCH_FAILED') {
            return [];
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventRecord = event as unknown as Record<string, unknown>;
        if (stringValue(details.launch_failure_stage) !== 'review_findings_validation') {
            return [];
        }
        return [{
            timestamp_utc: stringValue(eventRecord.timestamp_utc),
            review_type: stringValue(details.review_type) || 'unknown',
            reviewer_identity: stringValue(details.reviewer_identity),
            violation: stringValue(details.launch_failure_reason) || 'Structured findings validation rejected the reviewer output.',
            validation_artifact_sha256: stringValue(details.review_findings_validation_artifact_sha256)
        }];
    });
}

function collectRemediationCycles(events: readonly ReviewReuseTelemetryEventLike[]): ReviewFindingsRemediationCycleAudit[] {
    return events.flatMap((event) => {
        if (String(event.event_type || '').trim().toUpperCase() !== 'REVIEW_CYCLE_RESTARTED') {
            return [];
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventRecord = event as unknown as Record<string, unknown>;
        return [{
            timestamp_utc: stringValue(eventRecord.timestamp_utc),
            reason: stringValue(details.restart_reason),
            invalidated_review_types: stringArray(details.invalidated_review_types),
            preserved_review_types: stringArray(details.preserved_review_types),
            launch_required_review_types: stringArray(details.launch_required_review_types),
            reused_review_types: stringArray(details.reused_review_types)
        }];
    });
}

export function buildReviewFindingsAuditSummary(options: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    requiredReviews: Record<string, boolean>;
    currentPreflight: Record<string, unknown> | null;
    timelineEvents: readonly ReviewReuseTelemetryEventLike[];
    reviewAttemptSummary: ReviewAttemptSummary | null;
    taskQueueEntries?: ReadonlyMap<string, TaskQueueEntry>;
}): ReviewFindingsAuditSummary | null {
    const validationFailures = collectValidationFailures(options.timelineEvents);
    const remediationCycles = collectRemediationCycles(options.timelineEvents);
    const lanes = collectKnownRequiredReviewTypes(options.requiredReviews)
        .map((reviewType) => buildCurrentFindingsLane({ ...options, reviewType }))
        .filter((lane): lane is ReviewFindingsAuditLane => lane !== null)
        .sort((left, right) => left.review_type.localeCompare(right.review_type));
    if (lanes.length === 0 && validationFailures.length === 0 && remediationCycles.length === 0) {
        return null;
    }
    const findings = lanes.flatMap((lane) => lane.findings);
    const dispositionCounts = lanes.reduce((counts, lane) => ({
        fix_now: counts.fix_now + lane.disposition_counts.fix_now,
        create_follow_up: counts.create_follow_up + lane.disposition_counts.create_follow_up,
        ignore: counts.ignore + lane.disposition_counts.ignore
    }), { fix_now: 0, create_follow_up: 0, ignore: 0 });
    const remainingBlockerCount = lanes.reduce((count, lane) => (
        count
        + lane.remaining_blocker_ids.length
        + (lane.validation_violations.length > 0 ? 1 : 0)
        + (lane.remaining_blocker_ids.length === 0 && lane.disposition_violations.length > 0 ? 1 : 0)
    ), 0);
    const reusedReviewCount = Object.values(options.reviewAttemptSummary?.fresh_reused_by_review_type || {})
        .reduce((count, entry) => count + entry.reused, 0);
    const freshReviewCount = options.reviewAttemptSummary?.total_attempts || 0;
    const hasIncompleteLane = lanes.some((lane) => (
        lane.validation_status === 'MISSING_OR_INVALID'
        || (lane.validation_status === 'ACCEPTED' && lane.disposition_status === 'NOT_AVAILABLE')
    ));
    const status: ReviewFindingsAuditSummary['status'] = remainingBlockerCount > 0
        ? hasIncompleteLane ? 'INCOMPLETE' : 'BLOCKED'
        : 'CLEAR';
    return {
        status,
        lanes,
        finding_count: findings.filter((item) => item.kind === 'finding').length,
        residual_risk_count: findings.filter((item) => item.kind === 'residual_risk').length,
        disposition_counts: dispositionCounts,
        remaining_blocker_count: remainingBlockerCount,
        validation_failures: validationFailures,
        remediation_cycles: remediationCycles,
        fresh_review_count: freshReviewCount,
        reused_review_count: reusedReviewCount,
        visible_summary_line:
            `Review findings audit: status=${status}; lanes=${lanes.length}; findings=${findings.filter((item) => item.kind === 'finding').length}; ` +
            `residual_risks=${findings.filter((item) => item.kind === 'residual_risk').length}; ` +
            `fix_now=${dispositionCounts.fix_now}; follow_up=${dispositionCounts.create_follow_up}; ignored=${dispositionCounts.ignore}; ` +
            `remaining_blockers=${remainingBlockerCount}; validation_failures=${validationFailures.length}; ` +
            `remediation_cycles=${remediationCycles.length}; fresh_reviews=${freshReviewCount}; reused_reviews=${reusedReviewCount}`
    };
}
