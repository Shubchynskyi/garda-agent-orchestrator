import * as fs from 'node:fs';

import { isPlainRecord } from '../../../../core/records';
import {
    buildReviewContext
} from '../../../../gates/review-context/build-review-context';
import { fileSha256 } from '../../../../gates/shared/helpers';
import { assertReviewLifecycleGuardFromEntries } from '../../../../gates/review/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../../gates/review/review-dependencies';
import {
    computeReviewContextReuseHash
} from '../../../../gates/review-reuse/review-reuse';
import { inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import {
    buildAcceptedCurrentPassReviewContextCommandResult,
    buildGeneratedReviewContextCommandResult,
    resolveBuildReviewContextCommandInputs,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';
import {
    emitCurrentPassReviewContextReuseAccepted,
    emitGeneratedReviewContextPreparationTelemetry
} from './review-context-telemetry';
import {
    tryAcceptCurrentPassReviewEvidence
} from './review-context-flow-current-pass-reuse';
import {
    tryReuseReviewEvidence,
    type ReviewReuseResult
} from './review-context-flow-historical-reuse';

export {
    readTimelineEventsSummary,
    type BuildReviewContextCommandOptions,
    type BuildReviewContextCommandResult
} from './review-context-command-binding';

function taskEventSequence(event: Record<string, unknown>): number {
    return isPlainRecord(event.integrity)
        ? Number(event.integrity.task_sequence) || 0
        : 0;
}

function hasFreshPassingReviewAfterBoundary(options: {
    events: Record<string, unknown>[];
    boundarySequence: number;
    taskId: string;
    reviewType: string;
    preflightSha256: string;
}): boolean {
    return options.events.some((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        const disposition = isPlainRecord(details.review_findings_disposition)
            ? details.review_findings_disposition
            : {};
        return taskEventSequence(event) > options.boundarySequence
            && String(event.event_type || '').trim() === 'REVIEW_RECORDED'
            && String(details.task_id || '').trim() === options.taskId
            && String(details.review_type || '').trim().toLowerCase() === options.reviewType
            && String(details.preflight_sha256 || '').trim().toLowerCase() === options.preflightSha256
            && details.reused_existing_review === false
            && (
                String(disposition.verdict || '').trim() === 'pass_no_findings'
                || String(disposition.verdict || '').trim() === 'pass_with_follow_up_or_ignored_findings'
            );
    });
}

function resolvePersistedRemediationReusePolicy(options: {
    events: Record<string, unknown>[];
    taskId: string;
    reviewType: string;
    preflightPath: string;
    timelinePath: string;
}): { blockedReason: string; preservedScopeMismatchReason: string } {
    const resolvedPreflightSha256 = fileSha256(options.preflightPath);
    if (!resolvedPreflightSha256) {
        return { blockedReason: '', preservedScopeMismatchReason: '' };
    }
    const preflightSha256 = resolvedPreflightSha256.toLowerCase();
    const hasMatchingRestartEvent = options.events.some((event) => {
        const details = isPlainRecord(event.details) ? event.details : {};
        return String(event.event_type || '').trim() === 'REVIEW_CYCLE_RESTARTED'
            && String(details.task_id || '').trim() === options.taskId
            && String(details.preflight_sha256 || '').trim().toLowerCase() === preflightSha256;
    });
    if (
        hasMatchingRestartEvent
        && !inspectTaskEventFile(options.timelinePath, options.taskId).status.startsWith('PASS')
    ) {
        return {
            blockedReason:
                'review reuse blocked because the persisted remediation timeline failed hash-chain integrity validation',
            preservedScopeMismatchReason: ''
        };
    }
    for (let index = options.events.length - 1; index >= 0; index -= 1) {
        const event = options.events[index];
        const details = isPlainRecord(event.details) ? event.details : {};
        if (
            String(event.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.task_id || '').trim() !== options.taskId
            || String(details.event_type || '').trim() !== 'REVIEW_CYCLE_RESTARTED'
            || String(details.status || '').trim() !== 'PASSED'
            || String(details.preflight_sha256 || '').trim().toLowerCase() !== preflightSha256
            || taskEventSequence(event) <= 0
        ) {
            continue;
        }
        const category = String(details.remediation_category || '').trim() || 'unknown';
        const invalidatedReviewTypes = new Set(
            Array.isArray(details.invalidated_review_types)
                ? details.invalidated_review_types
                    .map((entry) => String(entry || '').trim().toLowerCase())
                    .filter(Boolean)
                : []
        );
        if (invalidatedReviewTypes.has(options.reviewType)) {
            if (hasFreshPassingReviewAfterBoundary({
                events: options.events,
                boundarySequence: taskEventSequence(event),
                taskId: options.taskId,
                reviewType: options.reviewType,
                preflightSha256
            })) {
                return { blockedReason: '', preservedScopeMismatchReason: '' };
            }
            return {
                blockedReason:
                    `review reuse blocked by persisted remediation classification '${category}' ` +
                    `for invalidated review type '${options.reviewType}'`,
                preservedScopeMismatchReason: ''
            };
        }
        return {
            blockedReason: '',
            preservedScopeMismatchReason:
                `persisted remediation classification '${category}' preserved review type '${options.reviewType}'`
        };
    }
    return { blockedReason: '', preservedScopeMismatchReason: '' };
}

export async function runBuildReviewContextCommand(
    options: BuildReviewContextCommandOptions
): Promise<BuildReviewContextCommandResult> {
    const {
        repoRoot,
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath,
        taskId,
        taskModeEvidence,
        runtimeReviewerIdentity,
        timelinePath,
        timelineSummary,
        tokenEconomyConfigPath,
        outputPath,
        scopedDiffMetadataPath,
        focusedRequiredTestPath,
        reviewReuseBlockedReason
    } = resolveBuildReviewContextCommandInputs(options);
    let persistedRemediationReusePolicy = {
        blockedReason: '',
        preservedScopeMismatchReason: ''
    };
    if (taskId) {
        assertReviewLifecycleGuardFromEntries(
            String(timelinePath),
            timelineSummary?.events || [],
            timelineSummary?.hasInvalidLines === true,
            'build-review-context',
            'review_phase'
        );
        if (timelineSummary) {
            persistedRemediationReusePolicy = resolvePersistedRemediationReusePolicy({
                events: timelineSummary.events as unknown as Record<string, unknown>[],
                taskId,
                reviewType,
                preflightPath,
                timelinePath: String(timelinePath)
            });
        }
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: timelineSummary?.events || [],
            taskModePath,
            runtimeReviewerIdentity
        });
    }
    const effectiveReviewReuseBlockedReason = reviewReuseBlockedReason
        || persistedRemediationReusePolicy.blockedReason;
    const effectiveRemediationPreservedScopeMismatchReason =
        String(options.remediationPreservedScopeMismatchReason || '').trim()
        || persistedRemediationReusePolicy.preservedScopeMismatchReason;
    let previousReviewContextReuseSha256: string | null = null;
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
        try {
            previousReviewContextReuseSha256 = computeReviewContextReuseHash(
                JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
            );
        } catch {
            previousReviewContextReuseSha256 = null;
        }
    }
    const currentPassReviewEvidence = taskId && !effectiveReviewReuseBlockedReason
        ? tryAcceptCurrentPassReviewEvidence({
            repoRoot,
            taskId,
            reviewType,
            preflightPath,
            preflightPayload,
            reviewContextPath: outputPath,
            timelineEventsSummary: timelineSummary
        })
        : null;
    if (currentPassReviewEvidence?.accepted) {
        await emitCurrentPassReviewContextReuseAccepted({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            currentPassReviewEvidence,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });
        return buildAcceptedCurrentPassReviewContextCommandResult({
            reviewType,
            reviewContextPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            tokenEconomyActive: currentPassReviewEvidence.tokenEconomyActive === true,
            reusedExistingReview: currentPassReviewEvidence.reusedExistingReview,
            receiptPath: currentPassReviewEvidence.receiptPath,
            reviewerExecutionMode: currentPassReviewEvidence.reviewerExecutionMode,
            reviewerIdentity: currentPassReviewEvidence.reviewerIdentity,
            reason: currentPassReviewEvidence.reason
        });
    }
    const result = buildReviewContext({
        reviewType,
        depth,
        preflightPath,
        preflightPayload,
        taskModePath: taskModePath || null,
        taskModeEvidence,
        runtimeReviewerIdentity,
        tokenEconomyConfigPath,
        tokenEconomyConfigData: options.tokenEconomyConfigData || null,
        scopedDiffMetadataPath,
        outputPath,
        repoRoot,
        focusedRequiredTestPath,
        ruleContextSectionsCache: options.ruleContextSectionsCache || null,
        ruleFileContentCache: options.ruleFileContentCache || null
    });
    let reviewReuseResult: ReviewReuseResult = {
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reason: 'reuse check not run'
    };

    if (taskId) {
        await emitGeneratedReviewContextPreparationTelemetry({
            repoRoot,
            taskId,
            reviewType,
            depth,
            preflightPath,
            outputPath: result.output_path,
            ruleContextArtifactPath: result.rule_context.artifact_path,
            selectedSkill: result.rule_context.selected_skill,
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });

        try {
            reviewReuseResult = effectiveReviewReuseBlockedReason
                ? {
                    reused: false,
                    receiptPath: null,
                    reviewerExecutionMode: null,
                    reviewerIdentity: null,
                    reason: effectiveReviewReuseBlockedReason
                }
                : await tryReuseReviewEvidence({
                    repoRoot,
                    taskId,
                    reviewType,
                    preflightPath,
                    preflightPayload,
                    reviewContextPath: outputPath,
                    previousReviewContextReuseSha256,
                    timelineEventsSummary: timelineSummary,
                    remediationPreservedScopeMismatchReason:
                        effectiveRemediationPreservedScopeMismatchReason || null
                });
        } catch (error: unknown) {
            reviewReuseResult = {
                reused: false,
                receiptPath: null,
                reviewerExecutionMode: null,
                reviewerIdentity: null,
                reason: `review reuse check failed: ${error instanceof Error ? error.message : String(error)}`
            };
        }
    }

    return buildGeneratedReviewContextCommandResult({
        reviewType,
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active,
        reviewReuseResult,
        currentPassReviewEvidenceAccepted: currentPassReviewEvidence?.accepted === true,
        currentPassReviewEvidenceReason:
            effectiveReviewReuseBlockedReason
            || currentPassReviewEvidence?.reason
            || 'current PASS reuse check not run'
    });
}
