import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    buildReviewReceiptReviewerInvocationProvenance,
    buildReviewReceiptReviewerProvenance,
    buildReviewVerdictTokenSet,
    extractReviewVerdictToken,
    formatAcceptedReviewVerdictTokens,
    restoreReviewerRoutingMetadata
} from '../../../../gate-runtime/review-context';
import { fileSha256 } from '../../../../gate-runtime/hash';
import {
    emitReviewRecordedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import {
    redactSecretText
} from '../../../../core/redaction';
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
    type ReviewDependencyTimelineEvent
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
    assertReviewTreeStateFresh
} from '../../../../gates/review/review-tree-state';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../../gates/review/review-prompt-artifact';
import type {
    getReviewArtifactFindingsEvidence,
    normalizeCanonicalReviewSectionHeadings
} from '../../../../gates/completion/completion';
import type {
    resolveRuntimeReviewerIdentity
} from '../../../../gates/review/reviewer-routing';
import { REVIEW_CONTRACTS } from '../../../../gates/required-reviews/required-reviews-check';
import {
    cleanupReviewTempSourceArtifact
} from '../../gates-artifacts';
import {
    normalizePathValue,
    parseOptions
} from '../../cli-helpers';
import {
    buildGateCommandPrefix,
    quotePowerShellCliValue
} from '../../gate-flows/task-mode/task-mode-command-format';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
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

type ReviewerExecutionMode = 'delegated_subagent';
type RuntimeReviewerIdentity = ReturnType<typeof resolveRuntimeReviewerIdentity>;
type ReviewFindingsEvidence = ReturnType<typeof getReviewArtifactFindingsEvidence>;

