import { createHash } from 'node:crypto';
import {
    buildReviewReceipt,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt
} from '../gate-runtime/review-context';
import {
    writeReviewArtifactsWithRollback
} from '../gate-runtime/review-artifacts';
import {
    emitReviewRecordedEventAsync
} from '../gate-runtime/lifecycle-events';
import { taskEventAppendHasBlockingFailure } from '../gate-runtime/task-events';
import * as gateHelpers from './helpers';
import {
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint
} from './review-reuse';
import type { HistoricalReviewReuseCandidate } from './review-reuse-validation';

export interface MaterializeReusedReviewEvidenceOptions {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    artifactPath: string;
    receiptPath: string;
    nonTestReviewScope: boolean;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    reviewScopeFingerprint: ReturnType<typeof computeReviewRelevantScopeFingerprint>;
    currentPreflightHash: string | null;
    currentReviewContextSha256: string | null;
    currentReviewTreeStateSha256: string | null;
    currentContextReuseSha256: string | null;
    candidate: HistoricalReviewReuseCandidate;
    reusedFromReceiptPath: string | null;
    reusedFromReceiptSha256: string | null;
    receipt: ReviewReceipt;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    historicalReviewerProvenance: NonNullable<ReturnType<typeof normalizeReviewReceiptReviewerProvenance>>;
    expectedContextSha256: string | null;
    expectedContextReuseSha256: string | null;
    expectedReviewTreeStateSha256: string | null;
    expectedReviewScopeSha256: string | null;
    expectedCodeScopeSha256: string | null;
    historicalReviewArtifactSha256: string;
    artifactText: string;
}

export async function materializeReusedReviewEvidence(
    options: MaterializeReusedReviewEvidenceOptions
): Promise<{ materialized: boolean; reason: string | null }> {
    const refreshedReceipt = buildReusedReviewReceipt(options);
    const receiptPayloadSha256 = createHash('sha256')
        .update(`${JSON.stringify(refreshedReceipt, null, 2)}\n`)
        .digest('hex');
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(
        /\.md$/,
        `-artifact-${options.historicalReviewArtifactSha256}.md`
    );
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');

    try {
        await writeReviewArtifactsWithRollback([
            {
                artifactPath: options.artifactPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: artifactSnapshotPath,
                contentType: 'text',
                content: options.artifactText
            },
            {
                artifactPath: options.receiptPath,
                contentType: 'json',
                payload: refreshedReceipt
            },
            {
                artifactPath: receiptSnapshotPath,
                contentType: 'json',
                payload: refreshedReceipt
            }
        ], async () => {
            const recordedEvent = await emitReviewRecordedEventAsync(
                orchestratorRoot,
                options.taskId,
                options.reviewType,
                buildReuseRecordedEventDetails({
                    options,
                    refreshedReceipt,
                    receiptPayloadSha256,
                    receiptSnapshotPath,
                    artifactSnapshotPath
                })
            );
            if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
                throw new Error('REVIEW_RECORDED telemetry could not be persisted for review reuse.');
            }
        });
        return { materialized: true, reason: null };
    } catch {
        return {
            materialized: false,
            reason: 'current-cycle REVIEW_RECORDED reuse telemetry could not be persisted'
        };
    }
}

function buildReusedReviewReceipt(options: MaterializeReusedReviewEvidenceOptions): ReviewReceipt {
    return buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256: options.currentPreflightHash,
        scopeSha256: String(
            (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.scope_sha256
            || (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
            || ''
        ).trim() || null,
        reviewScopeSha256: String(options.reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null,
        codeScopeSha256: options.nonTestReviewScope
            ? String(options.codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
            : null,
        reviewContextSha256: options.currentReviewContextSha256,
        reviewTreeStateSha256: options.currentReviewTreeStateSha256,
        reviewContextReuseSha256: options.currentContextReuseSha256,
        reviewArtifactSha256: options.historicalReviewArtifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.receipt.reviewer_fallback_reason ?? null,
        reviewerProvenance: options.historicalReviewerProvenance,
        trustLevel: 'INDEPENDENT_AUDITED',
        reusedExistingReview: true,
        reusedFromReceiptPath: options.reusedFromReceiptPath,
        reusedFromReceiptSha256: options.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: options.expectedContextSha256,
        reusedFromReviewContextReuseSha256: options.expectedContextReuseSha256,
        reusedFromReviewTreeStateSha256: options.expectedReviewTreeStateSha256,
        reusedFromReviewScopeSha256: options.expectedReviewScopeSha256,
        reusedFromCodeScopeSha256: options.expectedCodeScopeSha256
    });
}

function buildReuseRecordedEventDetails(input: {
    options: MaterializeReusedReviewEvidenceOptions;
    refreshedReceipt: ReviewReceipt;
    receiptPayloadSha256: string;
    receiptSnapshotPath: string;
    artifactSnapshotPath: string;
}): Record<string, unknown> {
    return {
        ...input.refreshedReceipt,
        reused_existing_review: true,
        reuse_event_type: 'REVIEW_EVIDENCE_REUSED',
        reused_from_receipt_path: input.options.reusedFromReceiptPath,
        reused_from_receipt_sha256: input.options.reusedFromReceiptSha256,
        reused_from_review_context_sha256: input.options.expectedContextSha256,
        reused_from_review_context_reuse_sha256: input.options.expectedContextReuseSha256,
        reused_from_review_tree_state_sha256: input.options.expectedReviewTreeStateSha256,
        reused_from_review_scope_sha256: input.options.expectedReviewScopeSha256,
        reused_from_code_scope_sha256: input.options.expectedCodeScopeSha256,
        receipt_path: gateHelpers.normalizePath(input.options.receiptPath),
        receipt_sha256: input.receiptPayloadSha256,
        receipt_snapshot_path: gateHelpers.normalizePath(input.receiptSnapshotPath),
        receipt_snapshot_sha256: input.receiptPayloadSha256,
        review_artifact_path: gateHelpers.normalizePath(input.options.artifactPath),
        review_artifact_snapshot_path: gateHelpers.normalizePath(input.artifactSnapshotPath),
        review_artifact_snapshot_sha256: input.options.historicalReviewArtifactSha256,
        review_context_path: gateHelpers.normalizePath(input.options.reviewContextPath),
        review_context_sha256: input.options.currentReviewContextSha256
    };
}
