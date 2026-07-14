import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens
} from '../../../../gate-runtime/review-context';
import { fileSha256 } from '../../../../gate-runtime/hash';
import {
    emitReviewRecordedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import {
    REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION
} from '../../../../gate-runtime/reviewer-session-contract';
import {
    buildPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    isPlannedReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    writeReviewArtifactsWithRollback
} from '../../../../gate-runtime/review-artifacts';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../../gate-runtime/task-events';
import {
    buildDomainScopeFingerprints
} from '../../../../gates/scope/domain-scope-fingerprints';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    assertRequiredUpstreamReviewDependencies,
} from '../../../../gates/review/review-dependencies';
import {
    REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL
} from '../../../../gates/review/review-evidence-contract';
import {
    computeReviewContextReuseHash,
    computeReviewRelevantScopeFingerprint,
    computeReviewReuseCodeScopeFingerprint,
    isNonTestReviewScope
} from '../../../../gates/review-reuse/review-reuse';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';
import { REVIEW_CONTRACTS } from '../../../../gates/required-reviews/required-reviews-check';
import {
    cleanupReviewTempSourceArtifact
} from '../../gates/gates-artifacts';
import {
    normalizePathValue,
    parseOptions
} from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import {
    type ReviewResultHandlers,
    type ReviewResultHandlersDependencies,
    type ReviewerExecutionMode,
    recordReviewReceiptOptionDefinitions,
    recordReviewResultOptionDefinitions
} from './review-result-handler-contract';
import {
    appendSafeReviewOutputRetryInstruction,
    assertReviewOutputNotOlderThanDelegation,
    assertReviewTreeStateFreshOrHistoricalFailure,
    buildSafeReviewOutputRetryInstruction,
    getDelegationStartedAtUtc,
    isFailedReviewVerdictToken,
    sha256ReviewArtifactContent
} from './review-result-output-safety';
import {
    materializeReviewContent
} from './review-artifact-materialization';
import {
    readDependencyTimelineEvents
} from './review-dependency-timeline';
import {
    resolveReviewOutputInput
} from './review-output-input';
import {
    assertReviewReceiptRoutingMatchesContext
} from './review-receipt-validation';
import { assertReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import {
    resolveReviewCoverageEvidenceSnapshotCommit,
    type ReviewCoverageContract,
    type ReviewCoverageValidationSummary
} from '../../../../gates/review/review-coverage-ledger';
import {
    type ReviewFindingsReport
} from '../../../../gates/review/review-findings-schema';
import {
    reviewContextRequiresFindingsOnlyArtifact,
    validateReviewFindingsContract,
    type JsonReviewFindingsArtifactValidation
} from '../../../../gates/review/review-findings-artifact-verdict';
import {
    buildReviewFindingsValidationArtifact,
    getReviewFindingsValidationArtifactPath,
    getReviewFindingsValidationArtifactSnapshotPath,
    type ReviewFindingsValidationArtifact
} from '../../../../gates/review/review-findings-validation-artifact';

function sha256JsonPayload(value: unknown): string {
    return createHash('sha256')
        .update(`${JSON.stringify(value, null, 2)}\n`)
        .digest('hex');
}

function summarizeReviewFindingsReport(report: ReviewFindingsReport): Record<string, unknown> {
    const findingIdsBySeverity = {
        critical: report.findings.critical.map((finding) => finding.id),
        high: report.findings.high.map((finding) => finding.id),
        medium: report.findings.medium.map((finding) => finding.id),
        low: report.findings.low.map((finding) => finding.id)
    };
    return {
        schema_version: 1,
        validation_note_ids: report.validation_notes.map((note) => note.id),
        coverage_obligation_ids: report.coverage_ledger.entries.map((entry) => entry.obligation_id),
        finding_ids_by_severity: findingIdsBySeverity,
        active_finding_count: Object.values(findingIdsBySeverity)
            .reduce((total, ids) => total + ids.length, 0),
        residual_risk_ids: report.residual_risks.map((risk) => risk.id),
        residual_risk_count: report.residual_risks.length
    };
}

function buildBoundedReviewRecordedTelemetryDetails(receipt: Record<string, unknown>): Record<string, unknown> {
    const telemetryDetails = { ...receipt };
    if (Object.prototype.hasOwnProperty.call(telemetryDetails, 'review_findings_report')) {
        delete telemetryDetails.review_findings_report;
        telemetryDetails.review_findings_report_telemetry_policy = 'omitted_full_payload_receipt_only';
    }
    return telemetryDetails;
}

interface ReviewFindingsValidationEvidence {
    artifactPath: string;
    snapshotPath: string;
    artifactSha256: string;
    payload: ReviewFindingsValidationArtifact;
}

function getPreflightScopeSha256(preflight: Record<string, unknown>): string | null {
    const metrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    return String(metrics?.scope_sha256 || metrics?.changed_files_sha256 || '').trim() || null;
}

function buildReviewFindingsValidationEvidence(options: {
    taskId: string;
    reviewType: string;
    validation: JsonReviewFindingsArtifactValidation;
    reviewOutputSha256?: string | null;
    reviewArtifactPath: string;
    reviewArtifactSha256?: string | null;
    reviewContextPath: string;
    reviewContextSha256?: string | null;
    preflightPath: string;
    preflightSha256?: string | null;
    scopeSha256?: string | null;
    reviewScopeSha256?: string | null;
    codeScopeSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    coverageContract?: ReviewCoverageContract | null;
}): ReviewFindingsValidationEvidence {
    const artifactPath = getReviewFindingsValidationArtifactPath(options.reviewArtifactPath);
    const payload = buildReviewFindingsValidationArtifact({
        taskId: options.taskId,
        reviewType: options.reviewType,
        validation: options.validation,
        reviewOutputSha256: options.reviewOutputSha256 || null,
        reviewArtifactPath: options.reviewArtifactPath,
        reviewArtifactSha256: options.reviewArtifactSha256 || null,
        reviewContextPath: options.reviewContextPath,
        reviewContextSha256: options.reviewContextSha256 || null,
        preflightPath: options.preflightPath,
        preflightSha256: options.preflightSha256 || null,
        scopeSha256: options.scopeSha256 || null,
        reviewScopeSha256: options.reviewScopeSha256 || null,
        codeScopeSha256: options.codeScopeSha256 || null,
        reviewTreeStateSha256: options.reviewTreeStateSha256 || null,
        coverageContract: options.coverageContract || null
    });
    const artifactSha256 = sha256JsonPayload(payload);
    return {
        artifactPath,
        snapshotPath: getReviewFindingsValidationArtifactSnapshotPath(artifactPath, artifactSha256),
        artifactSha256,
        payload
    };
}

async function writeRejectedReviewFindingsValidationEvidence(evidence: ReviewFindingsValidationEvidence): Promise<void> {
    await writeReviewArtifactsWithRollback([
        {
            artifactPath: evidence.artifactPath,
            contentType: 'json',
            payload: evidence.payload
        },
        {
            artifactPath: evidence.snapshotPath,
            contentType: 'json',
            payload: evidence.payload
        }
    ], async () => undefined);
}

function summarizeReviewFindingsValidationEvidence(evidence: ReviewFindingsValidationEvidence): Record<string, unknown> {
    return {
        artifact_path: normalizePath(evidence.artifactPath),
        artifact_sha256: evidence.artifactSha256,
        snapshot_path: normalizePath(evidence.snapshotPath),
        snapshot_sha256: evidence.artifactSha256,
        status: evidence.payload.validation_result.status,
        accepted: evidence.payload.validation_result.accepted,
        validation_result_sha256: evidence.payload.validation_result_sha256,
        violation_count: evidence.payload.validation_result.violations.length
    };
}

async function writeReviewReceiptSnapshotsAndTelemetry(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    artifactPath: string;
    artifactContent?: string | null;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSourcePath?: string | null;
    rawReviewOutputContent?: string | null;
    receipt: Record<string, unknown>;
    receiptPayloadSha256: string;
    artifactSha256: string | null;
    findingsValidationEvidence?: ReviewFindingsValidationEvidence | null;
}): Promise<string> {
    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    const receiptSnapshotPath = options.artifactPath.replace(/\.md$/, `-receipt-${options.receiptPayloadSha256}.json`);
    const artifactSnapshotPath = options.artifactPath.replace(/\.md$/, `-artifact-${options.artifactSha256}.md`);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    const artifactContent = options.artifactContent ?? fs.readFileSync(options.artifactPath, 'utf8');
    const writes = [
        ...(options.rawReviewOutputPath && options.rawReviewOutputContent != null
            ? [{
                artifactPath: options.rawReviewOutputPath,
                contentType: 'text' as const,
                content: options.rawReviewOutputContent
            }]
            : []),
        ...(options.artifactContent != null
            ? [{
                artifactPath: options.artifactPath,
                contentType: 'text' as const,
                content: options.artifactContent
            }]
            : []),
        {
            artifactPath: receiptPath,
            contentType: 'json' as const,
            payload: options.receipt
        },
        {
            artifactPath: receiptSnapshotPath,
            contentType: 'json' as const,
            payload: options.receipt
        },
        ...(options.findingsValidationEvidence
            ? [
                {
                    artifactPath: options.findingsValidationEvidence.artifactPath,
                    contentType: 'json' as const,
                    payload: options.findingsValidationEvidence.payload
                },
                {
                    artifactPath: options.findingsValidationEvidence.snapshotPath,
                    contentType: 'json' as const,
                    payload: options.findingsValidationEvidence.payload
                }
            ]
            : []),
        {
            artifactPath: artifactSnapshotPath,
            contentType: 'text' as const,
            content: artifactContent
        }
    ];
    await writeReviewArtifactsWithRollback(writes, async () => {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...buildBoundedReviewRecordedTelemetryDetails(options.receipt),
            receipt_path: normalizePath(receiptPath),
            receipt_sha256: options.receiptPayloadSha256,
            receipt_snapshot_path: normalizePath(receiptSnapshotPath),
            receipt_snapshot_sha256: options.receiptPayloadSha256,
            review_artifact_path: normalizePath(options.artifactPath),
            review_artifact_snapshot_path: normalizePath(artifactSnapshotPath),
            review_artifact_snapshot_sha256: options.artifactSha256,
            review_context_path: normalizePath(options.contextPath)
        });
        if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    });
    return receiptPath;
}

