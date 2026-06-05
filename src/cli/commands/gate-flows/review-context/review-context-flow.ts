import * as fs from 'node:fs';

import {
    buildReviewContext
} from '../../../../gates/review-context/build-review-context';
import { assertReviewLifecycleGuardFromEntries } from '../../../../gates/review/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../../gates/review/review-dependencies';
import {
    computeReviewContextReuseHash
} from '../../../../gates/review-reuse/review-reuse';
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
        reviewReuseBlockedReason
    } = resolveBuildReviewContextCommandInputs(options);
    if (taskId) {
        assertReviewLifecycleGuardFromEntries(
            String(timelinePath),
            timelineSummary?.events || [],
            timelineSummary?.hasInvalidLines === true,
            'build-review-context',
            'review_phase'
        );
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
    const currentPassReviewEvidence = taskId && !reviewReuseBlockedReason
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
            telemetryLockTimeoutMs: options.telemetryLockTimeoutMs,
            telemetryLockRetryMs: options.telemetryLockRetryMs
        });

        try {
            reviewReuseResult = reviewReuseBlockedReason
                ? {
                    reused: false,
                    receiptPath: null,
                    reviewerExecutionMode: null,
                    reviewerIdentity: null,
                    reason: reviewReuseBlockedReason
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
                    remediationPreservedScopeMismatchReason: String(options.remediationPreservedScopeMismatchReason || '').trim() || null
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
        currentPassReviewEvidenceReason: reviewReuseBlockedReason || currentPassReviewEvidence?.reason || 'current PASS reuse check not run'
    });
}
