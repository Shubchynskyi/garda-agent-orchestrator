import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewContext,
    resolveContextOutputPath,
    resolveReviewSkillId,
    resolveScopedDiffMetadataPath
} from '../../../gates/build-review-context';
import {
    emitReviewPhaseStartedEventAsync,
    emitReviewRecordedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import {
    buildReviewReceipt,
    buildReviewVerdictTokenSet,
    extractReviewVerdictTokenMatch,
    normalizeReviewerExecutionMode,
    normalizeReviewReceiptReviewerProvenance,
    type ReviewReceipt,
    type ReviewContextSectionsResult
} from '../../../gate-runtime/review-context';
import {
    emitSkillReferenceLoadedEventAsync,
    emitSkillSelectedEventAsync
} from '../../../runtime/skill-telemetry';
import { writeReviewArtifactJson } from '../../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../../gates/helpers';
import { assertReviewLifecycleGuardFromEntries } from '../../../gates/review-lifecycle-guard';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../../gates/review-dependencies';
import {
    resolveRuntimeReviewerIdentity,
    type RuntimeReviewerIdentity
} from '../../../gates/reviewer-routing';
import { getTaskModeEvidence } from '../../../gates/task-mode';
import { resolveGateExecutionPath } from '../../../gates/isolation-sandbox';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    computeReviewContextReuseHash,
    isNonTestReviewScope
} from '../../../gates/review-reuse';
import { findMatchingHistoricalReviewRecordedTelemetryEvent } from '../../../gates/review-reuse-telemetry';
import { taskEventAppendHasBlockingFailure } from '../../../gate-runtime/task-events';
import {
    normalizePathValue,
    ensureDirectoryExists,
    parseRequiredText
} from '../cli-helpers';
import {
    buildKeyValueOutputLines,
    requireResolvedPath
} from '../shared-command-utils';
import type { TokenEconomyConfig } from '../../../gates/build-review-context';

interface ReviewReuseResult {
    reused: boolean;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
}

interface CompileEvidenceSummary {
    status: string | null;
    preflightPath: string | null;
    preflightHashSha256: string | null;
}

export interface TimelineEventsSummaryResult {
    events: ReviewDependencyTimelineEvent[];
    hasInvalidLines: boolean;
}

export function readTimelineEventsSummary(timelinePath: string): TimelineEventsSummaryResult {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return {
            events: [],
            hasInvalidLines: false
        };
    }
    const events: ReviewDependencyTimelineEvent[] = [];
    let hasInvalidLines = false;
    const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim().length > 0);
    for (let index = 0; index < lines.length; index += 1) {
        try {
            const parsed = JSON.parse(lines[index]) as Record<string, unknown>;
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                ? parsed.integrity as Record<string, unknown>
                : null;
            const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                ? rawIntegrity.task_sequence
                : Number(rawIntegrity?.task_sequence);
            const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
            const prevEventSha256 = prevEventSha256Raw == null
                ? null
                : String(prevEventSha256Raw).trim().toLowerCase() || null;
            events.push({
                event_type: String(parsed.event_type || '').trim().toUpperCase(),
                sequence: index,
                details,
                integrity: rawIntegrity
                    && Number.isInteger(taskSequence)
                    && taskSequence > 0
                    && /^[0-9a-f]{64}$/.test(eventSha256)
                    && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                    ? {
                        schema_version: typeof rawIntegrity.schema_version === 'number'
                            ? rawIntegrity.schema_version
                            : Number(rawIntegrity.schema_version) || 1,
                        task_sequence: taskSequence,
                        prev_event_sha256: prevEventSha256,
                        event_sha256: eventSha256
                    }
                    : null
            });
        } catch {
            hasInvalidLines = true;
        }
    }
    return {
        events,
        hasInvalidLines
    };
}