interface ParsedReviewerIdentity {
    reviewerExecutionMode: ReviewerExecutionMode;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

interface ReviewMaterializationAnalysis {
    violations: string[];
    findingsEvidence: ReviewFindingsEvidence;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

interface ReviewResultHandlersDependencies {
    analyzeEarlyReviewMaterialization: (options: {
        artifactPath: string;
        reviewContent: string;
        verdictToken: string;
        expectedPassVerdict: string;
        requirePassValidationNotes: boolean;
    }) => ReviewMaterializationAnalysis;
    assertExplicitReviewContextRuntimeIdentity: (options: {
        repoRoot: string;
        taskId: string;
        reviewType: string;
        contextPath: string;
        reviewerRouting: Record<string, unknown> | null;
        taskModePath?: string | null;
    }) => RuntimeReviewerIdentity;
    assertReviewContextContractOrThrow: (options: {
        taskId: string;
        reviewType: string;
        contextPath: string;
        reviewContext: Record<string, unknown> | null;
        preflightPath: string;
        preflightSha256: string | null;
        preflightPayload?: Record<string, unknown> | null;
        requireStrictBindingMetadata?: boolean;
    }) => void;
    assertReviewContextRuntimeIdentityMetadataPresent: (options: {
        reviewType: string;
        contextPath: string;
        reviewContext: Record<string, unknown> | null;
        reviewerRouting: Record<string, unknown> | null;
    }) => void;
    assertRoutingCompatibility: (options: {
        reviewType: string;
        runtimeIdentity: RuntimeReviewerIdentity;
        currentRouting: Record<string, unknown> | null;
        reviewerExecutionMode: ReviewerExecutionMode;
        reviewerFallbackReason: string | null;
    }) => void;
    buildLosslessPassReviewNormalization: (options: {
        reviewType: string;
        reviewContent: string;
        expectedPassVerdict: string;
        findingsEvidence: ReviewFindingsEvidence;
    }) => string | null;
    buildMinimalPassReviewTemplateHint: (reviewType: string, expectedPassVerdict: string) => string;
    buildPassReviewTemplateHintMessage: (options: {
        reviewType: string;
        verdictToken: string;
        expectedPassVerdict: string;
        reviewContent: string;
        findingsEvidence: ReviewFindingsEvidence;
    }) => string | null;
    findMatchingReviewerInvocationAttestationEvent: (
        timelineEvents: readonly ReviewDependencyTimelineEvent[],
        options: {
            taskId: string;
            reviewType: string;
            reviewerExecutionMode: ReviewerExecutionMode;
            reviewerIdentity: string;
            reviewContextSha256: string;
            reviewTreeStateSha256?: string | null;
            routingEventSha256: string;
        }
    ) => ReviewDependencyTimelineEvent | null;
    findMatchingRoutingEvent: (
        timelineEvents: readonly ReviewDependencyTimelineEvent[],
        reviewType: string,
        reviewerExecutionMode: ReviewerExecutionMode,
        reviewerIdentity: string,
        reviewerFallbackReason: string | null
    ) => ReviewDependencyTimelineEvent | null;
    getReviewTreeStateSha256: (reviewContext: Record<string, unknown>) => string;
    isLosslessPassNormalizationEligibleViolation: (violation: string) => boolean;
    parseReviewerIdentity: (options: ParsedOptionsRecord, modeRequiredMessage: string) => ParsedReviewerIdentity;
    readReviewOutputFromStdin: () => Promise<string>;
    normalizeReviewSectionHeadings: typeof normalizeCanonicalReviewSectionHeadings;
    resolveCanonicalReviewPaths: (
        repoRoot: string,
        taskId: string,
        reviewType: string,
        preflightPathValue: unknown,
        reviewContextPathValue: unknown
    ) => ResolvedCanonicalReviewPaths;
    reviewContextRequiresPassValidationNotes: (contextPath: string, repoRoot: string) => boolean;
}

function recordReviewResultOptionDefinitions(): Record<string, { key: string; type: 'string' | 'boolean' }> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--review-output-stdin': { key: 'reviewOutputStdin', type: 'boolean' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
}

function recordReviewReceiptOptionDefinitions(): Record<string, { key: string; type: 'string' }> {
    return {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
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
        {
            artifactPath: artifactSnapshotPath,
            contentType: 'text' as const,
            content: artifactContent
        }
    ];
    await writeReviewArtifactsWithRollback(writes, async () => {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...options.receipt,
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
        requireStrictBindingMetadata: options.requireStrictBindingMetadata
    });
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
                return entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
                    && String(details?.task_id || details?.taskId || '').trim() === options.taskId
                    && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === options.reviewType
                    && String(details?.reviewer_execution_mode || details?.reviewerExecutionMode || '').trim() === options.reviewerExecutionMode
                    && String(details?.reviewer_identity || details?.reviewer_session_id || '').trim() === options.reviewerIdentity
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
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(preflight, options.repoRoot);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        preflight,
        options.repoRoot
    );
    const preflightMetrics = preflight.metrics && typeof preflight.metrics === 'object' && !Array.isArray(preflight.metrics)
        ? preflight.metrics as Record<string, unknown>
        : null;
    const scopeSha256 = String(preflightMetrics?.scope_sha256 || preflightMetrics?.changed_files_sha256 || '').trim() || null;
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
    if (historicalStaleReviewResultReason) {
        (receipt as unknown as Record<string, unknown>).historical_stale_review_result = true;
        (receipt as unknown as Record<string, unknown>).review_result_scope = 'historical_stale_after_remediation';
        (receipt as unknown as Record<string, unknown>).historical_stale_review_reason = historicalStaleReviewResultReason;
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
        artifactSha256
    });
}

function sha256ReviewArtifactContent(content: string): string {
    return createHash('sha256')
        .update(redactSecretText(content))
        .digest('hex');
}

function buildSafeReviewOutputRetryInstruction(taskId: string, reviewType: string): string {
    return [
        'Safe recovery:',
        `fix the reviewer output and rerun record-review-result for '${taskId}' '${reviewType}'.`,
        'The canonical raw review-output artifact is replaced only after validation and receipt recording succeed.'
    ].join(' ');
}

function appendSafeReviewOutputRetryInstruction(error: unknown, taskId: string, reviewType: string): Error {
    const message = error instanceof Error ? error.message : String(error);
    const instruction = buildSafeReviewOutputRetryInstruction(taskId, reviewType);
    if (message.includes(instruction)) {
        return error instanceof Error ? error : new Error(message);
    }
    return new Error(`${message}\n\n${instruction}`);
}

