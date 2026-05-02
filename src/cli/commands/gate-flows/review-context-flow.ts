import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewContext,
    resolveContextOutputPath,
    resolveReviewSkillId,
    resolveScopedDiffMetadataPath
} from '../../../gates/build-review-context';
import {
    emitReviewPhaseStartedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import {
    type ReviewContextSectionsResult
} from '../../../gate-runtime/review-context';
import {
    emitSkillReferenceLoadedEventAsync,
    emitSkillSelectedEventAsync
} from '../../../runtime/skill-telemetry';
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
    computeReviewReuseCodeScopeFingerprint,
    computeReviewRelevantScopeFingerprint,
    computeReviewContextReuseHash,
    isNonTestReviewScope
} from '../../../gates/review-reuse';
import {
    describeHistoricalReviewRecordedSource,
    normalizeReceiptSha256,
    validateHistoricalReviewReuseCandidate,
    type HistoricalReviewReuseCandidate
} from '../../../gates/review-reuse-validation';
import {
    materializeReusedReviewEvidence
} from '../../../gates/review-reuse-materialization';
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
    reason: string;
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

function isRecord(value: unknown): value is Record<string, unknown> {
    return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeLowerText(value: unknown): string {
    return String(value || '').trim().toLowerCase();
}

function getReviewTreeStateSha256FromContext(reviewContext: Record<string, unknown>): string | null {
    if (!isRecord(reviewContext.tree_state)) {
        return null;
    }
    const normalized = String(
        reviewContext.tree_state.tree_state_sha256
        || reviewContext.tree_state.treeStateSha256
        || ''
    ).trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(normalized) ? normalized : null;
}

function resolveHistoricalArtifactPath(repoRoot: string, rawPath: unknown, fallbackPath: string): string {
    const text = String(rawPath || '').trim();
    if (!text) {
        return fallbackPath;
    }
    return path.isAbsolute(text) ? text : path.resolve(repoRoot, text);
}

function collectHistoricalReviewReuseCandidates(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    receiptPath: string;
    artifactPath: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    latestCompilePassSequence: number;
}): { candidates: HistoricalReviewReuseCandidate[]; latestReceiptReadFailure: string | null } {
    const candidates: HistoricalReviewReuseCandidate[] = [];
    let latestReceiptReadFailure: string | null = null;
    if (fs.existsSync(options.receiptPath) && fs.statSync(options.receiptPath).isFile()) {
        try {
            candidates.push({
                telemetryReceiptPath: options.receiptPath,
                sourceReceiptPath: options.receiptPath,
                sourceReceiptSha256: String(gateHelpers.fileSha256(options.receiptPath) || '').trim().toLowerCase() || null,
                sourceArtifactPath: options.artifactPath,
                sourceKind: 'latest_receipt',
                sourceEvent: null,
                sourceDescription: `latest mutable receipt ${gateHelpers.normalizePath(options.receiptPath)}`
            });
        } catch {
            latestReceiptReadFailure = 'latest mutable receipt is not valid JSON';
        }
    } else {
        latestReceiptReadFailure = 'no prior review receipt exists for this review type';
    }

    for (let index = options.timelineEvents.length - 1; index >= 0; index -= 1) {
        const event = options.timelineEvents[index];
        if (
            event.sequence >= options.latestCompilePassSequence
            || event.event_type !== 'REVIEW_RECORDED'
            || !isRecord(event.details)
        ) {
            continue;
        }
        const details = event.details;
        if (
            normalizeLowerText(details.review_type ?? details.reviewType) !== normalizeLowerText(options.reviewType)
            || (String(details.task_id ?? details.taskId ?? '').trim()
                && String(details.task_id ?? details.taskId).trim() !== options.taskId)
        ) {
            continue;
        }
        candidates.push({
            telemetryReceiptPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.receipt_path ?? details.receiptPath,
                options.receiptPath
            ),
            sourceReceiptPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.receipt_snapshot_path ?? details.receiptSnapshotPath,
                ''
            ),
            sourceReceiptSha256: normalizeReceiptSha256(
                details.receipt_snapshot_sha256 ?? details.receiptSnapshotSha256
            ),
            sourceArtifactPath: resolveHistoricalArtifactPath(
                options.repoRoot,
                details.review_artifact_snapshot_path ?? details.reviewArtifactSnapshotPath,
                options.artifactPath
            ),
            sourceKind: 'historical_review_recorded',
            sourceEvent: event,
            sourceDescription: describeHistoricalReviewRecordedSource(event)
        });
    }

    return { candidates, latestReceiptReadFailure };
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
    const reject = (reason: string): ReviewReuseResult => ({
        reused: false,
        receiptPath: null,
        reviewerExecutionMode: null,
        reviewerIdentity: null,
        reason
    });
    const nonTestReviewScope = isNonTestReviewScope(options.reviewType);
    const codeScopeFingerprint = computeReviewReuseCodeScopeFingerprint(
        options.reviewType,
        options.preflightPayload,
        options.repoRoot
    );
    if (codeScopeFingerprint.missing_non_test_files.length > 0) {
        return reject(`missing non-test scope file(s): ${codeScopeFingerprint.missing_non_test_files.join(', ')}`);
    }
    const reviewScopeFingerprint = computeReviewRelevantScopeFingerprint(options.preflightPayload, options.repoRoot);
    if (reviewScopeFingerprint.missing_review_relevant_files.length > 0) {
        return reject(`missing review-relevant scope file(s): ${reviewScopeFingerprint.missing_review_relevant_files.join(', ')}`);
    }

    const reviewsRoot = path.dirname(options.preflightPath);
    const artifactPath = path.join(reviewsRoot, `${options.taskId}-${options.reviewType}.md`);
    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    const compileEvidence = readCompileEvidenceSummary(options.repoRoot, options.taskId);
    const currentPreflightHash = String(gateHelpers.fileSha256(options.preflightPath) || '').trim().toLowerCase() || null;
    const normalizedPreflightPath = gateHelpers.normalizePath(options.preflightPath);
    if (
        compileEvidence.status !== 'PASSED'
        || compileEvidence.preflightPath !== normalizedPreflightPath
        || compileEvidence.preflightHashSha256 !== currentPreflightHash
    ) {
        return reject('compile evidence is missing, failed, or bound to a different preflight artifact');
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
        return reject('current review cycle already has routing or review-recorded evidence for this review type');
    }

    const { candidates, latestReceiptReadFailure } = collectHistoricalReviewReuseCandidates({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        receiptPath,
        artifactPath,
        timelineEvents,
        latestCompilePassSequence
    });
    if (candidates.length === 0) {
        return reject(latestReceiptReadFailure || 'no historical review evidence exists for this review type');
    }

    const requiredReviews = options.preflightPayload.required_reviews
        && typeof options.preflightPayload.required_reviews === 'object'
        && !Array.isArray(options.preflightPayload.required_reviews)
        ? options.preflightPayload.required_reviews as Record<string, unknown>
        : {};
    const performanceSupportFiles = codeScopeFingerprint.performance_support_changed_files || [];
    const delegatesPerformanceSupportToPerformanceReview = (
        options.reviewType === 'code'
        && performanceSupportFiles.length > 0
        && requiredReviews.performance === true
    );
    if (
        options.reviewType === 'code'
        && performanceSupportFiles.length > 0
        && requiredReviews.performance !== true
    ) {
        return reject(
            'code review reuse saw non-runtime performance support file(s), but performance review is not required: ' +
            `${performanceSupportFiles.join(', ')}`
        );
    }
    const currentCodeScopeSha256 = normalizeReceiptSha256(codeScopeFingerprint.code_scope_sha256);
    const hasCurrentCodeScope = codeScopeFingerprint.non_test_changed_files.length > 0;
    const hasCurrentReviewScope = reviewScopeFingerprint.review_relevant_changed_files.length > 0;
    const currentReviewContext = JSON.parse(fs.readFileSync(options.reviewContextPath, 'utf8')) as Record<string, unknown>;
    const currentReviewContextSha256 = String(gateHelpers.fileSha256(options.reviewContextPath) || '').trim().toLowerCase() || null;
    const currentReviewTreeStateSha256 = getReviewTreeStateSha256FromContext(currentReviewContext);
    const currentContextReuseSha256 = String(computeReviewContextReuseHash(currentReviewContext) || '').trim().toLowerCase() || null;

    const candidateRejections: string[] = [];
    for (const candidate of candidates) {
        const validation = validateHistoricalReviewReuseCandidate({
            candidate,
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            previousReviewContextReuseSha256: options.previousReviewContextReuseSha256,
            timelineEvents,
            latestCompilePassSequence,
            nonTestReviewScope,
            codeScopeFingerprint,
            reviewScopeFingerprint,
            hasCurrentCodeScope,
            hasCurrentReviewScope,
            currentCodeScopeSha256,
            currentReviewContextSha256,
            currentContextReuseSha256
        });
        if (!validation.accepted) {
            candidateRejections.push(`${candidate.sourceDescription}: ${validation.reason}`);
            continue;
        }
        const evidence = validation.evidence;
        const materialized = await materializeReusedReviewEvidence({
            repoRoot: options.repoRoot,
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPayload: options.preflightPayload,
            reviewContextPath: options.reviewContextPath,
            artifactPath,
            receiptPath,
            nonTestReviewScope,
            codeScopeFingerprint,
            reviewScopeFingerprint,
            currentPreflightHash,
            currentReviewContextSha256,
            currentReviewTreeStateSha256,
            currentContextReuseSha256,
            candidate,
            reusedFromReceiptPath: evidence.reusedFromReceiptPath,
            reusedFromReceiptSha256: evidence.reusedFromReceiptSha256,
            receipt: evidence.receipt,
            reviewerExecutionMode: evidence.reviewerExecutionMode,
            reviewerIdentity: evidence.reviewerIdentity,
            historicalReviewerProvenance: evidence.historicalReviewerProvenance,
            expectedContextSha256: evidence.expectedContextSha256,
            expectedContextReuseSha256: evidence.expectedContextReuseSha256,
            expectedReviewTreeStateSha256: evidence.expectedReviewTreeStateSha256,
            expectedReviewScopeSha256: evidence.expectedReviewScopeSha256,
            expectedCodeScopeSha256: evidence.expectedCodeScopeSha256,
            historicalReviewArtifactSha256: evidence.historicalReviewArtifactSha256,
            artifactText: evidence.artifactText
        });
        if (!materialized.materialized) {
            candidateRejections.push(
                `${candidate.sourceDescription}: ${materialized.reason || 'current-cycle review reuse evidence could not be materialized'}`
            );
            continue;
        }
        const latestReceiptRejection = candidate.sourceKind === 'historical_review_recorded'
            ? candidateRejections.find((entry) => entry.startsWith('latest mutable receipt '))
            : null;
        return {
            reused: true,
            receiptPath: gateHelpers.normalizePath(receiptPath),
            reviewerExecutionMode: evidence.reviewerExecutionMode,
            reviewerIdentity: evidence.reviewerIdentity,
            reason: (
                evidence.contextHashMatches
                    ? 'accepted: exact review context hash and scope evidence match prior independent PASS review'
                    : 'accepted: review context reuse hash and scope evidence match prior independent PASS review'
            ) + `; matched ${candidate.sourceDescription} from ${gateHelpers.normalizePath(evidence.verifiedReceiptPath || candidate.sourceReceiptPath)}` + (
                latestReceiptRejection
                    ? `; rejected latest mutable receipt: ${latestReceiptRejection}`
                    : ''
            ) + (
                delegatesPerformanceSupportToPerformanceReview
                    ? `; non-runtime performance support file(s) delegated to required performance review: ${performanceSupportFiles.join(', ')}`
                    : ''
            )
        };
    }
    const rejectionSummary = candidateRejections.slice(0, 4).join('; ');
    return reject(
        `no reusable historical PASS review evidence matched current scope` +
        (latestReceiptReadFailure ? `; latest receipt: ${latestReceiptReadFailure}` : '') +
        (rejectionSummary ? `; checked candidates: ${rejectionSummary}` : '')
    );
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
    if (!gateHelpers.isPathRealpathInsideRoot(preflightPath, repoRoot)) {
        throw new Error(
            `PreflightPath must resolve inside repo root without symlink or junction escape: ` +
            `${gateHelpers.normalizePath(preflightPath)}.`
        );
    }
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
    if (fs.existsSync(outputPath) && fs.statSync(outputPath).isFile()) {
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
        reviewerIdentity: null,
        reason: 'reuse check not run'
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
        tokenEconomyActive: result.token_economy_active,
        reviewReuseDecision: reviewReuseResult.reused ? 'accepted' : 'rejected',
        reviewReuseReason: reviewReuseResult.reason
    };
    const orderedKeys = ['outputPath', 'ruleContextArtifactPath', 'tokenEconomyActive', 'reviewReuseDecision', 'reviewReuseReason'];
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
