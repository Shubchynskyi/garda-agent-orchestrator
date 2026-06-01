import * as fs from 'node:fs';
import * as path from 'node:path';

import type { ReviewCycleGuardEvaluation } from '../../core/review-cycle-guard';
import { collectOrderedTimelineEvents } from '../completion/completion-evidence';
import {
    fileSha256,
    isPathRealpathInsideRoot,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';

export const REVIEW_CYCLE_CONTINUATION_DECISIONS = ['allow_one_more_cycle'] as const;
export const REVIEW_CYCLE_CONTINUATION_EVENT = 'REVIEW_CYCLE_CONTINUATION_APPROVED';
export const REVIEW_CYCLE_CONTINUATION_ARTIFACT_SUFFIX = '-review-cycle-continuation.json';

export type ReviewCycleContinuationDecision = typeof REVIEW_CYCLE_CONTINUATION_DECISIONS[number];
export type ReviewCycleContinuationAssessmentStatus = 'MISSING' | 'ACTIVE' | 'EXPIRED' | 'INVALID';

export interface ReviewCycleContinuationArtifact {
    schema_version: 1;
    event_source: 'record-review-cycle-continuation';
    task_id: string;
    status: 'ACTIVE';
    scope: 'task';
    one_shot: true;
    decision: ReviewCycleContinuationDecision;
    reason: string;
    recorded_at_utc: string;
    operator_confirmed: true;
    operator_confirmed_at_utc: string;
    baseline: {
        total_non_test_review_count: number;
        failed_non_test_review_count: number;
        max_total_non_test_reviews: number;
        max_failed_non_test_reviews: number;
        excluded_review_types: string[];
    };
    allowance: {
        additional_total_non_test_review_attempts: 1;
        additional_failed_non_test_reviews: 1;
    };
    expiration: {
        count_exceeded: true;
        task_completion: true;
        task_reset_or_restart: true;
    };
}

export interface ReviewCycleContinuationAssessment {
    status: ReviewCycleContinuationAssessmentStatus;
    reason: string;
    artifact_path: string;
    artifact_sha256: string | null;
    artifact: ReviewCycleContinuationArtifact | null;
    remaining_total_non_test_review_attempts: number | null;
    remaining_failed_non_test_reviews: number | null;
}

const EXPIRING_EVENT_TYPES = new Set([
    'TASK_DONE',
    'TASK_BLOCKED',
    'TASK_RESET',
    'TASK_DISCARDED',
    'COHERENT_CYCLE_RESTARTED',
    'REVIEW_CYCLE_RESTARTED',
    'COMPLETION_GATE_PASSED'
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function asNonNegativeInteger(value: unknown): number | null {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0
        ? value
        : null;
}

function normalizeStringList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return value
        .map((entry) => typeof entry === 'string' ? entry.trim().toLowerCase() : '')
        .filter(Boolean);
}

export function normalizeReviewCycleContinuationDecision(value: unknown): ReviewCycleContinuationDecision {
    const normalized = typeof value === 'string'
        ? value.trim().toLowerCase().replace(/[\s-]+/g, '_')
        : '';
    if (!REVIEW_CYCLE_CONTINUATION_DECISIONS.includes(normalized as ReviewCycleContinuationDecision)) {
        throw new Error(`--decision must be one of: ${REVIEW_CYCLE_CONTINUATION_DECISIONS.join(', ')}.`);
    }
    return normalized as ReviewCycleContinuationDecision;
}

export function resolveReviewCycleContinuationArtifactPath(
    repoRoot: string,
    taskId: string,
    artifactPath = ''
): string {
    const trimmed = String(artifactPath || '').trim();
    if (trimmed) {
        const reviewEvidenceRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        const resolved = resolvePathInsideRepo(trimmed, repoRoot, {
            allowMissing: true,
            enforceInside: true
        });
        if (!resolved) {
            throw new Error('ArtifactPath must resolve inside the repository.');
        }
        if (!isPathRealpathInsideRoot(resolved, reviewEvidenceRoot, { allowMissing: true })) {
            throw new Error(
                `ArtifactPath must stay inside the runtime review evidence directory after realpath resolution: ${normalizePath(resolved)}`
            );
        }
        return resolved;
    }
    return joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}${REVIEW_CYCLE_CONTINUATION_ARTIFACT_SUFFIX}`)
    );
}

export function buildReviewCycleContinuationArtifact(params: {
    taskId: string;
    decision: unknown;
    reason: string;
    operatorConfirmedAtUtc: string;
    baselineTotalNonTestReviewCount: number;
    baselineFailedNonTestReviewCount: number;
    maxTotalNonTestReviews: number;
    maxFailedNonTestReviews: number;
    excludedReviewTypes: string[];
    recordedAtUtc?: string;
}): ReviewCycleContinuationArtifact {
    const reason = String(params.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    return {
        schema_version: 1,
        event_source: 'record-review-cycle-continuation',
        task_id: params.taskId,
        status: 'ACTIVE',
        scope: 'task',
        one_shot: true,
        decision: normalizeReviewCycleContinuationDecision(params.decision),
        reason,
        recorded_at_utc: params.recordedAtUtc || new Date().toISOString(),
        operator_confirmed: true,
        operator_confirmed_at_utc: params.operatorConfirmedAtUtc,
        baseline: {
            total_non_test_review_count: params.baselineTotalNonTestReviewCount,
            failed_non_test_review_count: params.baselineFailedNonTestReviewCount,
            max_total_non_test_reviews: params.maxTotalNonTestReviews,
            max_failed_non_test_reviews: params.maxFailedNonTestReviews,
            excluded_review_types: [...params.excludedReviewTypes]
        },
        allowance: {
            additional_total_non_test_review_attempts: 1,
            additional_failed_non_test_reviews: 1
        },
        expiration: {
            count_exceeded: true,
            task_completion: true,
            task_reset_or_restart: true
        }
    };
}

function invalidAssessment(
    artifactPath: string,
    reason: string,
    artifactSha256: string | null,
    artifact: ReviewCycleContinuationArtifact | null = null
): ReviewCycleContinuationAssessment {
    return {
        status: 'INVALID',
        reason,
        artifact_path: normalizePath(artifactPath),
        artifact_sha256: artifactSha256,
        artifact,
        remaining_total_non_test_review_attempts: null,
        remaining_failed_non_test_reviews: null
    };
}

function normalizeArtifact(payload: Record<string, unknown>): ReviewCycleContinuationArtifact | null {
    const baseline = isPlainRecord(payload.baseline) ? payload.baseline : null;
    const allowance = isPlainRecord(payload.allowance) ? payload.allowance : null;
    const expiration = isPlainRecord(payload.expiration) ? payload.expiration : null;
    if (!baseline || !allowance || !expiration) {
        return null;
    }
    const total = asNonNegativeInteger(baseline.total_non_test_review_count);
    const failed = asNonNegativeInteger(baseline.failed_non_test_review_count);
    const maxTotal = asNonNegativeInteger(baseline.max_total_non_test_reviews);
    const maxFailed = asNonNegativeInteger(baseline.max_failed_non_test_reviews);
    if (total == null || failed == null || maxTotal == null || maxFailed == null) {
        return null;
    }
    if (
        payload.schema_version !== 1
        || payload.event_source !== 'record-review-cycle-continuation'
        || payload.status !== 'ACTIVE'
        || payload.scope !== 'task'
        || payload.one_shot !== true
        || payload.operator_confirmed !== true
        || normalizeReviewCycleContinuationDecision(payload.decision) !== 'allow_one_more_cycle'
        || allowance.additional_total_non_test_review_attempts !== 1
        || allowance.additional_failed_non_test_reviews !== 1
        || expiration.count_exceeded !== true
        || expiration.task_completion !== true
        || expiration.task_reset_or_restart !== true
    ) {
        return null;
    }
    const artifact = payload as unknown as ReviewCycleContinuationArtifact;
    artifact.baseline = {
        total_non_test_review_count: total,
        failed_non_test_review_count: failed,
        max_total_non_test_reviews: maxTotal,
        max_failed_non_test_reviews: maxFailed,
        excluded_review_types: normalizeStringList(baseline.excluded_review_types)
    };
    return artifact;
}

export function assessReviewCycleContinuationEvidence(params: {
    repoRoot: string;
    reviewsRoot: string;
    eventsRoot: string;
    taskId: string;
    evaluation: ReviewCycleGuardEvaluation;
}): ReviewCycleContinuationAssessment {
    const artifactPath = resolveReviewCycleContinuationArtifactPath(params.repoRoot, params.taskId);
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            status: 'MISSING',
            reason: `review-cycle continuation artifact is missing at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath),
            artifact_sha256: null,
            artifact: null,
            remaining_total_non_test_review_attempts: null,
            remaining_failed_non_test_reviews: null
        };
    }

    const artifactSha256 = fileSha256(artifactPath);
    let payload: unknown;
    try {
        payload = JSON.parse(fs.readFileSync(artifactPath, 'utf8')) as unknown;
    } catch (error: unknown) {
        return invalidAssessment(
            artifactPath,
            `review-cycle continuation artifact is unreadable JSON: ${error instanceof Error ? error.message : String(error)}`,
            artifactSha256
        );
    }
    if (!isPlainRecord(payload)) {
        return invalidAssessment(artifactPath, 'review-cycle continuation artifact is not a JSON object', artifactSha256);
    }
    let artifact: ReviewCycleContinuationArtifact | null;
    try {
        artifact = normalizeArtifact(payload);
    } catch (error: unknown) {
        return invalidAssessment(
            artifactPath,
            `review-cycle continuation artifact decision is invalid: ${error instanceof Error ? error.message : String(error)}`,
            artifactSha256
        );
    }
    if (!artifact) {
        return invalidAssessment(artifactPath, 'review-cycle continuation artifact does not match the one-shot schema', artifactSha256);
    }
    if (artifact.task_id !== params.taskId) {
        return invalidAssessment(artifactPath, 'review-cycle continuation artifact task_id does not match the requested task', artifactSha256, artifact);
    }

    const timelineErrors: string[] = [];
    const timeline = collectOrderedTimelineEvents(path.join(params.eventsRoot, `${params.taskId}.jsonl`), timelineErrors);
    const normalizedArtifactPath = normalizePath(artifactPath);
    const approvalEvent = [...timeline].reverse().find((event) => {
        const details = event.details || {};
        return event.event_type === REVIEW_CYCLE_CONTINUATION_EVENT
            && String(details.decision || '') === artifact.decision
            && String(details.artifact_sha256 || '').toLowerCase() === artifactSha256
            && normalizePath(String(details.artifact_path || '')) === normalizedArtifactPath;
    });
    if (!approvalEvent) {
        return invalidAssessment(
            artifactPath,
            timelineErrors.length > 0
                ? `review-cycle continuation approval event is missing or unreadable (${timelineErrors.join('; ')})`
                : 'review-cycle continuation approval event is missing for the artifact',
            artifactSha256,
            artifact
        );
    }

    const expiringEvent = timeline.find((event) => event.sequence > approvalEvent.sequence && EXPIRING_EVENT_TYPES.has(event.event_type));
    if (expiringEvent) {
        return {
            status: 'EXPIRED',
            reason: `review-cycle continuation expired after ${expiringEvent.event_type}`,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            artifact,
            remaining_total_non_test_review_attempts: 0,
            remaining_failed_non_test_reviews: 0
        };
    }

    const allowedTotal = artifact.baseline.total_non_test_review_count + artifact.allowance.additional_total_non_test_review_attempts;
    const allowedFailed = artifact.baseline.failed_non_test_review_count + artifact.allowance.additional_failed_non_test_reviews;
    const currentTotal = params.evaluation.total_non_test_review_count;
    const currentFailed = params.evaluation.failed_non_test_review_count;
    if (currentTotal < artifact.baseline.total_non_test_review_count || currentFailed < artifact.baseline.failed_non_test_review_count) {
        return {
            status: 'EXPIRED',
            reason: 'review-cycle continuation expired because current review counts are below its approval baseline',
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            artifact,
            remaining_total_non_test_review_attempts: 0,
            remaining_failed_non_test_reviews: 0
        };
    }
    if (currentTotal >= allowedTotal || currentFailed >= allowedFailed) {
        return {
            status: 'EXPIRED',
            reason:
                `review-cycle continuation was already used: current total_non_test_reviews=${currentTotal}/${allowedTotal}; ` +
                `failed_non_test_reviews=${currentFailed}/${allowedFailed}`,
            artifact_path: normalizedArtifactPath,
            artifact_sha256: artifactSha256,
            artifact,
            remaining_total_non_test_review_attempts: 0,
            remaining_failed_non_test_reviews: 0
        };
    }

    return {
        status: 'ACTIVE',
        reason:
            `one-shot review-cycle continuation is active: remaining_total_non_test_review_attempts=${allowedTotal - currentTotal}; ` +
            `remaining_failed_non_test_reviews=${allowedFailed - currentFailed}`,
        artifact_path: normalizedArtifactPath,
        artifact_sha256: artifactSha256,
        artifact,
        remaining_total_non_test_review_attempts: allowedTotal - currentTotal,
        remaining_failed_non_test_reviews: allowedFailed - currentFailed
    };
}