function getReviewContextTreeStateSha256(reviewContext: Record<string, unknown>): string | null {
    const treeState = isPlainRecord(reviewContext.tree_state)
        ? reviewContext.tree_state
        : null;
    const sha256 = String(treeState?.tree_state_sha256 ?? treeState?.treeStateSha256 ?? '').trim().toLowerCase();
    return sha256 || null;
}

function isFailedReviewVerdictToken(verdictToken: string, expectedFailVerdict: string): boolean {
    const normalizedVerdict = verdictToken.trim().toUpperCase();
    const normalizedExpectedFail = expectedFailVerdict.trim().toUpperCase();
    return normalizedVerdict === normalizedExpectedFail || normalizedVerdict.endsWith(' REVIEW FAILED');
}

function assertReviewTreeStateFreshOrHistoricalFailure(options: {
    repoRoot: string;
    reviewContext: Record<string, unknown>;
    contextPath: string;
    gateName: string;
    allowHistoricalFailedReviewResult: boolean;
}): string | null {
    try {
        assertReviewTreeStateFresh({
            repoRoot: options.repoRoot,
            reviewContext: options.reviewContext,
            contextPath: options.contextPath,
            gateName: options.gateName
        });
        return null;
    } catch (error: unknown) {
        if (!options.allowHistoricalFailedReviewResult) {
            throw error;
        }
        if (!getReviewContextTreeStateSha256(options.reviewContext)) {
            throw error;
        }
        const reason = error instanceof Error ? error.message : String(error);
        return reason.trim() || 'review context tree-state became stale before failed review result materialization';
    }
}

function parseUtcTimestampMs(value: unknown): number | null {
    const text = String(value || '').trim();
    if (!text) {
        return null;
    }
    const parsed = Date.parse(text);
    return Number.isFinite(parsed) ? parsed : null;
}

function getDelegationStartedAtUtc(value: unknown): string | null {
    const record = value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
    const text = String(record?.delegation_started_at_utc ?? '').trim();
    return text || null;
}

