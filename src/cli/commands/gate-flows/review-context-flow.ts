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
    buildReviewVerdictTokenSet,
    extractReviewVerdictSectionTokenMatch,
    normalizeReviewReceiptReviewerProvenance,
    normalizeReviewerExecutionMode,
    type ReviewReceipt,
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
    getClassificationConfig
} from '../../../gates/classify-change';
import { matchAnyRegex } from '../../../gate-runtime/text-utils';
import {
    assertReviewTreeStateFresh
} from '../../../gates/review-tree-state';
import {
    resolveReviewerPromptArtifactBinding
} from '../../../gates/review-prompt-artifact';
import {
    describeHistoricalReviewRecordedSource,
    normalizeReceiptSha256,
    validateHistoricalReviewReuseCandidate,
    type HistoricalReviewReuseCandidate
} from '../../../gates/review-reuse-validation';
import {
    validateStrictReusedReviewEvidence
} from '../../../gates/review-reuse-telemetry';
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
import { REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION } from '../../../gate-runtime/reviewer-session-contract';

interface ReviewReuseResult {
    reused: boolean;
    receiptPath: string | null;
    reviewerExecutionMode: string | null;
    reviewerIdentity: string | null;
    reason: string;
}

interface CurrentPassReviewEvidenceResult {
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

interface CompileEvidenceSummary {
    status: string | null;
    preflightPath: string | null;
    preflightHashSha256: string | null;
}

const TEST_DELTA_DOMAIN_REUSE_REVIEW_TYPES = new Set([
    'db',
    'security',
    'refactor',
    'api',
    'performance',
    'infra',
    'dependency'
]);

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

function getRuleContextArtifactPathFromContext(reviewContext: Record<string, unknown>): string | null {
    if (!isRecord(reviewContext.rule_context)) {
        return null;
    }
    const artifactPath = String(
        reviewContext.rule_context.artifact_path
        || reviewContext.rule_context.artifactPath
        || ''
    ).trim();
    return artifactPath || null;
}

function getTokenEconomyActiveFromContext(reviewContext: Record<string, unknown>): boolean {
    if (typeof reviewContext.token_economy_active === 'boolean') {
        return reviewContext.token_economy_active;
    }
    if (isRecord(reviewContext.token_economy) && typeof reviewContext.token_economy.active === 'boolean') {
        return reviewContext.token_economy.active;
    }
    return false;
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

function normalizeOptionalSha256(value: unknown): string | null {
    return normalizeReceiptSha256(value);
}

function normalizeOptionalPath(value: unknown): string | null {
    const text = String(value || '').trim();
    return text ? gateHelpers.normalizePath(text).toLowerCase() : null;
}

function readJsonRecord(pathToRead: string): Record<string, unknown> | null {
    if (!fs.existsSync(pathToRead) || !fs.statSync(pathToRead).isFile()) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(pathToRead, 'utf8')) as unknown;
        return isRecord(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function getScopedDiffMetadata(reviewContext: Record<string, unknown>): Record<string, unknown> | null {
    if (!isRecord(reviewContext.scoped_diff) || !isRecord(reviewContext.scoped_diff.metadata)) {
        return null;
    }
    return reviewContext.scoped_diff.metadata;
}

function hasFullDiffFallbackScopedDiff(reviewContext: Record<string, unknown>): boolean {
    const metadata = getScopedDiffMetadata(reviewContext);
    return metadata?.fallback_to_full_diff === true;
}

function getCandidateTestDeltaFiles(
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>
): string[] {
    const nonTestOrDocFiles = new Set([
        ...codeScopeFingerprint.non_test_changed_files,
        ...codeScopeFingerprint.docs_only_changed_files
    ]);
    return codeScopeFingerprint.all_changed_files
        .filter((filePath) => !nonTestOrDocFiles.has(filePath))
        .sort();
}

function findSensitiveTestDeltaFiles(repoRoot: string, testDeltaFiles: readonly string[]): string[] {
    if (testDeltaFiles.length === 0) {
        return [];
    }
    const config = getClassificationConfig(repoRoot);
    const sensitiveRegexes = [
        ...config.db_trigger_regexes,
        ...config.security_trigger_regexes,
        ...config.api_trigger_regexes,
        ...config.dependency_trigger_regexes,
        ...config.infra_trigger_regexes,
        ...config.performance_trigger_regexes,
        ...config.fast_path_sensitive_regexes,
        '(Config|Settings|Options|Schema|Contract|Dto|DTO)[^/]*\\.(java|kt|ts|tsx|js|jsx|py|go|cs|rb|php|json|ya?ml|toml|xml)$',
        '(^|/)(config|configs?|schemas?|contracts?)(/|$)',
        '(^|/)[^/]*(config|settings|paths)[^/]*\\.(json|ya?ml|toml|xml)$'
    ];
    return testDeltaFiles.filter((filePath) => (
        gateHelpers.testPathPrefix(filePath, config.protected_control_plane_roots)
        || matchAnyRegex(filePath, sensitiveRegexes, {
            skipInvalidRegex: true,
            caseInsensitive: true
        })
    ));
}

function evaluateTestOnlyDeltaReuseEligibility(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    preflightPayload: Record<string, unknown>;
    currentReviewContext: Record<string, unknown>;
    codeScopeFingerprint: ReturnType<typeof computeReviewReuseCodeScopeFingerprint>;
    timelineEventsSummary?: TimelineEventsSummaryResult | null;
}): { allowed: boolean; reason: string } {
    const reviewType = normalizeLowerText(options.reviewType);
    if (!TEST_DELTA_DOMAIN_REUSE_REVIEW_TYPES.has(reviewType)) {
        return { allowed: false, reason: 'review type is not eligible for test-only delta domain reuse' };
    }
    if (!hasFullDiffFallbackScopedDiff(options.currentReviewContext)) {
        return { allowed: false, reason: 'current review context is not a full-diff fallback scoped context' };
    }
    if (options.codeScopeFingerprint.non_test_changed_files.length === 0) {
        return { allowed: false, reason: 'current preflight has no non-test code scope to compare with prior review evidence' };
    }
    const testDeltaFiles = getCandidateTestDeltaFiles(options.codeScopeFingerprint);
    if (testDeltaFiles.length === 0) {
        return { allowed: false, reason: 'current preflight has no test-only delta files' };
    }
    const sensitiveTestDeltaFiles = findSensitiveTestDeltaFiles(options.repoRoot, testDeltaFiles);
    if (sensitiveTestDeltaFiles.length > 0) {
        return {
            allowed: false,
            reason: `test-only delta includes sensitive path(s): ${sensitiveTestDeltaFiles.slice(0, 8).join(', ')}`
        };
    }
    const reviewsRoot = path.dirname(options.preflightPath);
    const codeReviewContextPath = path.join(reviewsRoot, `${options.taskId}-code-review-context.json`);
    const currentCodeReviewEvidence = tryAcceptCurrentPassReviewEvidence({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: 'code',
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        reviewContextPath: codeReviewContextPath,
        timelineEventsSummary: options.timelineEventsSummary
    });
    if (!currentCodeReviewEvidence.accepted) {
        return {
            allowed: false,
            reason: `current-cycle code review reuse evidence is not accepted: ${currentCodeReviewEvidence.reason}`
        };
    }
    if (!currentCodeReviewEvidence.reusedExistingReview) {
        return {
            allowed: false,
            reason: 'current-cycle code review evidence is fresh rather than reused'
        };
    }
    return {
        allowed: true,
        reason: `only test files changed after accepted code scope; current code reuse receipt=${currentCodeReviewEvidence.receiptPath || 'unknown'}; test files=${testDeltaFiles.join(', ')}`
    };
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

function tryAcceptCurrentPassReviewEvidence(options: {
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
    remediationPreservedScopeMismatchReason?: string | null;
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
    const testOnlyDeltaReuseEligibility = evaluateTestOnlyDeltaReuseEligibility({
        repoRoot: options.repoRoot,
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightPath: options.preflightPath,
        preflightPayload: options.preflightPayload,
        currentReviewContext,
        codeScopeFingerprint,
        timelineEventsSummary: options.timelineEventsSummary
    });

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
            currentContextReuseSha256,
            allowTestOnlyDeltaContextMismatch: testOnlyDeltaReuseEligibility.allowed,
            remediationPreservedScopeMismatchReason: options.remediationPreservedScopeMismatchReason || null
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
                evidence.testOnlyDeltaContextMismatch
                    ? `accepted: non-test review reused because ${testOnlyDeltaReuseEligibility.reason}; full-diff fallback context changed, but non-test code scope matches prior independent PASS review`
                    : evidence.remediationPreservedScopeMismatch
                    ? `accepted: non-test review reused because ${evidence.remediationPreservedScopeMismatchReason}; classified remediation preserved this review type despite context/scope hash changes`
                    : evidence.contextHashMatches
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
    reviewReuseBlockedReason?: unknown;
    remediationPreservedScopeMismatchReason?: unknown;
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
    const reviewReuseBlockedReason = String(options.reviewReuseBlockedReason || '').trim();
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
        const outputKV: Record<string, unknown> = {
            outputPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath,
            handoffInstruction: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
            tokenEconomyActive: currentPassReviewEvidence.tokenEconomyActive === true,
            reviewReuseDecision: 'accepted',
            reviewReuseReason: currentPassReviewEvidence.reason,
            currentPassReviewEvidence: true
        };
        const orderedKeys = [
            'outputPath',
            'ruleContextArtifactPath',
            'handoffInstruction',
            'tokenEconomyActive',
            'reviewReuseDecision',
            'reviewReuseReason',
            'currentPassReviewEvidence'
        ];
        if (currentPassReviewEvidence.reusedExistingReview) {
            outputKV.reusedReviewEvidence = true;
            outputKV.reusedReceiptPath = currentPassReviewEvidence.receiptPath;
            outputKV.reusedReviewerExecutionMode = currentPassReviewEvidence.reviewerExecutionMode;
            outputKV.reusedReviewerIdentity = currentPassReviewEvidence.reviewerIdentity;
            orderedKeys.push('reusedReviewEvidence', 'reusedReceiptPath', 'reusedReviewerExecutionMode', 'reusedReviewerIdentity');
        }
        return {
            reviewType,
            outputPath: currentPassReviewEvidence.reviewContextPath,
            ruleContextArtifactPath: currentPassReviewEvidence.ruleContextArtifactPath || '',
            tokenEconomyActive: currentPassReviewEvidence.tokenEconomyActive === true,
            reusedReviewEvidence: currentPassReviewEvidence.reusedExistingReview,
            reusedReceiptPath: currentPassReviewEvidence.reusedExistingReview ? currentPassReviewEvidence.receiptPath : null,
            reusedReviewerExecutionMode: currentPassReviewEvidence.reusedExistingReview
                ? currentPassReviewEvidence.reviewerExecutionMode
                : null,
            reusedReviewerIdentity: currentPassReviewEvidence.reusedExistingReview
                ? currentPassReviewEvidence.reviewerIdentity
                : null,
            outputLines: buildKeyValueOutputLines(outputKV, orderedKeys)
        };
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
        }
    } catch {
        // Keep build-review-context resilient even when telemetry cannot be emitted.
    }

    const outputKV: Record<string, unknown> = {
        outputPath: result.output_path,
        ruleContextArtifactPath: result.rule_context.artifact_path,
        handoffInstruction: REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
        tokenEconomyActive: result.token_economy_active,
        reviewReuseDecision: reviewReuseResult.reused ? 'accepted' : 'rejected',
        reviewReuseReason: reviewReuseResult.reason,
        currentPassReviewEvidence: currentPassReviewEvidence?.accepted === true ? true : 'rejected',
        currentPassReviewEvidenceReason: reviewReuseBlockedReason || currentPassReviewEvidence?.reason || 'current PASS reuse check not run'
    };
    const orderedKeys = [
        'outputPath',
        'ruleContextArtifactPath',
        'handoffInstruction',
        'tokenEconomyActive',
        'reviewReuseDecision',
        'reviewReuseReason',
        'currentPassReviewEvidence',
        'currentPassReviewEvidenceReason'
    ];
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
