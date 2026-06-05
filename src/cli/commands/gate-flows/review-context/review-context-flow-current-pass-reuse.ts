import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    normalizeReviewReceiptReviewerProvenance,
    normalizeReviewerExecutionMode,
    type ReviewReceipt
} from '../../../../gate-runtime/review-context';
import {
    type ReviewDependencyTimelineEvent
} from '../../../../gates/review/review-dependencies';
import {
    assertReviewTreeStateFresh
} from '../../../../gates/review/review-tree-state';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';
import {
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../../../../gates/review-reuse/review-reuse';
import {
    validateStrictReusedReviewEvidence
} from '../../../../gates/review-reuse/review-reuse-telemetry';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    readTimelineEventsSummary,
    type TimelineEventsSummaryResult
} from './review-context-command-binding';
import {
    getReviewTreeStateSha256FromContext,
    getRuleContextArtifactPathFromContext,
    getTokenEconomyActiveFromContext,
    isRecord,
    normalizeLowerText,
    normalizeOptionalPath,
    normalizeOptionalSha256,
    readJsonRecord
} from './review-context-flow-json';

export interface CurrentPassReviewEvidenceResult {
    accepted: boolean;
    reason: string;
    reviewContextPath: string;
    ruleContextArtifactPath: string | null;
    tokenEconomyActive: boolean | null;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reusedExistingReview: boolean;
}

export interface CompileEvidenceSummary {
    status: string | null;
    preflightPath: string | null;
    preflightHashSha256: string | null;
}

export function findLatestTimelineSequence(
    events: readonly ReviewDependencyTimelineEvent[],
    predicate: (entry: ReviewDependencyTimelineEvent) => boolean
): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        if (predicate(events[index])) {
            return events[index].sequence;
        }
    }
    return null;
}