function assertReviewOutputNotOlderThanDelegation(options: {
    taskId: string;
    reviewType: string;
    preflightPath: string;
    repoRoot: string;
    reviewerExecutionMode: string;
    reviewerIdentity: string;
    reviewOutputSourcePath: string | null | undefined;
    reviewOutputSourceMtimeUtc: string | null | undefined;
    delegationStartedAtUtc: string | null | undefined;
}): void {
    const reviewOutputSourceMtimeMs = parseUtcTimestampMs(options.reviewOutputSourceMtimeUtc);
    const delegationStartedAtMs = parseUtcTimestampMs(options.delegationStartedAtUtc);
    if (reviewOutputSourceMtimeMs == null) {
        return;
    }
    const stdinGateCommand = [
        `${buildGateCommandPrefix(options.repoRoot)} gate record-review-result`,
        '--task-id', quotePowerShellCliValue(options.taskId),
        '--review-type', quotePowerShellCliValue(options.reviewType),
        '--preflight-path', quotePowerShellCliValue(options.preflightPath),
        '--review-output-stdin',
        '--repo-root', quotePowerShellCliValue(options.repoRoot),
        '--reviewer-execution-mode', quotePowerShellCliValue(options.reviewerExecutionMode),
        '--reviewer-identity', quotePowerShellCliValue(options.reviewerIdentity)
    ].join(' ');
    const stdinCommand = options.reviewOutputSourcePath
        ? `Get-Content -Raw -LiteralPath ${quotePowerShellCliValue(options.reviewOutputSourcePath)} | ${stdinGateCommand}`
        : stdinGateCommand;
    if (delegationStartedAtMs == null) {
        throw new Error(
            `Review output path-mode timing is ambiguous for '${options.reviewType}': ` +
            'delegation_started_at_utc is missing or invalid, so path metadata cannot prove post-delegation authorship. ' +
            'Receipt materialization remains blocked.\n\n' +
            'Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after ' +
            `delegation evidence exists. PowerShell-safe command:\n${stdinCommand}\n` +
            'Do not backdate delegation evidence or edit file mtimes to bypass this check.'
        );
    }
    if (reviewOutputSourceMtimeMs >= delegationStartedAtMs) {
        return;
    }
    throw new Error(
        `Review output path-mode timing is impossible for '${options.reviewType}': ` +
        `review_output_source_mtime_utc (${options.reviewOutputSourceMtimeUtc}) is earlier than ` +
        `delegation_started_at_utc (${options.delegationStartedAtUtc}). ` +
        'This usually means the delegated reviewer wrote the output file before delegation-start evidence was recorded, ' +
        'so path metadata cannot prove post-delegation authorship. Receipt materialization remains blocked.\n\n' +
        'Safe recovery: rerun record-review-result by piping the same delegated reviewer output through stdin after ' +
        `delegation evidence exists. PowerShell-safe command:\n${stdinCommand}\n` +
        'Do not backdate delegation evidence or edit file mtimes to bypass this check.'
    );
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
    const verdictToken = extractReviewVerdictToken(reviewContent, expectedPassVerdict, expectedFailVerdict, reviewType);
    if (!verdictToken) {
        const passExample = verdictTokenSet.canonicalPassToken || expectedPassVerdict;
        const failExample = verdictTokenSet.canonicalFailToken || expectedFailVerdict;
        throw new Error(
            `Review output must contain a recognized verdict token for '${reviewType}'. ` +
            formatAcceptedReviewVerdictTokens(verdictTokenSet) +
            ` The token must appear as a standalone line inside the reviewer output file (--review-output-path), not as a CLI flag. ` +
            `Example PASS line: '${passExample}'. Example FAIL line: '${failExample}'. ` +
            `Do not pass '--verdict pass' or similar flags; place the token on its own line under a '## Verdict' heading in the review output file.\n\n` +
            dependencies.buildMinimalPassReviewTemplateHint(reviewType, passExample) +
            `\n\n${buildSafeReviewOutputRetryInstruction(taskId, reviewType)}`
        );
    }
    const failedReviewVerdict = isFailedReviewVerdictToken(verdictToken, expectedFailVerdict);
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
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
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
    const rawReviewOutputSha256 = sha256ReviewArtifactContent(acceptedRawReviewContent);
    const invocationReviewContextSha256 = fileSha256(contextPath) || '';
    const preApplyReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    const routingReviewerIdentityForLookup = isPlannedReviewerIdentity(preApplyReviewerSessionId)
        ? preApplyReviewerSessionId
        : reviewerIdentity;
    const previousRoutingUpdate = {
        actualExecutionMode: currentRouting?.actual_execution_mode != null
            ? String(currentRouting.actual_execution_mode).trim() || null
            : null,
        reviewerSessionId: currentRouting?.reviewer_session_id != null
            ? String(currentRouting.reviewer_session_id).trim() || null
            : null,
        fallbackReason: currentRouting?.fallback_reason != null
            ? String(currentRouting.fallback_reason).trim() || null
            : null
    };
    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });

    try {
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
        console.log(`ContextSha256: ${routingUpdate.contextSha256 || 'n/a'}`);
        if (reviewerFallbackReason) {
            console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
        }
        console.log(`VerdictToken: ${verdictToken}`);
        console.log(`ReviewerCleanup: ${REVIEWER_CLEANUP_AFTER_RECEIPT_INSTRUCTION}`);
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        throw error;
    }
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

export function createReviewResultHandlers(dependencies: ReviewResultHandlersDependencies): {
    handleRecordReviewResult: (gateArgv: string[]) => Promise<void>;
    handleRecordReviewReceipt: (gateArgv: string[]) => Promise<void>;
} {
    return {
        handleRecordReviewResult: (gateArgv) => handleRecordReviewResultWithDependencies(gateArgv, dependencies),
        handleRecordReviewReceipt: (gateArgv) => handleRecordReviewReceiptWithDependencies(gateArgv, dependencies)
    };
}