async function recordReviewReceiptFromArtifacts(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    artifactPath: string;
    reviewArtifactContent?: string | null;
    contextPath: string;
    rawReviewOutputPath?: string | null;
    rawReviewOutputSourcePath?: string | null;
    rawReviewOutputContent?: string | null;
    rawReviewOutputSha256?: string | null;
    rawReviewOutputSourceMtimeUtc?: string | null;
    reviewMaterializationFidelity?: string | null;
    historicalStaleReviewResultReason?: string | null;
    taskModePath?: string | null;
    reviewerExecutionMode: ReviewerExecutionMode;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    requireStrictBindingMetadata?: boolean;
    invocationReviewContextSha256?: string | null;
    routingReviewerIdentity?: string | null;
}, dependencies: ReviewResultHandlersDependencies): Promise<string> {
    if (
        options.reviewArtifactContent == null
        && (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile())
    ) {
        throw new Error(`Review artifact not found: ${options.artifactPath}`);
    }

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(options.preflightPath);
    const artifactSha256 = options.reviewArtifactContent == null
        ? fileSha256(options.artifactPath)
        : sha256ReviewArtifactContent(options.reviewArtifactContent);
    const parsedReviewContext = JSON.parse(fs.readFileSync(options.contextPath, 'utf8')) as Record<string, unknown>;
    dependencies.assertReviewContextContractOrThrow({
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        preflightPath: options.preflightPath,
        preflightSha256,
        preflightPayload: preflight,
        requireStrictBindingMetadata: options.requireStrictBindingMetadata,
        repoRoot: options.repoRoot
    });
    const reviewArtifactContent = options.reviewArtifactContent
        ?? fs.readFileSync(options.artifactPath, 'utf8');
    const historicalStaleReviewResultReason = options.historicalStaleReviewResultReason || null;
    assertReviewTreeStateFreshOrHistoricalFailure({
        repoRoot: options.repoRoot,
        reviewContext: parsedReviewContext,
        contextPath: options.contextPath,
        gateName: 'record-review-receipt',
        allowHistoricalFailedReviewResult: Boolean(historicalStaleReviewResultReason)
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot: options.repoRoot,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-receipt'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = dependencies.assertExplicitReviewContextRuntimeIdentity({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    dependencies.assertRoutingCompatibility({
        reviewType: options.reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerFallbackReason: options.reviewerFallbackReason
    });
    assertReviewReceiptRoutingMatchesContext({
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        currentRouting,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason
    });

    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    const explicitRoutingReviewerIdentity = String(options.routingReviewerIdentity || '').trim();
    const routingReviewerIdentity = explicitRoutingReviewerIdentity
        || (isPlannedReviewerIdentity(currentReviewerSessionId)
            ? currentReviewerSessionId
            : options.reviewerIdentity);
    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = dependencies.findMatchingRoutingEvent(
        timelineEvents,
        options.reviewType,
        options.reviewerExecutionMode,
        routingReviewerIdentity,
        options.reviewerFallbackReason
    ) || (
        explicitRoutingReviewerIdentity && explicitRoutingReviewerIdentity !== options.reviewerIdentity
            ? null
            : isResolvedReviewerIdentity(options.reviewerIdentity)
                ? dependencies.findMatchingRoutingEvent(
                    timelineEvents,
                    options.reviewType,
                    options.reviewerExecutionMode,
                    buildPlannedReviewerIdentity(options.taskId, options.reviewType),
                    options.reviewerFallbackReason
                )
                : null
    );
    if (!routingEvent) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${options.reviewType}' ` +
            'in the current cycle ' +
            `with reviewer '${routingReviewerIdentity}' and execution mode '${options.reviewerExecutionMode}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Review receipts require controller-attested reviewer_provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Matching routing telemetry is missing event integrity.'
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    if (!contextSha256) {
        throw new Error(`Review receipts require a hashable review-context artifact: ${normalizePath(options.contextPath)}.`);
    }
    const invocationReviewContextSha256 = String(options.invocationReviewContextSha256 || '').trim().toLowerCase()
        || contextSha256;
    const reviewTreeStateSha256 = dependencies.getReviewTreeStateSha256(parsedReviewContext) || null;
    const invocationEvent = dependencies.findMatchingReviewerInvocationAttestationEvent(timelineEvents, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: invocationReviewContextSha256,
        reviewTreeStateSha256,
        routingEventSha256: routingEventProvenance.event_sha256
    }) || (
        isResolvedReviewerIdentity(options.reviewerIdentity)
            ? [...timelineEvents].reverse().find((entry) => {
                const details = entry.details;
                const detailsReviewContextSha256 = String(details?.review_context_sha256 || details?.reviewContextSha256 || '')
                    .trim()
                    .toLowerCase();
                return entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                    && String(details?.task_id || details?.taskId || '').trim() === options.taskId
                    && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === options.reviewType
                    && String(details?.reviewer_execution_mode || details?.reviewerExecutionMode || '').trim() === options.reviewerExecutionMode
                    && String(details?.reviewer_identity || details?.reviewer_session_id || '').trim() === options.reviewerIdentity
                    && detailsReviewContextSha256 === invocationReviewContextSha256
                    && String(details?.routing_event_sha256 || details?.routingEventSha256 || '').trim().toLowerCase() === routingEventProvenance.event_sha256
                    && (!reviewTreeStateSha256 || String(details?.review_tree_state_sha256 || details?.reviewTreeStateSha256 || '').trim().toLowerCase() === reviewTreeStateSha256)
                    && entry.integrity;
            }) || null
            : null
    );
    const reviewerProvenance = buildReviewReceiptReviewerInvocationProvenance(
        invocationEvent?.event_type || '',
        invocationEvent?.integrity,
        invocationEvent?.details
    );
    if (options.reviewerExecutionMode === 'delegated_subagent' && !reviewerProvenance) {
        throw new Error(
            `Review receipts require REVIEWER_INVOCATION_ATTESTED launch provenance for delegated_subagent '${options.reviewType}' reviews. ` +
            'Run the real delegated reviewer launch path before recording reviewer output; local routing telemetry alone is not enough.'
        );
    }
    assertReviewOutputNotOlderThanDelegation({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        repoRoot: options.repoRoot,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewOutputSourcePath: options.rawReviewOutputSourcePath ?? options.rawReviewOutputPath ?? null,
        reviewOutputSourceMtimeUtc: options.rawReviewOutputSourceMtimeUtc,
        delegationStartedAtUtc: getDelegationStartedAtUtc(reviewerProvenance)
    });
    const strictFindingsOnlyOutput = reviewContextRequiresFindingsOnlyArtifact(parsedReviewContext);
    let findingsReport: ReviewFindingsReport | null = null;
    let coverageValidation: ReviewCoverageValidationSummary | null = null;
    let findingsValidationEvidence: ReviewFindingsValidationEvidence | null = null;
    let findingsValidation: JsonReviewFindingsArtifactValidation | null = null;
    if (String(reviewArtifactContent || '').trim().startsWith('{')) {
        findingsValidation = validateFindingsOnlyReviewOutput({
            reviewContent: reviewArtifactContent,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewContextSha256: contextSha256,
            reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined,
            repoRoot: options.repoRoot,
            evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflight)
        });
        findingsReport = findingsValidation.report;
        coverageValidation = findingsValidation.coverage_validation;
    } else if (strictFindingsOnlyOutput) {
        throw new Error(
            `Current '${options.reviewType}' review receipts require a verdict-free findings JSON report. ` +
            'Legacy PASS/FAIL verdict-token artifacts are readable history only and cannot satisfy a new review cycle.'
        );
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, options.repoRoot);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflight,
        options.repoRoot
    );
    const scopeSha256 = getPreflightScopeSha256(preflight);
    if (findingsValidation) {
        findingsValidationEvidence = buildReviewFindingsValidationEvidence({
            taskId: options.taskId,
            reviewType: options.reviewType,
            validation: findingsValidation,
            reviewOutputSha256: options.rawReviewOutputSha256 || null,
            reviewArtifactPath: options.artifactPath,
            reviewArtifactSha256: artifactSha256,
            reviewContextPath: options.contextPath,
            reviewContextSha256: contextSha256,
            preflightPath: options.preflightPath,
            preflightSha256,
            scopeSha256,
            reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
            codeScopeSha256: isNonTestReviewScope(options.reviewType)
                ? codeScopeFingerprint.code_scope_sha256
                : null,
            reviewTreeStateSha256,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined
        });
    }
    if (findingsValidation && (!findingsValidation.detected || !findingsValidation.valid || !findingsValidation.report)) {
        if (findingsValidationEvidence) {
            await writeRejectedReviewFindingsValidationEvidence(findingsValidationEvidence);
        }
        const validationMessage = findingsValidation.detected
            ? findingsValidation.violations.join(' ')
            : 'review output must be a JSON object.';
        throw new Error(
            `Verdict-free findings JSON report is invalid for '${options.reviewType}': ` +
            validationMessage
        );
    }
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256,
        reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
        codeScopeSha256: isNonTestReviewScope(options.reviewType)
            ? codeScopeFingerprint.code_scope_sha256
            : null,
        domainScopeFingerprints: buildDomainScopeFingerprints({
            repoRoot: options.repoRoot,
            detectionSource: String(preflight.detection_source || 'git_auto'),
            includeUntracked: preflight.include_untracked !== false,
            changedFiles: Array.isArray(preflight.changed_files) ? preflight.changed_files as string[] : []
        }),
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        reviewerProvenance,
        trustLevel: REVIEW_EVIDENCE_REQUIRED_TRUST_LEVEL
    });
    (receipt as unknown as Record<string, unknown>).review_result_recorded_at_utc =
        (receipt as unknown as Record<string, unknown>).recorded_at_utc ?? new Date().toISOString();
    (receipt as unknown as Record<string, unknown>).review_output_path = options.rawReviewOutputPath
        ? normalizePath(options.rawReviewOutputPath)
        : null;
    (receipt as unknown as Record<string, unknown>).review_output_sha256 = options.rawReviewOutputSha256 || null;
    (receipt as unknown as Record<string, unknown>).review_output_source_mtime_utc =
        options.rawReviewOutputSourceMtimeUtc || null;
    (receipt as unknown as Record<string, unknown>).review_materialization_fidelity = options.reviewMaterializationFidelity || 'exact';
    (receipt as unknown as Record<string, unknown>).review_coverage = coverageValidation;
    if (historicalStaleReviewResultReason) {
        (receipt as unknown as Record<string, unknown>).historical_stale_review_result = true;
        (receipt as unknown as Record<string, unknown>).review_result_scope = 'historical_stale_after_remediation';
        (receipt as unknown as Record<string, unknown>).historical_stale_review_reason = historicalStaleReviewResultReason;
    }
    if (findingsReport) {
        const findingsReportSha256 = sha256JsonPayload(findingsReport);
        const receiptRecord = receipt as unknown as Record<string, unknown>;
        receiptRecord.review_output_format = 'findings_json';
        receiptRecord.review_output_schema_version = findingsReport.schema_version;
        receiptRecord.review_findings_report_sha256 = findingsReportSha256;
        receiptRecord.review_findings_report = findingsReport;
        receiptRecord.review_findings_summary = summarizeReviewFindingsReport(findingsReport);
        if (findingsValidationEvidence) {
            receiptRecord.review_findings_validation = summarizeReviewFindingsValidationEvidence(findingsValidationEvidence);
        }
        receiptRecord.review_output_contract = {
            schema_version: 1,
            format: 'findings_json',
            report_sha256: findingsReportSha256,
            validation_artifact_sha256: findingsValidationEvidence?.artifactSha256 || null,
            validation_result_sha256: findingsValidationEvidence?.payload.validation_result_sha256 || null,
            raw_output_sha256: options.rawReviewOutputSha256 || null,
            review_artifact_sha256: artifactSha256,
            review_context_sha256: contextSha256,
            review_tree_state_sha256: reviewTreeStateSha256,
            coverage_contract_sha256: findingsReport.coverage_ledger.coverage_contract_sha256,
            reviewer_identity: options.reviewerIdentity,
            reviewer_provenance_event_sha256: reviewerProvenance?.event_sha256 ?? null
        };
    }

    const receiptPayloadSha256 = createHash('sha256')
        .update(`${JSON.stringify(receipt, null, 2)}\n`)
        .digest('hex');
    return writeReviewReceiptSnapshotsAndTelemetry({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactPath: options.artifactPath,
        artifactContent: options.reviewArtifactContent,
        contextPath: options.contextPath,
        rawReviewOutputPath: options.rawReviewOutputPath,
        rawReviewOutputContent: options.rawReviewOutputContent,
        receipt: receipt as unknown as Record<string, unknown>,
        receiptPayloadSha256,
        artifactSha256,
        findingsValidationEvidence
    });
}

function validateFindingsOnlyReviewOutput(options: {
    reviewContent: string;
    taskId: string;
    reviewType: string;
    reviewContextSha256: string;
    reviewTreeStateSha256: string | null;
    coverageContract: ReviewCoverageContract | null | undefined;
    repoRoot: string;
    evidenceSnapshotCommit?: string | null;
}): JsonReviewFindingsArtifactValidation {
    const validation = validateReviewFindingsContract({
        content: options.reviewContent,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedReviewContextSha256: options.reviewContextSha256,
        expectedTreeStateSha256: options.reviewTreeStateSha256,
        coverageContract: options.coverageContract,
        repoRoot: options.repoRoot,
        evidenceSnapshotCommit: options.evidenceSnapshotCommit
    });
    return validation;
}

function hasActiveFindings(report: ReviewFindingsReport): boolean {
    return report.findings.critical.length > 0
        || report.findings.high.length > 0
        || report.findings.medium.length > 0
        || report.findings.low.length > 0
        || report.residual_risks.length > 0;
}

async function handleRecordReviewResultWithDependencies(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewResultOptionDefinitions(), { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-result', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = dependencies.resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const reviewOutput = await resolveReviewOutputInput(
        options,
        repoRoot,
        path.dirname(preflightPath),
        taskId,
        reviewType,
        dependencies.readReviewOutputFromStdin
    );
    let reviewContent = reviewOutput.reviewContent;
    let reviewMaterializationFidelity = 'exact';
    const expectedPassVerdict = REVIEW_CONTRACTS.find(([candidate]) => candidate === reviewType)?.[1] || null;
    if (!expectedPassVerdict) {
        throw new Error(`Unsupported review type '${reviewType}' for record-review-result.`);
    }
    const expectedFailVerdict = expectedPassVerdict.replace(/\bPASSED\b/, 'FAILED');
    const verdictTokenSet = buildReviewVerdictTokenSet(reviewType, expectedPassVerdict, expectedFailVerdict);
    const detectedLegacyVerdictToken = extractReviewVerdictToken(
        reviewContent,
        expectedPassVerdict,
        expectedFailVerdict,
        reviewType
    );
    let verdictToken = detectedLegacyVerdictToken;
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = dependencies.parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    dependencies.assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath,
        repoRoot
    });
    const reviewContextSha256 = fileSha256(contextPath) || '';
    const strictFindingsOnlyOutput = reviewContextRequiresFindingsOnlyArtifact(parsedReviewContext);
    let findingsReport: ReviewFindingsReport | null = null;
    const rawReviewOutputSha256 = sha256ReviewArtifactContent(reviewOutput.reviewContent);
    const reviewContentLooksLikeFindingsJson = String(reviewContent || '').trim().startsWith('{');
    if (reviewContentLooksLikeFindingsJson && (strictFindingsOnlyOutput || (!strictFindingsOnlyOutput && !verdictToken))) {
        const findingsValidation = validateFindingsOnlyReviewOutput({
            reviewContent,
            taskId,
            reviewType,
            reviewContextSha256,
            reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
            coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined,
            repoRoot,
            evidenceSnapshotCommit: resolveReviewCoverageEvidenceSnapshotCommit(preflightPayload)
        });
        if (!findingsValidation.detected || !findingsValidation.valid || !findingsValidation.report) {
            const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflightPayload, repoRoot);
            const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(reviewType, preflightPayload, repoRoot);
            const findingsValidationEvidence = buildReviewFindingsValidationEvidence({
                taskId,
                reviewType,
                validation: findingsValidation,
                reviewOutputSha256: rawReviewOutputSha256,
                reviewArtifactPath: artifactPath,
                reviewArtifactSha256: null,
                reviewContextPath: contextPath,
                reviewContextSha256,
                preflightPath,
                preflightSha256,
                scopeSha256: getPreflightScopeSha256(preflightPayload),
                reviewScopeSha256: reviewScopeFingerprint.review_scope_sha256,
                codeScopeSha256: isNonTestReviewScope(reviewType)
                    ? codeScopeFingerprint.code_scope_sha256
                    : null,
                reviewTreeStateSha256: dependencies.getReviewTreeStateSha256(parsedReviewContext) || null,
                coverageContract: parsedReviewContext.coverage_contract as ReviewCoverageContract | null | undefined
            });
            await writeRejectedReviewFindingsValidationEvidence(findingsValidationEvidence);
            const validationMessage = findingsValidation.detected
                ? findingsValidation.violations.join(' ')
                : 'review output must be a JSON object.';
            throw new Error(
                `Verdict-free findings JSON report is invalid for '${reviewType}': ` +
                validationMessage
            );
        }
        findingsReport = findingsValidation.report;
        if (findingsReport) {
            verdictToken = hasActiveFindings(findingsReport) ? expectedFailVerdict : expectedPassVerdict;
        }
    }
    if (!verdictToken) {
        const passExample = verdictTokenSet.canonicalPassToken || expectedPassVerdict;
        const failExample = verdictTokenSet.canonicalFailToken || expectedFailVerdict;
        const expectedOutputMessage = strictFindingsOnlyOutput
            ? (
                `Review output must contain a valid verdict-free findings JSON report for '${reviewType}'. ` +
                `Legacy PASS/FAIL verdict tokens are readable history only for current generated review contexts. `
            )
            : `Review output must contain a recognized verdict token for '${reviewType}' or a valid verdict-free findings JSON report. `;
        throw new Error(
            expectedOutputMessage +
            formatAcceptedReviewVerdictTokens(verdictTokenSet) +
            (strictFindingsOnlyOutput
                ? ` Legacy examples: '${passExample}' / '${failExample}'. Do not pass '--verdict pass' or similar flags; write the findings JSON object to the review output file.\n\n`
                : ` The token must appear as a standalone line inside the reviewer output file (--review-output-path), not as a CLI flag. Example PASS line: '${passExample}'. Example FAIL line: '${failExample}'. Do not pass '--verdict pass' or similar flags; place the token on its own line under a '## Verdict' heading in the review output file.\n\n`) +
            dependencies.buildMinimalPassReviewTemplateHint(reviewType, passExample) +
            `\n\n${buildSafeReviewOutputRetryInstruction(taskId, reviewType)}`
        );
    }
    const failedReviewVerdict = isFailedReviewVerdictToken(verdictToken, expectedFailVerdict);
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    dependencies.assertReviewContextRuntimeIdentityMetadataPresent({
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        reviewerRouting: currentRouting
    });
    if (reviewType === 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    let historicalStaleReviewResultReason: string | null = null;
    if (parsedReviewContext.tree_state != null) {
        historicalStaleReviewResultReason = assertReviewTreeStateFreshOrHistoricalFailure({
            repoRoot,
            reviewContext: parsedReviewContext,
            contextPath,
            gateName: 'record-review-result',
            allowHistoricalFailedReviewResult: failedReviewVerdict
        });
    }

    if (!findingsReport) {
        let materializedReview: ReturnType<typeof materializeReviewContent>;
        try {
            materializedReview = materializeReviewContent({
                artifactPath,
                reviewType,
                reviewContent,
                verdictToken,
                expectedPassVerdict,
                requirePassValidationNotes: dependencies.reviewContextRequiresPassValidationNotes(contextPath, repoRoot),
                analyze: dependencies.analyzeEarlyReviewMaterialization,
                normalizeHeadings: dependencies.normalizeReviewSectionHeadings,
                buildLosslessPassReviewNormalization: dependencies.buildLosslessPassReviewNormalization,
                isLosslessPassNormalizationEligibleViolation: dependencies.isLosslessPassNormalizationEligibleViolation,
                buildPassReviewTemplateHintMessage: dependencies.buildPassReviewTemplateHintMessage
            });
        } catch (error: unknown) {
            throw appendSafeReviewOutputRetryInstruction(error, taskId, reviewType);
        }
        reviewContent = materializedReview.reviewContent;
        reviewMaterializationFidelity = materializedReview.reviewMaterializationFidelity;
    }
    if (reviewType !== 'test') {
        assertRequiredUpstreamReviewDependencies({
            taskId,
            preflightPath,
            preflightPayload,
            reviewType,
            timelineEvents: readDependencyTimelineEvents(timelinePath),
            taskModePath: String(options.taskModePath || '').trim()
        });
    }
    historicalStaleReviewResultReason = historicalStaleReviewResultReason || assertReviewTreeStateFreshOrHistoricalFailure({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-result',
        allowHistoricalFailedReviewResult: failedReviewVerdict
    });
    resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-review-result'
    });
    const runtimeIdentity = dependencies.assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    dependencies.assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

    const acceptedRawReviewContent = reviewOutput.reviewContent;
    const acceptedReviewArtifactContent = reviewContent.endsWith('\n') ? reviewContent : `${reviewContent}\n`;
    const invocationReviewContextSha256 = fileSha256(contextPath) || '';
    const preApplyReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    const routingReviewerIdentityForLookup = isPlannedReviewerIdentity(preApplyReviewerSessionId)
        ? preApplyReviewerSessionId
        : reviewerIdentity;
    const contextSha256 = invocationReviewContextSha256 || fileSha256(contextPath) || '';

    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        reviewArtifactContent: acceptedReviewArtifactContent,
        contextPath,
        rawReviewOutputPath: reviewOutput.reviewOutputPath,
        rawReviewOutputSourcePath: reviewOutput.reviewOutputSourcePath,
        rawReviewOutputContent: acceptedRawReviewContent,
        rawReviewOutputSha256,
        rawReviewOutputSourceMtimeUtc: reviewOutput.reviewOutputSourceMtimeUtc,
        reviewMaterializationFidelity,
        historicalStaleReviewResultReason,
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath,
        invocationReviewContextSha256,
        routingReviewerIdentity: routingReviewerIdentityForLookup
    }, dependencies);
    cleanupReviewTempSourceArtifact(repoRoot, taskId, reviewOutput.reviewOutputSourcePath);

    console.log(`REVIEW_RESULT_RECORDED: ${reviewType}`);
    console.log(`ArtifactPath: ${normalizePath(artifactPath)}`);
    console.log(`ContextPath: ${normalizePath(contextPath)}`);
    console.log(`ReceiptPath: ${normalizePath(receiptPath)}`);
    console.log(`ReviewerExecutionMode: ${reviewerExecutionMode}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`ReviewOutputMode: ${reviewOutput.reviewOutputMode}`);
    console.log(`ReviewOutputPath: ${normalizePath(reviewOutput.reviewOutputPath)}`);
    console.log(`ReviewOutputSha256: ${rawReviewOutputSha256 || 'n/a'}`);
    console.log(`ReviewMaterializationFidelity: ${reviewMaterializationFidelity}`);
    if (historicalStaleReviewResultReason) {
        console.log('HistoricalStaleReviewResult: true');
        console.log(`HistoricalStaleReviewReason: ${historicalStaleReviewResultReason}`);
    }
    if (reviewOutput.reviewOutputSourcePath) {
        console.log(`ReviewOutputSourcePath: ${normalizePath(reviewOutput.reviewOutputSourcePath)}`);
    }
    console.log(`ContextSha256: ${contextSha256 || 'n/a'}`);
    if (reviewerFallbackReason) {
        console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
    }
    console.log(`VerdictToken: ${verdictToken}`);
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}

async function handleRecordReviewReceiptWithDependencies(
    gateArgv: string[],
    dependencies: ReviewResultHandlersDependencies
): Promise<void> {
    const { options: rawOptions } = parseOptions(gateArgv, recordReviewReceiptOptionDefinitions(), { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = dependencies.resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = dependencies.parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath),
        taskModePath: String(options.taskModePath || '').trim()
    });
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        rawReviewOutputPath: artifactPath,
        rawReviewOutputSha256: fileSha256(artifactPath),
        rawReviewOutputSourceMtimeUtc: fs.statSync(artifactPath).mtime.toISOString(),
        taskModePath: String(options.taskModePath || '').trim(),
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    }, dependencies);
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
    console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
}

export function createReviewResultHandlers(dependencies: ReviewResultHandlersDependencies): ReviewResultHandlers {
    return {
        handleRecordReviewResult: (gateArgv) => handleRecordReviewResultWithDependencies(gateArgv, dependencies),
        handleRecordReviewReceipt: (gateArgv) => handleRecordReviewReceiptWithDependencies(gateArgv, dependencies)
    };
}