function findLatestTimelineSequence(
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

function readCompileEvidenceSummary(repoRoot: string, taskId: string): CompileEvidenceSummary {
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

function normalizeReceiptSha256(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
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
    return passVerdicts[String(reviewType || '').trim().toLowerCase()] || `${String(reviewType || '').trim().toUpperCase()} REVIEW PASSED`;
}

function artifactHasPassVerdict(reviewType: string, artifactText: string): boolean {
    const tokenMatch = extractReviewVerdictTokenMatch(
        artifactText,
        buildReviewVerdictTokenSet(reviewType, getReviewPassVerdict(reviewType))
    );
    return tokenMatch?.outcome === 'pass';
}

async function tryReuseReviewEvidence(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    reviewContextPath: string;
    previousReviewContextReuseSha256?: string | null;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
}): Promise<ReviewReuseResult> {
    const nonTestReviewScope = isNonTestReviewScope(options.reviewType);
    const codeScopeFingerprint = computeCodeReviewScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (reviewScopeFingerprint.missing_review_relevant_files.length > 0) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (!fs.existsSync(receiptPath) || !fs.statSync(receiptPath).isFile()) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const artifactText = fs.readFileSync(artifactPath, 'utf8');
    if (!artifactHasPassVerdict(options.reviewType, artifactText)) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    let receipt: ReviewReceipt;
    try {
        receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')) as ReviewReceipt;
    } catch {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const reviewerExecutionMode = normalizeReviewerExecutionMode(receipt.reviewer_execution_mode);
    const reviewerIdentity = String(receipt.reviewer_identity || '').trim() || null;
    const historicalReviewerProvenance = receipt.reviewer_provenance == null
        ? null
        : normalizeReviewReceiptReviewerProvenance(receipt.reviewer_provenance);
    const historicalTrustLevel = String(receipt.trust_level || '').trim().toUpperCase();
    const expectedContextSha256 = String(receipt.review_context_sha256 || '').trim().toLowerCase() || null;
    const historicalProvenanceContextSha256 = historicalReviewerProvenance?.attestation_type === 'reviewer_invocation_attestation'
        ? historicalReviewerProvenance.review_context_sha256
        : null;
    const historicalReviewContextSha256 = normalizeReceiptSha256(receipt.reused_existing_review === true
        ? receipt.reused_from_review_context_sha256 || historicalProvenanceContextSha256
        : expectedContextSha256);
    const expectedContextReuseSha256 = String(
        receipt.review_context_reuse_sha256 || options.previousReviewContextReuseSha256 || ''
    ).trim().toLowerCase() || null;
    const expectedReviewScopeSha256 = String(receipt.review_scope_sha256 || '').trim().toLowerCase() || null;
    const expectedCodeScopeSha256 = normalizeReceiptSha256(receipt.code_scope_sha256);
    if (receipt.task_id !== options.taskId || receipt.review_type !== options.reviewType) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (!reviewerExecutionMode || !reviewerIdentity || !expectedContextSha256) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (reviewerExecutionMode !== 'delegated_subagent' || !reviewerIdentity.startsWith('agent:') || !historicalReviewerProvenance) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    if (
        historicalTrustLevel !== 'INDEPENDENT_AUDITED'
        || historicalReviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || historicalReviewerProvenance.task_id !== options.taskId
        || historicalReviewerProvenance.review_type !== options.reviewType
        || historicalReviewerProvenance.reviewer_execution_mode !== reviewerExecutionMode
        || historicalReviewerProvenance.reviewer_identity !== reviewerIdentity
        || historicalReviewerProvenance.review_context_sha256 !== historicalReviewContextSha256
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const historicalReviewArtifactSha256 = String(gateHelpers.fileSha256(artifactPath) || '').trim().toLowerCase();
    if (String(receipt.review_artifact_sha256 || '').trim().toLowerCase() !== historicalReviewArtifactSha256) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const currentCodeScopeSha256 = normalizeReceiptSha256(codeScopeFingerprint.code_scope_sha256);
    const hasCurrentCodeScope = codeScopeFingerprint.non_test_changed_files.length > 0;
    if (
        nonTestReviewScope
        && hasCurrentCodeScope
        && (!expectedCodeScopeSha256 || expectedCodeScopeSha256 !== currentCodeScopeSha256)
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const hasCurrentReviewScope = reviewScopeFingerprint.review_relevant_changed_files.length > 0;
    if (
        !nonTestReviewScope
        && hasCurrentReviewScope
        && (!expectedReviewScopeSha256
            || expectedReviewScopeSha256 !== String(reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase())
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    const currentPreflightHash = String(gateHelpers.fileSha256(options.preflightPath) || '').trim().toLowerCase() || null;
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    const timelineEvents = options.timelineEventsSummary?.events || readTimelineEventsSummary(timelinePath).events;
    const latestCompilePassSequence = findLatestTimelineSequence(
        timelineEvents,
        (entry) => entry.event_type === 'COMPILE_GATE_PASSED'
    );
    if (latestCompilePassSequence == null) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const historicalInvocationEvent = timelineEvents.find((entry) => (
        entry.sequence < latestCompilePassSequence
        && entry.event_type === 'REVIEWER_INVOCATION_ATTESTED'
        && entry.integrity
        && entry.integrity.task_sequence === historicalReviewerProvenance.task_sequence
        && String(entry.integrity.event_sha256 || '').trim().toLowerCase() === historicalReviewerProvenance.event_sha256
        && (entry.integrity.prev_event_sha256 == null
            ? null
            : String(entry.integrity.prev_event_sha256).trim().toLowerCase() || null) === historicalReviewerProvenance.prev_event_sha256
        && String(entry.details?.task_id || entry.details?.taskId || '').trim() === options.taskId
        && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType
        && String(entry.details?.reviewer_execution_mode || entry.details?.reviewerExecutionMode || '').trim() === reviewerExecutionMode
        && (
            String(entry.details?.reviewer_identity || entry.details?.reviewerIdentity || '').trim()
            || String(entry.details?.reviewer_session_id || entry.details?.reviewerSessionId || '').trim()
        ) === reviewerIdentity
        && String(entry.details?.review_context_sha256 || entry.details?.reviewContextSha256 || '').trim().toLowerCase() === historicalReviewContextSha256
        && String(entry.details?.routing_event_sha256 || entry.details?.routingEventSha256 || '').trim().toLowerCase() === historicalReviewerProvenance.routing_event_sha256
    ));
    if (!historicalInvocationEvent) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const historicalRecordedEvent = findMatchingHistoricalReviewRecordedTelemetryEvent(timelineEvents, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        receiptPath,
        reviewContextSha256: expectedContextSha256,
        reviewContextReuseSha256: expectedContextReuseSha256,
        reviewScopeSha256: expectedReviewScopeSha256,
        codeScopeSha256: expectedCodeScopeSha256,
        reviewArtifactSha256: historicalReviewArtifactSha256,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerProvenance: historicalReviewerProvenance as unknown as Record<string, unknown>,
        maxEventSequenceExclusive: latestCompilePassSequence
    });
    if (!historicalRecordedEvent) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const hasCurrentCycleReviewEvidence = timelineEvents.some((entry) => (
        entry.sequence > latestCompilePassSequence
        && (
            (entry.event_type === 'REVIEWER_DELEGATION_ROUTED'
                && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType)
            || (entry.event_type === 'REVIEW_RECORDED'
                && String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase() === options.reviewType)
        )
    ));
    if (hasCurrentCycleReviewEvidence) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }

    const currentReviewContext = JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>;
    const currentReviewContextSha256 = String(gateHelpers.fileSha256(options.reviewContextPath) || '').trim().toLowerCase() || null;
    const currentContextReuseSha256 = String(computeReviewContextReuseHash(currentReviewContext) || '').trim().toLowerCase() || null;
    const acceptableContextReuseHashes = [
        expectedContextReuseSha256,
        String(options.previousReviewContextReuseSha256 || '').trim().toLowerCase() || null
    ].filter((value): value is string => !!value);
    const contextHashMatches = !!expectedContextSha256 && expectedContextSha256 === currentReviewContextSha256;
    const contextReuseHashMatches = !!currentContextReuseSha256 && acceptableContextReuseHashes.includes(currentContextReuseSha256);
    if (!contextHashMatches && !contextReuseHashMatches) {
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    const receiptRollbackState = fs.existsSync(receiptPath) && fs.statSync(receiptPath).isFile()
        ? {
            existed: true,
            content: fs.readFileSync(receiptPath, 'utf8')
        }
        : {
            existed: false,
            content: null as string | null
        };
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    try {
        const reviewContextReuseSha256 = String(computeReviewContextReuseHash(
            JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>
        ) || '').trim().toLowerCase() || null;
        const refreshedReceipt = buildReviewReceipt({
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightSha256: currentPreflightHash,
            scopeSha256: String(
                (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.scope_sha256
                || (options.preflightPayload.metrics as Record<string, unknown> | undefined)?.changed_files_sha256
                || ''
            ).trim() || null,
            reviewScopeSha256: String(reviewScopeFingerprint.review_scope_sha256 || '').trim().toLowerCase() || null,
            codeScopeSha256: nonTestReviewScope
                ? String(codeScopeFingerprint.code_scope_sha256 || '').trim().toLowerCase() || null
                : null,
            reviewContextSha256: currentReviewContextSha256,
            reviewContextReuseSha256,
            reviewArtifactSha256: String(gateHelpers.fileSha256(artifactPath) || '').trim().toLowerCase() || null,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason: receipt.reviewer_fallback_reason ?? null,
            reviewerProvenance: historicalReviewerProvenance,
            trustLevel: 'INDEPENDENT_AUDITED',
            reusedExistingReview: true,
            reusedFromReceiptPath: gateHelpers.normalizePath(receiptPath),
            reusedFromReviewContextSha256: expectedContextSha256,
            reusedFromReviewContextReuseSha256: expectedContextReuseSha256,
            reusedFromReviewScopeSha256: expectedReviewScopeSha256,
            reusedFromCodeScopeSha256: expectedCodeScopeSha256
        });
        writeReviewArtifactJson(receiptPath, refreshedReceipt);
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...refreshedReceipt,
            reused_existing_review: true,
            reuse_event_type: 'REVIEW_EVIDENCE_REUSED',
            reused_from_receipt_path: gateHelpers.normalizePath(receiptPath),
            reused_from_review_context_sha256: expectedContextSha256,
            reused_from_review_context_reuse_sha256: expectedContextReuseSha256,
            reused_from_review_scope_sha256: expectedReviewScopeSha256,
            reused_from_code_scope_sha256: expectedCodeScopeSha256,
            receipt_path: gateHelpers.normalizePath(receiptPath),
            review_artifact_path: gateHelpers.normalizePath(artifactPath),
            review_context_path: gateHelpers.normalizePath(options.reviewContextPath),
            review_context_sha256: currentReviewContextSha256
        });
        if (!recordedEvent || taskEventAppendHasBlockingFailure(recordedEvent, false)) {
            throw new Error('REVIEW_RECORDED telemetry could not be persisted for review reuse.');
        }
    } catch {
        try {
            if (receiptRollbackState.existed) {
                fs.writeFileSync(receiptPath, String(receiptRollbackState.content || ''), 'utf8');
            } else if (fs.existsSync(receiptPath)) {
                fs.rmSync(receiptPath, { force: true });
            }
        } catch {
            // Best-effort rollback only.
        }
        return { reused: false, receiptPath: null, reviewerExecutionMode: null, reviewerIdentity: null };
    }
    return {
        reused: true,
        receiptPath: gateHelpers.normalizePath(receiptPath),
        reviewerExecutionMode,
        reviewerIdentity
    };
}

export interface BuildReviewContextCommandResult {
    reviewType: string;
    outputPath: string;
    ruleContextArtifactPath: string;
    tokenEconomyActive: boolean;
    reusedReviewEvidence: boolean;
    reusedReceiptPath: string | null;
    reusedReviewerExecutionMode: string | null;
    reusedReviewerIdentity: string | null;
    outputLines: string[];
}

export interface BuildReviewContextCommandOptions {
    reviewType?: unknown;
    depth?: unknown;
    preflightPath?: unknown;
    preflightPayload?: Record<string, unknown> | null;
    taskModePath?: unknown;
    taskModeEvidence?: ReturnType<typeof getTaskModeEvidence> | null;
    runtimeReviewerIdentity?: RuntimeReviewerIdentity | null;
    tokenEconomyConfigPath?: unknown;
    tokenEconomyConfigData?: TokenEconomyConfig | null;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
    scopedDiffMetadataPath?: unknown;
    outputPath?: unknown;
    repoRoot?: unknown;
    ruleContextSectionsCache?: Map<string, ReviewContextSectionsResult> | null;
    ruleFileContentCache?: Map<string, string> | null;
}

export async function runBuildReviewContextCommand(
    options: BuildReviewContextCommandOptions
): Promise<BuildReviewContextCommandResult> {
    const repoRoot = normalizePathValue(options.repoRoot || '.');
    ensureDirectoryExists(repoRoot, 'Repo root');
    const reviewType = parseRequiredText(options.reviewType, 'ReviewType');
    const depth = Number.parseInt(parseRequiredText(options.depth, 'Depth'), 10);
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
        throw new Error('Depth must be an integer between 1 and 3.');
    }
    const preflightPath = requireResolvedPath(
        gateHelpers.resolvePathInsideRepo(parseRequiredText(options.preflightPath, 'PreflightPath'), repoRoot),
        'PreflightPath'
    );
    const preflightPayload = (
        options.preflightPayload
        && typeof options.preflightPayload === 'object'
        && !Array.isArray(options.preflightPayload)
    )
        ? options.preflightPayload
        : JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const taskModePath = String(options.taskModePath || '').trim();
    const taskId = String(preflightPayload.task_id || '').trim();
    const taskModeEvidence = taskId
        ? (
            options.taskModeEvidence
            || getTaskModeEvidence(repoRoot, taskId, taskModePath)
        )
        : null;
    const runtimeReviewerIdentity = taskId
        ? (
            options.runtimeReviewerIdentity
            || resolveRuntimeReviewerIdentity({
                repoRoot,
                taskId,
                taskModePath,
                taskModeEvidence,
                allowLegacyFallback: true
            })
        )
        : null;
    const timelinePath = taskId
        ? gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`))
        : null;
    const timelineSummary = timelinePath
        ? (options.timelineEventsSummary || readTimelineEventsSummary(timelinePath))
        : null;
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
    const tokenEconomyConfigPath = options.tokenEconomyConfigPath
        ? requireResolvedPath(
            gateHelpers.resolvePathInsideRepo(String(options.tokenEconomyConfigPath), repoRoot, { allowMissing: true }),
            'TokenEconomyConfigPath'
        )
        : resolveGateExecutionPath(repoRoot, path.join('live', 'config', 'token-economy.json'));
    const outputPath = resolveContextOutputPath(String(options.outputPath || ''), preflightPath, reviewType, repoRoot);
    const scopedDiffMetadataPath = resolveScopedDiffMetadataPath(
        String(options.scopedDiffMetadataPath || ''),
        preflightPath,
        reviewType,
        repoRoot
    );
    let previousReviewContextReuseSha256: string | null = null;
    if (['code', 'test'].includes(reviewType) && fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
        try {
            previousReviewContextReuseSha256 = computeReviewContextReuseHash(
                JSON.parse(fs.readFileSync(outputPath, 'utf8')) as Record<string, unknown>
            );
        } catch {
            previousReviewContextReuseSha256 = null;
        }
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
        reviewerIdentity: null
    };

    try {
        if (taskId) {
            const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
            const skillId = resolveReviewSkillId(reviewType, repoRoot);
            const skillPath = resolveGateExecutionPath(repoRoot, path.join('live', 'skills', skillId, 'SKILL.md'));

            await emitReviewPhaseStartedEventAsync(orchestratorRoot, taskId, {
                review_type: reviewType,
                depth,
                preflight_path: gateHelpers.normalizePath(preflightPath),
                output_path: result.output_path,
                review_context_artifact_path: result.rule_context.artifact_path
            });
            await emitSkillSelectedEventAsync(orchestratorRoot, taskId, skillId, null, 'required_review');
            if (fs.existsSync(skillPath) && fs.statSync(skillPath).isFile()) {
                await emitSkillReferenceLoadedEventAsync(orchestratorRoot, taskId, gateHelpers.normalizePath(skillPath), skillId, 'review_skill');
            }
            await emitSkillReferenceLoadedEventAsync(
                orchestratorRoot,
                taskId,
                gateHelpers.normalizePath(result.rule_context.artifact_path),
                skillId,
                'review_context_artifact'
            );
            reviewReuseResult = await tryReuseReviewEvidence({
                repoRoot,
                taskId,
                reviewType,
                preflightPath,
                preflightPayload,
                reviewContextPath: outputPath,
                previousReviewContextReuseSha256,
                timelineEventsSummary: timelineSummary
            });
        }
    } catch {
        // Keep build-review-context resilient even when telemetry cannot be emitted.
    }

    const outputKV: Record<string, unknown> = {
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active
    };
    const orderedKeys = ['outputPath', 'ruleContextArtifactPath', 'tokenEconomyActive'];
    if (reviewReuseResult.reused) {
        outputKV.reusedReviewEvidence = true;
        outputKV.reusedReceiptPath = reviewReuseResult.receiptPath;
        outputKV.reusedReviewerExecutionMode = reviewReuseResult.reviewerExecutionMode;
        outputKV.reusedReviewerIdentity = reviewReuseResult.reviewerIdentity;
        orderedKeys.push('reusedReviewEvidence', 'reusedReceiptPath', 'reusedReviewerExecutionMode', 'reusedReviewerIdentity');
    }
    const outputLines = buildKeyValueOutputLines(outputKV, orderedKeys);
    return {
        reviewType,
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        tokenEconomyActive: result.token_economy_active,
        reusedReviewEvidence: reviewReuseResult.reused,
        reusedReceiptPath: reviewReuseResult.receiptPath,
        reusedReviewerExecutionMode: reviewReuseResult.reviewerExecutionMode,
        reusedReviewerIdentity: reviewReuseResult.reviewerIdentity,
        outputLines
    };
}
