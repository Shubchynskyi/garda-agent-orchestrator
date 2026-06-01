import * as path from 'node:path';
import { EXIT_GATE_FAILURE } from '../../../exit-codes';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../../core/operator-confirmation';
import {
    appendMandatoryTaskEvent,
    appendTaskEvent,
    assertValidTaskId
} from '../../../../gate-runtime/task-events';
import {
    REVIEW_CYCLE_CONTINUATION_EVENT,
    buildReviewCycleContinuationArtifact,
    normalizeReviewCycleContinuationDecision,
    resolveReviewCycleContinuationArtifactPath
} from '../../../../gates/review-cycle/review-cycle-continuation';
import {
    REVIEW_CYCLE_SPLIT_DECISION_EVENT,
    buildReviewCycleSplitDecisionArtifact,
    normalizeReviewCycleSplitDecision,
    resolveReviewCycleSplitDecisionArtifactPath,
    resolveReviewCycleSplitDecisionPreflightPath
} from '../../../../gates/review-cycle/review-cycle-split-decision';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    resolveDefaultMetricsPath,
    resolvePathForWrite,
    writeJsonArtifact
} from '../../gates-artifacts';
import {
    expandValueList,
    parseBooleanOption
} from '../../gates-parser';
import { requireResolvedPath } from '../../shared-command-utils';
import {
    appendMetricsIfEnabled,
    resolveOrchestratorRoot
} from '../compile/gate-flow-helpers';
import { syncTaskQueueStatusDetailed } from '../task/task-queue-sync';

export interface RecordReviewCycleContinuationCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    decision?: unknown;
    reason?: unknown;
    baselineTotalNonTestReviewCount?: unknown;
    baselineFailedNonTestReviewCount?: unknown;
    maxTotalNonTestReviews?: unknown;
    maxFailedNonTestReviews?: unknown;
    excludedReviewTypes?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

export interface RecordReviewCycleSplitDecisionCommandOptions {
    repoRoot?: string;
    taskId?: unknown;
    decision?: unknown;
    reason?: unknown;
    preflightPath?: unknown;
    baselineTotalNonTestReviewCount?: unknown;
    baselineFailedNonTestReviewCount?: unknown;
    maxTotalNonTestReviews?: unknown;
    maxFailedNonTestReviews?: unknown;
    excludedReviewTypes?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

function parseNonNegativeIntegerOption(value: unknown, label: string): number {
    const text = String(value ?? '').trim();
    if (!/^\d+$/u.test(text)) {
        throw new Error(`${label} must be a non-negative integer.`);
    }
    return Number.parseInt(text, 10);
}

function parseExcludedReviewTypes(value: unknown): string[] {
    return expandValueList(value || [], { splitDelimiters: true })
        .map((entry) => String(entry || '').trim().toLowerCase())
        .filter(Boolean);
}

function validateReviewCycleOperatorConfirmation(
    actionLabel: string,
    rawOperatorConfirmed: unknown,
    operatorConfirmedAtUtc: string,
    instruction: string
): void {
    const rawConfirmation = String(rawOperatorConfirmed || '').trim();
    validateFreshOperatorConfirmation({
        actionLabel,
        confirmed: rawConfirmation ? parseOperatorConfirmationYes(rawConfirmation) : false,
        confirmedAtUtc: operatorConfirmedAtUtc,
        requireConfirmedAtUtc: true,
        instruction
    });
}

export function runRecordReviewCycleContinuationCommand(
    options: RecordReviewCycleContinuationCommandOptions
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const decision = normalizeReviewCycleContinuationDecision(options.decision);
    const reason = String(options.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    const operatorConfirmedAtUtc = String(options.operatorConfirmedAtUtc || '').trim();
    validateReviewCycleOperatorConfirmation(
        'record-review-cycle-continuation',
        options.operatorConfirmed,
        operatorConfirmedAtUtc,
        'Ask the operator to approve exactly one additional review-cycle continuation, then rerun with ' +
        '--operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". This gate writes runtime evidence only and does not edit workflow-config.json.'
    );

    const baselineTotal = parseNonNegativeIntegerOption(
        options.baselineTotalNonTestReviewCount,
        '--baseline-total-non-test-reviews'
    );
    const baselineFailed = parseNonNegativeIntegerOption(
        options.baselineFailedNonTestReviewCount,
        '--baseline-failed-non-test-reviews'
    );
    const maxTotal = parseNonNegativeIntegerOption(
        options.maxTotalNonTestReviews,
        '--max-total-non-test-reviews'
    );
    const maxFailed = parseNonNegativeIntegerOption(
        options.maxFailedNonTestReviews,
        '--max-failed-non-test-reviews'
    );
    const excludedReviewTypes = parseExcludedReviewTypes(options.excludedReviewTypes);

    const artifactPath = resolveReviewCycleContinuationArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const artifact = buildReviewCycleContinuationArtifact({
        taskId,
        decision,
        reason,
        operatorConfirmedAtUtc,
        baselineTotalNonTestReviewCount: baselineTotal,
        baselineFailedNonTestReviewCount: baselineFailed,
        maxTotalNonTestReviews: maxTotal,
        maxFailedNonTestReviews: maxFailed,
        excludedReviewTypes
    });
    writeJsonArtifact(artifactPath, artifact);
    const artifactSha256 = gateHelpers.fileSha256(artifactPath);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: artifact.recorded_at_utc,
        event_type: 'review_cycle_continuation_approved',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(artifactPath),
        artifact_sha256: artifactSha256,
        decision,
        one_shot: true,
        baseline_total_non_test_review_count: baselineTotal,
        baseline_failed_non_test_review_count: baselineFailed,
        max_total_non_test_reviews: maxTotal,
        max_failed_non_test_reviews: maxFailed,
        excluded_review_types: excludedReviewTypes
    }, parseBooleanOption(options.emitMetrics, true));