export function readCompileEvidenceSummary(repoRoot: string, taskId: string): CompileEvidenceSummary {
    const compileEvidencePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-compile-gate.json`));
    if (!fs.existsSync(compileEvidencePath) || !fs.statSync(compileEvidencePath).isFile()) {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(compileEvidencePath, 'utf8')) as Record<string, unknown>;
        return {
            status: String(parsed.status || '').trim() || null,
            preflightPath: gateHelpers.normalizePath(parsed.preflight_path),
            preflightHashSha256: String(parsed.preflight_hash_sha256 || '').trim().toLowerCase() || null
        };
    } catch {
        return {
            status: null,
            preflightPath: null,
            preflightHashSha256: null
        };
    }
}

function getReviewPassVerdict(reviewType: string): string {
    const passVerdicts: Record<string, string> = {
        code: 'REVIEW PASSED',
        db: 'DB REVIEW PASSED',
        security: 'SECURITY REVIEW PASSED',
        refactor: 'REFACTOR REVIEW PASSED',
        api: 'API REVIEW PASSED',
        test: 'TEST REVIEW PASSED',
        performance: 'PERFORMANCE REVIEW PASSED',
        infra: 'INFRA REVIEW PASSED',
        dependency: 'DEPENDENCY REVIEW PASSED'
    };
    return passVerdicts[String(reviewType || '').trim().toLowerCase()]
        || `${String(reviewType || '').trim().toUpperCase()} REVIEW PASSED`;
}

function artifactHasPassVerdict(reviewType: string, artifactText: string): boolean {
    const tokenMatch = extractReviewVerdictSectionTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(reviewType, getReviewPassVerdict(reviewType))
    );
    return tokenMatch?.outcome === 'pass';
}

function findLatestCurrentCycleReviewRecordedEvent(options: {
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
    taskId: string;
    reviewType: string;
    receiptPath: string;
    receiptSha256: string | null;
    reviewContextPath: string;
    reviewContextSha256: string | null;
    reviewArtifactPath: string;
    reviewArtifactSha256: string | null;
    minSequenceExclusive?: number | null;
}): ReviewDependencyTimelineEvent | null {
    const normalizedReceiptPath = normalizeOptionalPath(options.receiptPath);
    const normalizedReviewContextPath = normalizeOptionalPath(options.reviewContextPath);
    const normalizedReviewArtifactPath = normalizeOptionalPath(options.reviewArtifactPath);
    for (let index = options.timelineEvents.length - 1; index >= 0; index -= 1) {
        const entry = options.timelineEvents[index];
        if (
            entry.sequence <= options.latestCompilePassSequence
            || (options.minSequenceExclusive != null && entry.sequence <= options.minSequenceExclusive)
            || entry.event_type !== 'REVIEW_RECORDED'
            || !entry.integrity
            || !isRecord(entry.details)
        ) {
            continue;
        }
        const details = entry.details;
        const detailsReviewType = normalizeLowerText(details.review_type ?? details.reviewType);
        const detailsTaskId = String(details.task_id ?? details.taskId ?? '').trim();
        if (
            detailsReviewType !== normalizeLowerText(options.reviewType)
            || (detailsTaskId && detailsTaskId !== options.taskId)
        ) {
            continue;
        }
        if (
            normalizeOptionalPath(details.receipt_path ?? details.receiptPath) !== normalizedReceiptPath
            || normalizeOptionalPath(details.review_context_path ?? details.reviewContextPath) !== normalizedReviewContextPath
            || normalizeOptionalPath(details.review_artifact_path ?? details.reviewArtifactPath) !== normalizedReviewArtifactPath
            || normalizeOptionalSha256(details.receipt_sha256 ?? details.receiptSha256) !== options.receiptSha256
            || normalizeOptionalSha256(details.review_context_sha256 ?? details.reviewContextSha256) !== options.reviewContextSha256
            || normalizeOptionalSha256(
                details.review_artifact_sha256
                ?? details.reviewArtifactSha256
                ?? details.review_artifact_snapshot_sha256
                ?? details.reviewArtifactSnapshotSha256
            ) !== options.reviewArtifactSha256
        ) {
            continue;
        }
        return entry;
    }
    return null;
}

function findMatchingInvocationAttestation(options: {
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
    taskId: string;
    reviewType: string;
    eventSha256: string;
    reviewContextSha256: string | null;
    reviewTreeStateSha256: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
}): ReviewDependencyTimelineEvent | null {
    for (const entry of options.timelineEvents) {
        if (
            entry.sequence <= options.latestCompilePassSequence
            || entry.event_type !== 'REVIEWER_INVOCATION_ATTESTED'
            || !entry.integrity
            || entry.integrity.event_sha256 !== options.eventSha256
            || !isRecord(entry.details)
        ) {
            continue;
        }
        const details = entry.details;
        if (
            String(details.task_id ?? details.taskId ?? '').trim() === options.taskId
            && normalizeLowerText(details.review_type ?? details.reviewType) === normalizeLowerText(options.reviewType)
            && normalizeOptionalSha256(details.review_context_sha256 ?? details.reviewContextSha256) === options.reviewContextSha256
            && normalizeOptionalSha256(details.review_tree_state_sha256 ?? details.reviewTreeStateSha256) === options.reviewTreeStateSha256
            && String(details.reviewer_execution_mode ?? details.reviewerExecutionMode ?? '').trim() === options.reviewerExecutionMode
            && String(details.reviewer_identity ?? details.reviewerIdentity ?? details.reviewer_session_id ?? '').trim() === options.reviewerIdentity
        ) {
            return entry;
        }
    }
    return null;
}

export function tryAcceptCurrentPassReviewEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
}): CurrentPassReviewEvidenceResult {
    const reject = (reason: string): CurrentPassReviewEvidenceResult => ({
        accepted: false,
        reason,
        reviewContextPath: gateHelpers.normalizePath(options.reviewContextPath),
        ruleContextArtifactPath: null,
        tokenEconomyActive: null,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reusedExistingReview: false
    });
    const currentPreflightHash = normalizeOptionalSha256(gateHelpers.fileSha256(options.preflightPath));
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return reject('current compile evidence is missing, failed, or bound to a different preflight artifact');
    }
    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = options.timelineEventsSummary?.events || readTimelineEventsSummary(timelinePath).events;
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return reject('task timeline has no compile pass before the current review cycle');
    }
    const reviewContext = readJsonRecord(options.reviewContextPath);
    if (!reviewContext) {
        return reject(`existing review context is missing or corrupt at ${gateHelpers.normalizePath(options.reviewContextPath)}`);
    }
    const reviewContextSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(options.reviewContextPath));
    const reviewTreeStateSha256 = getReviewTreeStateSha256FromContext(reviewContext);
    const ruleContextArtifactPath = getRuleContextArtifactPathFromContext(reviewContext);
    if (
        String(reviewContext.task_id || '').trim() !== options.taskId
        || normalizeLowerText(reviewContext.review_type) !== normalizeLowerText(options.reviewType)
        || gateHelpers.normalizePath(reviewContext.preflight_path).toLowerCase() !== normalizedPreflightPath.toLowerCase()
        || normalizeOptionalSha256(reviewContext.preflight_sha256) !== currentPreflightHash
    ) {
        return reject('existing review context is bound to a different task, review type, or preflight hash');
    }
    if (!reviewContextSha256 || !reviewTreeStateSha256) {
        return reject('existing review context is missing a verifiable context hash or review tree-state hash');
    }
    if (!ruleContextArtifactPath) {
        return reject('existing review context is missing the rule-context artifact path');
    }
    try {
        assertReviewTreeStateFresh({
            repoRoot: options.repoRoot,
            reviewContext,
            contextPath: options.reviewContextPath,
            gateName: 'build-review-context current PASS reuse'
        });
    } catch (exc: unknown) {
        return reject(exc instanceof Error ? exc.message : String(exc));
    }
    let promptBinding: ReturnType<typeof resolveReviewerPromptArtifactBinding>;
    try {
        promptBinding = resolveReviewerPromptArtifactBinding({
            repoRoot: options.repoRoot,
            reviewContext,
            contextPath: options.reviewContextPath,
            gateName: 'build-review-context current PASS reuse'
        });
    } catch (exc: unknown) {
        return reject(exc instanceof Error ? exc.message : String(exc));
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const receipt = readJsonRecord(receiptPath) as ReviewReceipt | null;
    if (!receipt) {
        return reject(`review receipt is missing or corrupt at ${gateHelpers.normalizePath(receiptPath)}`);
    }
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return reject(`review artifact is missing at ${gateHelpers.normalizePath(artifactPath)}`);
    }
    const artifactText = fs.readFileSync(artifactPath, 'utf8');
    const artifactSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(artifactPath));
    if (!artifactHasPassVerdict(options.reviewType, artifactText)) {
        return reject('review artifact does not contain an accepted PASS verdict token');
    }

    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (reviewScopeFingerprint.missing_review_relevant_files.length > 0) {
        return reject(`missing review-relevant scope file(s): ${reviewScopeFingerprint.missing_review_relevant_files.join(', ')}`);
    }
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(options.reviewType, options.preflightPayload, options.repoRoot);
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return reject(`missing non-test scope file(s): ${codeScopeFingerprint.missing_non_test_files.join(', ')}`);
    }
    const metrics = isRecord(options.preflightPayload.metrics) ? options.preflightPayload.metrics : {};
    const expectedScopeSha256 = normalizeOptionalSha256(metrics.scope_sha256 || metrics.changed_files_sha256);
    const expectedReviewScopeSha256 = normalizeOptionalSha256(reviewScopeFingerprint.review_scope_sha256);
    const expectedCodeScopeSha256 = isNonTestReviewScope(options.reviewType)
        ? normalizeOptionalSha256(codeScopeFingerprint.code_scope_sha256)
        : null;
    if (
        String(receipt.task_id || '').trim() !== options.taskId
        || normalizeLowerText(receipt.review_type) !== normalizeLowerText(options.reviewType)
        || String(receipt.trust_level || '').trim() !== 'INDEPENDENT_AUDITED'
        || normalizeOptionalSha256(receipt.preflight_sha256) !== currentPreflightHash
        || normalizeOptionalSha256(receipt.scope_sha256) !== expectedScopeSha256
        || normalizeOptionalSha256(receipt.review_scope_sha256) !== expectedReviewScopeSha256
        || normalizeOptionalSha256(receipt.review_context_sha256) !== reviewContextSha256
        || normalizeOptionalSha256(receipt.review_tree_state_sha256) !== reviewTreeStateSha256
        || normalizeOptionalSha256(receipt.review_artifact_sha256) !== artifactSha256
        || (isNonTestReviewScope(options.reviewType)
            && normalizeOptionalSha256(receipt.code_scope_sha256) !== expectedCodeScopeSha256)
    ) {
        return reject('review receipt bindings do not match the current preflight, scope, context, tree-state, or artifact hash');
    }

    const receiptSha256 = normalizeOptionalSha256(gateHelpers.fileSha256(receiptPath));
    const reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim() || null;
    if (!reviewerExecutionMode || !reviewerIdentity) {
        return reject('review receipt is missing a trusted reviewer execution mode or identity');
    }
    if (receipt.reused_existing_review === true) {
        const strictReuseValidation = validateStrictReusedReviewEvidence({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            events: timelineEvents,
            receiptPath,
            receiptSha256,
            reviewContextSha256,
            reviewContextReuseSha256: normalizeOptionalSha256(receipt.review_context_reuse_sha256),
            reviewTreeStateSha256,
            reviewScopeSha256: normalizeOptionalSha256(receipt.review_scope_sha256),
            codeScopeSha256: normalizeOptionalSha256(receipt.code_scope_sha256),
            reviewArtifactSha256: artifactSha256,
            reusedFromReceiptPath: typeof receipt.reused_from_receipt_path === 'string'
                ? receipt.reused_from_receipt_path
                : null,
            reusedFromReceiptSha256: normalizeOptionalSha256(receipt.reused_from_receipt_sha256),
            reusedFromReviewContextSha256: normalizeOptionalSha256(receipt.reused_from_review_context_sha256),
            reusedFromReviewContextReuseSha256: normalizeOptionalSha256(receipt.reused_from_review_context_reuse_sha256),
            reusedFromReviewTreeStateSha256: normalizeOptionalSha256(receipt.reused_from_review_tree_state_sha256),
            reusedFromReviewScopeSha256: normalizeOptionalSha256(receipt.reused_from_review_scope_sha256),
            reusedFromCodeScopeSha256: normalizeOptionalSha256(receipt.reused_from_code_scope_sha256),
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerProvenance: isRecord(receipt.reviewer_provenance)
                ? receipt.reviewer_provenance
                : null,
            latestCompileEventSequence: latestCompilePassSequence
        });
        if (!strictReuseValidation.valid) {
            return reject(
                'current-cycle reused PASS receipt is missing strict reused evidence telemetry: ' +
                strictReuseValidation.reason
            );
        }
    } else {
        const provenance = normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
        const invocationEvent = provenance?.controller_event_type === 'REVIEWER_INVOCATION_ATTESTED'
            ? findMatchingInvocationAttestation({
                timelineEvents,
                latestCompilePassSequence,
                taskId: options.taskId,
                reviewType: options.reviewType,
                eventSha256: provenance.event_sha256,
                reviewContextSha256,
                reviewTreeStateSha256,
                reviewerExecutionMode,
                reviewerIdentity
            })
            : null;
        if (
            !provenance
            || provenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
            || !invocationEvent
        ) {
            return reject('fresh PASS receipt is missing matching current-cycle reviewer invocation attestation');
        }
        const currentReviewRecorded = findLatestCurrentCycleReviewRecordedEvent({
            timelineEvents,
            latestCompilePassSequence,
            taskId: options.taskId,
            reviewType: options.reviewType,
            receiptPath,
            receiptSha256,
            reviewContextPath: options.reviewContextPath,
            reviewContextSha256,
            reviewArtifactPath: artifactPath,
            reviewArtifactSha256: artifactSha256,
            minSequenceExclusive: invocationEvent.sequence
        });
        if (!currentReviewRecorded) {
            return reject(
                'trusted current-cycle REVIEW_RECORDED telemetry is missing matching receipt/context/artifact bindings after reviewer invocation'
            );
        }
        if (
            currentReviewRecorded.integrity?.task_sequence == null
            || currentReviewRecorded.integrity.task_sequence <= (invocationEvent.integrity?.task_sequence || 0)
        ) {
            return reject('trusted current-cycle REVIEW_RECORDED telemetry must occur after reviewer invocation attestation');
        }
    }

    return {
        accepted: true,
        reason: 'accepted: existing current-cycle independent PASS review evidence matches current preflight, scope, tree-state, context, receipt, artifact, and launch bindings; review context rebuild skipped',
        reviewContextPath: gateHelpers.normalizePath(options.reviewContextPath),
        ruleContextArtifactPath: gateHelpers.normalizePath(promptBinding.promptPath),
        tokenEconomyActive: getTokenEconomyActiveFromContext(reviewContext),
        receiptPath: gateHelpers.normalizePath(receiptPath),
        reviewerExecutionMode,
        reviewerIdentity,
        reusedExistingReview: receipt.reused_existing_review === true
    };
}