    appendTaskEvent(
        orchestratorRoot,
        taskId,
        REVIEW_CYCLE_CONTINUATION_EVENT,
        'INFO',
        'One-shot review-cycle continuation approved.',
        {
            artifact_path: gateHelpers.normalizePath(artifactPath),
            artifact_sha256: artifactSha256,
            decision,
            one_shot: true,
            baseline_total_non_test_review_count: baselineTotal,
            baseline_failed_non_test_review_count: baselineFailed,
            max_total_non_test_reviews: maxTotal,
            max_failed_non_test_reviews: maxFailed,
            excluded_review_types: excludedReviewTypes,
            operator_confirmed_at_utc: operatorConfirmedAtUtc
        }
    );

    return {
        outputLines: [
            'REVIEW_CYCLE_CONTINUATION_RECORDED',
            `TaskId: ${taskId}`,
            `Decision: ${decision}`,
            'OneShot: true',
            `BaselineTotalNonTestReviews: ${baselineTotal}`,
            `BaselineFailedNonTestReviews: ${baselineFailed}`,
            `ArtifactPath: ${gateHelpers.normalizePath(artifactPath)}`,
            'WorkflowConfigMutated: false'
        ],
        exitCode: 0
    };
}

export function runRecordReviewCycleSplitDecisionCommand(
    options: RecordReviewCycleSplitDecisionCommandOptions
): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const orchestratorRoot = resolveOrchestratorRoot(repoRoot);
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const decision = normalizeReviewCycleSplitDecision(options.decision);
    const reason = String(options.reason || '').trim();
    if (!reason) {
        throw new Error('Reason is required.');
    }
    const operatorConfirmedAtUtc = String(options.operatorConfirmedAtUtc || '').trim();
    validateReviewCycleOperatorConfirmation(
        'record-review-cycle-split-decision',
        options.operatorConfirmed,
        operatorConfirmedAtUtc,
        'Ask the operator to approve splitting the task after the review-cycle guard blocks continuation, then rerun with ' +
        '--operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". This gate moves the parent to SPLIT_REQUIRED and writes runtime evidence only.'
    );

    const baselineTotal = parseNonNegativeIntegerOption(
        options.baselineTotalNonTestReviewCount,
        '--baseline-total-non-test-reviews'
    );
    const baselineFailed = parseNonNegativeIntegerOption(
        options.baselineFailedNonTestReviewCount,
        '--baseline-failed-non-test-reviews'
    );
    const maxTotal = parseNonNegativeIntegerOption(
        options.maxTotalNonTestReviews,
        '--max-total-non-test-reviews'
    );
    const maxFailed = parseNonNegativeIntegerOption(
        options.maxFailedNonTestReviews,
        '--max-failed-non-test-reviews'
    );
    const excludedReviewTypes = parseExcludedReviewTypes(options.excludedReviewTypes);
    const preflightPath = resolveReviewCycleSplitDecisionPreflightPath(repoRoot, options.preflightPath);
    const preflightSha256 = gateHelpers.fileSha256(preflightPath);
    const recordedAtUtc = new Date().toISOString();

    const decisionArtifactPath = resolveReviewCycleSplitDecisionArtifactPath(repoRoot, taskId, String(options.artifactPath || ''));
    const decisionArtifact = buildReviewCycleSplitDecisionArtifact({
        taskId,
        decision,
        reason,
        operatorConfirmedAtUtc,
        preflightPath,
        baselineTotalNonTestReviewCount: baselineTotal,
        baselineFailedNonTestReviewCount: baselineFailed,
        maxTotalNonTestReviews: maxTotal,
        maxFailedNonTestReviews: maxFailed,
        excludedReviewTypes,
        recordedAtUtc
    });
    writeJsonArtifact(decisionArtifactPath, decisionArtifact);
    const decisionArtifactSha256 = gateHelpers.fileSha256(decisionArtifactPath);

    const latchArtifactPath = path.join(orchestratorRoot, 'runtime', 'reviews', `${taskId}-split-required.json`);
    const statusSync = syncTaskQueueStatusDetailed(repoRoot, taskId, 'SPLIT_REQUIRED');
    const guardReason = `Manual review-cycle split decision: ${decision}.`;
    const baseLatchArtifact = {
        schema_version: 1,
        timestamp_utc: recordedAtUtc,
        task_id: taskId,
        status: 'SPLIT_REQUIRED',
        guard_kind: 'review_cycle',
        guard_reason: guardReason,
        raw_guard_summary: `Operator selected ${decision} after review-cycle guard blocked continuation.`,
        preflight_path: gateHelpers.normalizePath(preflightPath),
        preflight_sha256: preflightSha256,
        next_actions: [
            'create_and_link_child_tasks',
            'rerun_next_step_on_parent_to_transition_to_decomposed',
            'or_use_explicit_operator_task_reset_or_discard'
        ],
        guard_details: {
            event_source: 'record-review-cycle-split-decision',
            decision,
            reason,
            operator_confirmed: true,
            operator_confirmed_at_utc: operatorConfirmedAtUtc,
            decision_artifact_path: gateHelpers.normalizePath(decisionArtifactPath),
            decision_artifact_sha256: decisionArtifactSha256,
            baseline_total_non_test_review_count: baselineTotal,
            baseline_failed_non_test_review_count: baselineFailed,
            max_total_non_test_reviews: maxTotal,
            max_failed_non_test_reviews: maxFailed,
            excluded_review_types: excludedReviewTypes
        }
    };
    const statusSyncPayload = {
        outcome: statusSync.outcome,
        previous_status: statusSync.previous_status,
        next_status: statusSync.next_status,
        error_message: statusSync.error_message
    };
    writeJsonArtifact(latchArtifactPath, {
        ...baseLatchArtifact,
        materialization_phase: statusSync.outcome === 'updated' || statusSync.outcome === 'already_synced'
            ? 'complete'
            : 'status_sync_failed',
        status_sync: statusSyncPayload
    });
    const latchArtifactSha256 = gateHelpers.fileSha256(latchArtifactPath);

    const metricsPath = options.metricsPath
        ? requireResolvedPath(resolvePathForWrite(options.metricsPath, repoRoot), 'MetricsPath')
        : resolveDefaultMetricsPath(repoRoot);
    appendMetricsIfEnabled(repoRoot, metricsPath, {
        timestamp_utc: recordedAtUtc,
        event_type: 'review_cycle_split_decision_recorded',
        task_id: taskId,
        artifact_path: gateHelpers.normalizePath(decisionArtifactPath),
        artifact_sha256: decisionArtifactSha256,
        split_required_artifact_path: gateHelpers.normalizePath(latchArtifactPath),
        split_required_artifact_sha256: latchArtifactSha256,
        decision,
        baseline_total_non_test_review_count: baselineTotal,
        baseline_failed_non_test_review_count: baselineFailed,
        max_total_non_test_reviews: maxTotal,
        max_failed_non_test_reviews: maxFailed,
        excluded_review_types: excludedReviewTypes,
        status_sync_outcome: statusSync.outcome
    }, parseBooleanOption(options.emitMetrics, true));

    if (statusSync.outcome !== 'updated' && statusSync.outcome !== 'already_synced') {
        return {
            outputLines: [
                'REVIEW_CYCLE_SPLIT_DECISION_FAILED',
                `TaskId: ${taskId}`,
                `Decision: ${decision}`,
                `StatusSyncOutcome: ${statusSync.outcome}`,
                `StatusSyncError: ${statusSync.error_message || 'none'}`,
                `ArtifactPath: ${gateHelpers.normalizePath(decisionArtifactPath)}`,
                `SplitRequiredArtifactPath: ${gateHelpers.normalizePath(latchArtifactPath)}`
            ],
            exitCode: EXIT_GATE_FAILURE
        };
    }

    appendMandatoryTaskEvent(
        orchestratorRoot,
        taskId,
        REVIEW_CYCLE_SPLIT_DECISION_EVENT,
        'BLOCKED',
        'Operator approved review-cycle split decision.',
        {
            artifact_path: gateHelpers.normalizePath(decisionArtifactPath),
            artifact_sha256: decisionArtifactSha256,
            split_required_artifact_path: gateHelpers.normalizePath(latchArtifactPath),
            split_required_artifact_sha256: latchArtifactSha256,
            decision,
            reason,
            operator_confirmed_at_utc: operatorConfirmedAtUtc
        },
        { actor: 'orchestrator' }
    );
    appendMandatoryTaskEvent(
        orchestratorRoot,
        taskId,
        'SPLIT_REQUIRED_LATCHED',
        'BLOCKED',
        'Manual review-cycle split decision latched the parent task.',
        {
            status: 'SPLIT_REQUIRED',
            guard_kind: 'review_cycle',
            guard_reason: guardReason,
            artifact_path: gateHelpers.normalizePath(latchArtifactPath),
            artifact_sha256: latchArtifactSha256,
            preflight_path: gateHelpers.normalizePath(preflightPath),
            preflight_sha256: preflightSha256,
            status_sync_outcome: statusSync.outcome,
            decision,
            decision_artifact_path: gateHelpers.normalizePath(decisionArtifactPath),
            decision_artifact_sha256: decisionArtifactSha256
        },
        { actor: 'orchestrator' }
    );
    if (statusSync.outcome === 'updated') {
        appendMandatoryTaskEvent(
            orchestratorRoot,
            taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${statusSync.previous_status || 'UNKNOWN'} -> SPLIT_REQUIRED.`,
            {
                previous_status: statusSync.previous_status || 'UNKNOWN',
                new_status: 'SPLIT_REQUIRED',
                reason: 'manual_review_cycle_split_decision',
                guard_kind: 'review_cycle',
                artifact_path: gateHelpers.normalizePath(latchArtifactPath),
                artifact_sha256: latchArtifactSha256
            },
            { actor: 'orchestrator' }
        );
    }

    return {
        outputLines: [
            'REVIEW_CYCLE_SPLIT_DECISION_RECORDED',
            `TaskId: ${taskId}`,
            `Decision: ${decision}`,
            `StatusSyncOutcome: ${statusSync.outcome}`,
            `ArtifactPath: ${gateHelpers.normalizePath(decisionArtifactPath)}`,
            `SplitRequiredArtifactPath: ${gateHelpers.normalizePath(latchArtifactPath)}`,
            'WorkflowConfigMutated: false'
        ],
        exitCode: 0
    };
}
