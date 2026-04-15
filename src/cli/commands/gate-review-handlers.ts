import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    extractReviewVerdictToken,
    normalizeReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../gate-runtime/review-context';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256 } from '../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync,
    emitReviewRecordedEventAsync
} from '../../gate-runtime/lifecycle-events';
import { writeReviewArtifactJson, writeReviewArtifactText } from '../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../gates/helpers';
import { normalizePath } from '../../gates/helpers';
import { REVIEW_CONTRACTS } from '../../gates/required-reviews-check';
import {
    assertRequiredUpstreamReviewDependencies,
    type ReviewDependencyTimelineEvent
} from '../../gates/review-dependencies';
import {
    computeCodeReviewScopeFingerprint,
    computeReviewContextReuseHash
} from '../../gates/review-reuse';
import { resolveCanonicalReviewContextPath } from '../../gates/review-context-paths';
import { getReviewContextContractViolations } from '../../gates/review-context-contract';
import { assertReviewLifecycleGuard } from '../../gates/review-lifecycle-guard';
import {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from './gates';
import {
    parseOptions,
    normalizePathValue
} from './cli-helpers';
import {
    type ParsedOptionsRecord,
    removeArtifactIfExists
} from './shared-command-utils';

export async function handleRequiredReviewsCheck(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--code-review-verdict': { key: 'codeReviewVerdict', type: 'string' },
        '--db-review-verdict': { key: 'dbReviewVerdict', type: 'string' },
        '--security-review-verdict': { key: 'securityReviewVerdict', type: 'string' },
        '--refactor-review-verdict': { key: 'refactorReviewVerdict', type: 'string' },
        '--api-review-verdict': { key: 'apiReviewVerdict', type: 'string' },
        '--test-review-verdict': { key: 'testReviewVerdict', type: 'string' },
        '--performance-review-verdict': { key: 'performanceReviewVerdict', type: 'string' },
        '--infra-review-verdict': { key: 'infraReviewVerdict', type: 'string' },
        '--dependency-review-verdict': { key: 'dependencyReviewVerdict', type: 'string' },
        '--skip-reviews': { key: 'skipReviews', type: 'string' },
        '--skip-reason': { key: 'skipReason', type: 'string' },
        '--override-artifact-path': { key: 'overrideArtifactPath', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--review-evidence-path': { key: 'reviewEvidencePath', type: 'string' },
        '--no-op-artifact-path': { key: 'noOpArtifactPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runRequiredReviewsCheckCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

interface ResolvedCanonicalReviewPaths {
    preflightPath: string;
    reviewsRoot: string;
    artifactPath: string;
    contextPath: string;
}

interface ParsedReviewerIdentity {
    reviewerExecutionMode: NonNullable<ReturnType<typeof normalizeReviewerExecutionMode>>;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
}

interface ReviewArtifactRollbackState {
    existed: boolean;
    content: string | null;
}

interface ResolvedReviewOutputInput {
    reviewContent: string;
    reviewOutputPath: string;
    reviewOutputMode: 'path' | 'stdin';
    reviewOutputSourcePath: string | null;
}

function resolveCanonicalReviewPaths(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    preflightPathValue: unknown,
    reviewContextPathValue: unknown
): ResolvedCanonicalReviewPaths {
    const canonicalPreflightPath = gateHelpers.joinOrchestratorPath(
        repoRoot,
        path.join('runtime', 'reviews', `${taskId}-preflight.json`)
    );
    const resolvedPreflightPath = gateHelpers.resolvePathInsideRepo(String(preflightPathValue || ''), repoRoot, { allowMissing: true });
    if (!resolvedPreflightPath) {
        throw new Error('PreflightPath is required.');
    }
    if (resolvedPreflightPath !== canonicalPreflightPath) {
        throw new Error(
            `PreflightPath must point to the canonical preflight artifact for '${taskId}': ` +
            `${normalizePath(canonicalPreflightPath)}.`
        );
    }
    const preflightPath = resolvedPreflightPath;
    if (!fs.existsSync(preflightPath) || !fs.statSync(preflightPath).isFile()) {
        throw new Error(`Preflight artifact not found: ${preflightPath}`);
    }

    const reviewsRoot = path.dirname(preflightPath);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: reviewContextPathValue ? String(reviewContextPathValue) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    return {
        preflightPath,
        reviewsRoot,
        artifactPath,
        contextPath
    };
}

function parseReviewerIdentity(options: ParsedOptionsRecord, modeRequiredMessage: string): ParsedReviewerIdentity {
    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;

    if (!reviewerExecutionMode) {
        if (rawReviewerExecutionMode) {
            throw new Error(
                `ReviewerExecutionMode '${rawReviewerExecutionMode}' is invalid. ` +
                "Expected one of 'delegated_subagent' or 'same_agent_fallback'."
            );
        }
        throw new Error(modeRequiredMessage);
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review evidence cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review evidence requires an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (!reviewerIdentity.startsWith('self:')) {
        throw new Error("Fallback review evidence requires a self-scoped reviewer identity (prefix 'self:').");
    }

    return {
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    };
}

function getCanonicalReviewOutputArtifactPath(reviewsRoot: string, taskId: string, reviewType: string): string {
    return path.join(reviewsRoot, `${taskId}-${reviewType}-review-output.md`);
}

export let readReviewOutputFromStdin = async (): Promise<string> => {
    if (!process.stdin || process.stdin.isTTY) {
        throw new Error('ReviewOutputStdin requires piped stdin input.');
    }
    process.stdin.setEncoding('utf8');
    let content = '';
    for await (const chunk of process.stdin) {
        content += String(chunk);
    }
    return content;
};

async function resolveReviewOutputInput(
    options: ParsedOptionsRecord,
    repoRoot: string,
    reviewsRoot: string,
    taskId: string,
    reviewType: string
): Promise<ResolvedReviewOutputInput> {
    const useReviewOutputStdin = options.reviewOutputStdin === true;
    const rawReviewOutputPath = String(options.reviewOutputPath || '').trim();
    const hasReviewOutputPath = rawReviewOutputPath.length > 0;
    if (useReviewOutputStdin === hasReviewOutputPath) {
        throw new Error(
            "Review output requires exactly one input source. Provide either '--review-output-path' or '--review-output-stdin'."
        );
    }

    const reviewOutputArtifactPath = getCanonicalReviewOutputArtifactPath(reviewsRoot, taskId, reviewType);
    let reviewContent = '';
    let reviewOutputSourcePath: string | null = null;
    if (useReviewOutputStdin) {
        reviewContent = await readReviewOutputFromStdin();
    } else {
        const resolvedReviewOutputPath = gateHelpers.resolvePathInsideRepo(rawReviewOutputPath, repoRoot, { allowMissing: true });
        if (!resolvedReviewOutputPath) {
            throw new Error('ReviewOutputPath is required.');
        }
        if (!fs.existsSync(resolvedReviewOutputPath) || !fs.statSync(resolvedReviewOutputPath).isFile()) {
            throw new Error(`Review output not found: ${normalizePath(resolvedReviewOutputPath)}.`);
        }
        reviewOutputSourcePath = resolvedReviewOutputPath;
        reviewContent = fs.readFileSync(resolvedReviewOutputPath, 'utf8');
    }

    // Persist raw reviewer input before verdict extraction so direct ingest cannot bypass the audited file path.
    writeReviewArtifactText(reviewOutputArtifactPath, reviewContent);
    if (!reviewContent.trim()) {
        throw new Error(`Review output is empty: ${normalizePath(reviewOutputArtifactPath)}.`);
    }

    return {
        reviewContent,
        reviewOutputPath: reviewOutputArtifactPath,
        reviewOutputMode: useReviewOutputStdin ? 'stdin' : 'path',
        reviewOutputSourcePath: reviewOutputSourcePath && normalizePath(reviewOutputSourcePath) !== normalizePath(reviewOutputArtifactPath)
            ? reviewOutputSourcePath
            : null
    };
}

function captureReviewArtifactRollbackState(artifactPath: string): ReviewArtifactRollbackState {
    if (!fs.existsSync(artifactPath) || !fs.statSync(artifactPath).isFile()) {
        return {
            existed: false,
            content: null
        };
    }
    return {
        existed: true,
        content: fs.readFileSync(artifactPath, 'utf8')
    };
}

function restoreReviewArtifactFromRollbackState(
    artifactPath: string,
    rollbackState: ReviewArtifactRollbackState
): void {
    if (!rollbackState.existed) {
        removeArtifactIfExists(artifactPath);
        return;
    }
    const content = rollbackState.content || '';
    writeReviewArtifactText(artifactPath, content.endsWith('\n') ? content : `${content}\n`);
}

function assertRoutingCompatibility(
    reviewType: string,
    currentRouting: Record<string, unknown> | null,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerFallbackReason: string | null
): void {
    const capabilityLevel = String(currentRouting?.capability_level || '').trim().toLowerCase();
    const expectedExecutionMode = normalizeReviewerExecutionMode(currentRouting?.expected_execution_mode);
    const fallbackAllowed = currentRouting?.fallback_allowed !== false;
    const fallbackReasonRequired = currentRouting?.fallback_reason_required === true;
    if (
        reviewerExecutionMode === 'delegated_subagent' &&
        (capabilityLevel === 'single_agent_only' || expectedExecutionMode === 'same_agent_fallback')
    ) {
        throw new Error(
            `Review '${reviewType}' cannot record delegated_subagent routing for provider ` +
            `'${String(currentRouting?.source_of_truth || 'unknown')}'. Explicit fallback is required instead.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && !fallbackAllowed) {
        throw new Error(
            `Review '${reviewType}' does not allow same_agent_fallback for provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && fallbackReasonRequired && !reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' requires --reviewer-fallback-reason for same_agent_fallback ` +
            `on provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }
}

function assertReviewContextContractOrThrow(options: {
    taskId: string;
    reviewType: string;
    contextPath: string;
    reviewContext: Record<string, unknown> | null;
    preflightPath: string;
    preflightSha256: string | null;
    requireStrictBindingMetadata?: boolean;
}): void {
    const violations = getReviewContextContractViolations({
        contextPath: options.contextPath,
        reviewContext: options.reviewContext,
        expectedTaskId: options.taskId,
        expectedReviewType: options.reviewType,
        expectedPreflightPath: options.preflightPath,
        expectedPreflightSha256: options.preflightSha256,
        requireReviewType: true,
        requireTaskId: options.requireStrictBindingMetadata === true,
        requirePreflightPath: options.requireStrictBindingMetadata === true,
        requirePreflightSha256: options.requireStrictBindingMetadata === true
    });
    if (violations.length > 0) {
        throw new Error(violations.join(' '));
    }
}

function hasMatchingRoutingEvent(
    timelinePath: string,
    reviewType: string,
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>,
    reviewerIdentity: string,
    reviewerFallbackReason: string | null
): boolean {
    return fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile()
        ? fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .some((line) => {
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                        ? parsed.details as Record<string, unknown>
                        : null;
                    const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
                    return String(parsed.event_type || '').trim().toUpperCase() === 'REVIEWER_DELEGATION_ROUTED'
                        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
                        && normalizeReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
                        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
                        && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''));
                } catch {
                    return false;
                }
            })
        : false;
}

function readDependencyTimelineEvents(timelinePath: string): ReviewDependencyTimelineEvent[] {
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return [];
    }
    return fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .flatMap((line, sequence) => {
            try {
                const parsed = JSON.parse(line) as Record<string, unknown>;
                const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                    ? parsed.details as Record<string, unknown>
                    : null;
                return [{
                    event_type: String(parsed.event_type || '').trim().toUpperCase(),
                    sequence,
                    details
                }];
            } catch {
                return [];
            }
        });
}

async function recordReviewReceiptFromArtifacts(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    preflightPath: string;
    artifactPath: string;
    contextPath: string;
    reviewerExecutionMode: NonNullable<ParsedReviewerIdentity['reviewerExecutionMode']>;
    reviewerIdentity: string;
    reviewerFallbackReason: string | null;
    requireStrictBindingMetadata?: boolean;
}): Promise<string> {
    if (!fs.existsSync(options.artifactPath) || !fs.statSync(options.artifactPath).isFile()) {
        throw new Error(`Review artifact not found: ${options.artifactPath}`);
    }

    const preflight = JSON.parse(fs.readFileSync(options.preflightPath, 'utf8'));
    const preflightSha256 = fileSha256(options.preflightPath);
    const artifactSha256 = fileSha256(options.artifactPath);
    const parsedReviewContext = JSON.parse(fs.readFileSync(options.contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId: options.taskId,
        reviewType: options.reviewType,
        contextPath: options.contextPath,
        reviewContext: parsedReviewContext,
        preflightPath: options.preflightPath,
        preflightSha256,
        requireStrictBindingMetadata: options.requireStrictBindingMetadata
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const currentExecutionMode = normalizeReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== options.reviewerExecutionMode) {
        throw new Error(
            `Review receipt execution mode (${options.reviewerExecutionMode}) must match pre-recorded ` +
            `reviewer_routing.actual_execution_mode (${currentExecutionMode || 'missing'}) in ${normalizePath(options.contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (!currentReviewerSessionId) {
        throw new Error(
            `Review receipts require pre-recorded reviewer_routing.reviewer_session_id in ${normalizePath(options.contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (currentReviewerSessionId !== options.reviewerIdentity) {
        throw new Error(
            `Review receipt reviewer identity (${options.reviewerIdentity}) must match pre-recorded ` +
            `reviewer_routing.reviewer_session_id (${currentReviewerSessionId}).`
        );
    }
    const currentFallbackReason = currentRouting?.fallback_reason != null
        ? String(currentRouting.fallback_reason).trim()
        : '';
    if (
        options.reviewerExecutionMode === 'same_agent_fallback' &&
        currentFallbackReason !== (options.reviewerFallbackReason || '')
    ) {
        throw new Error(
            `Review receipt fallback reason (${options.reviewerFallbackReason || 'missing'}) must match pre-recorded ` +
            `reviewer_routing.fallback_reason (${currentFallbackReason || 'missing'}).`
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(options.repoRoot, path.join('runtime', 'task-events', `${options.taskId}.jsonl`));
    if (!hasMatchingRoutingEvent(
        timelinePath,
        options.reviewType,
        options.reviewerExecutionMode,
        options.reviewerIdentity,
        options.reviewerFallbackReason
    )) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${options.reviewType}' ` +
            `with reviewer '${options.reviewerIdentity}' and execution mode '${options.reviewerExecutionMode}'.`
        );
    }

    const contextSha256 = fileSha256(options.contextPath);
    const receipt = buildReviewReceipt({
        taskId: options.taskId,
        reviewType: options.reviewType,
        preflightSha256,
        scopeSha256: preflight.metrics?.changed_files_sha256 || null,
        codeScopeSha256: options.reviewType === 'code'
            ? computeCodeReviewScopeFingerprint(preflight as Record<string, unknown>, options.repoRoot).code_scope_sha256
            : null,
        reviewContextSha256: contextSha256,
        reviewContextReuseSha256: computeReviewContextReuseHash(parsedReviewContext),
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewerFallbackReason: options.reviewerFallbackReason,
        trustLevel: 'LOCAL_AUDITED'
    });

    const receiptPath = options.artifactPath.replace(/\.md$/, '-receipt.json');
    writeReviewArtifactJson(receiptPath, receipt);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(options.repoRoot, '');
    try {
        const recordedEvent = await emitReviewRecordedEventAsync(orchestratorRoot, options.taskId, options.reviewType, {
            ...receipt,
            receipt_path: normalizePath(receiptPath),
            review_artifact_path: normalizePath(options.artifactPath),
            review_context_path: normalizePath(options.contextPath)
        });
        if (!recordedEvent || (Array.isArray(recordedEvent.warnings) && recordedEvent.warnings.length > 0)) {
            throw new Error(
                `Review receipts require REVIEW_RECORDED telemetry for '${options.reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        removeArtifactIfExists(receiptPath);
        throw error;
    }
    return receiptPath;
}

export async function handleDocImpactGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--behavior-changed': { key: 'behaviorChanged', type: 'boolean' },
        '--docs-updated': { key: 'docsUpdated', type: 'string[]' },
        '--changelog-updated': { key: 'changelogUpdated', type: 'boolean' },
        '--sensitive-scope-reviewed': { key: 'sensitiveScopeReviewed', type: 'boolean' },
        '--sensitive-reviewed': { key: 'sensitiveReviewed', type: 'boolean' },
        '--rationale': { key: 'rationale', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runDocImpactGateCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRecordReviewRouting(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase');
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const contextPath = resolveCanonicalReviewContextPath({
        reviewsRoot,
        taskId,
        reviewType,
        explicitPath: options.reviewContextPath ? String(options.reviewContextPath) : '',
        repoRoot
    });
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (!reviewerExecutionMode) {
        throw new Error("ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'.");
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review routing cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review routing requires an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (!reviewerIdentity.startsWith('self:')) {
        throw new Error("Fallback review routing requires a self-scoped reviewer identity (prefix 'self:').");
    }
    const preflightPath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-preflight.json`));
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath)
    });

    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const capabilityLevel = String(currentRouting?.capability_level || '').trim().toLowerCase();
    const expectedExecutionMode = normalizeReviewerExecutionMode(currentRouting?.expected_execution_mode);
    const fallbackAllowed = currentRouting?.fallback_allowed !== false;
    const fallbackReasonRequired = currentRouting?.fallback_reason_required === true;
    if (
        reviewerExecutionMode === 'delegated_subagent' &&
        (capabilityLevel === 'single_agent_only' || expectedExecutionMode === 'same_agent_fallback')
    ) {
        throw new Error(
            `Review '${reviewType}' cannot record delegated_subagent routing for provider ` +
            `'${String(currentRouting?.source_of_truth || 'unknown')}'. Explicit fallback is required instead.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && !fallbackAllowed) {
        throw new Error(
            `Review '${reviewType}' does not allow same_agent_fallback for provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && fallbackReasonRequired && !reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' requires --reviewer-fallback-reason for same_agent_fallback ` +
            `on provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }

    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    await emitReviewerDelegationRoutedEventAsync(
        orchestratorRoot,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    );
    console.log(
        `REVIEW_ROUTING_RECORDED: ${reviewType} ` +
        `(Context: ${normalizePath(contextPath)}, Sha256: ${routingUpdate.contextSha256 || 'n/a'})`
    );
}

export async function handleRecordReviewResult(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-output-path': { key: 'reviewOutputPath', type: 'string' },
        '--review-output-stdin': { key: 'reviewOutputStdin', type: 'boolean' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-result', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const reviewOutput = await resolveReviewOutputInput(options, repoRoot, path.dirname(preflightPath), taskId, reviewType);
    const reviewContent = reviewOutput.reviewContent;
    const expectedPassVerdict = REVIEW_CONTRACTS.find(([candidate]) => candidate === reviewType)?.[1] || null;
    if (!expectedPassVerdict) {
        throw new Error(`Unsupported review type '${reviewType}' for record-review-result.`);
    }
    const expectedFailVerdict = expectedPassVerdict.replace(/\bPASSED\b/, 'FAILED');
    const verdictToken = extractReviewVerdictToken(reviewContent, expectedPassVerdict, expectedFailVerdict);
    if (!verdictToken) {
        throw new Error(
            `Review output must contain a recognized verdict token for '${reviewType}'. ` +
            `Expected '${expectedPassVerdict}' or '${expectedFailVerdict}'.`
        );
    }

    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath)
    });
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    assertRoutingCompatibility(
        reviewType,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    );

    const artifactRollbackState = captureReviewArtifactRollbackState(artifactPath);
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
    writeReviewArtifactText(artifactPath, reviewContent.endsWith('\n') ? reviewContent : `${reviewContent}\n`);
    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    try {
        const routedEvent = await emitReviewerDelegationRoutedEventAsync(
            orchestratorRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routedEvent || (Array.isArray(routedEvent.warnings) && routedEvent.warnings.length > 0)) {
            throw new Error(
                `Review routing requires REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        try {
            restoreReviewArtifactFromRollbackState(artifactPath, artifactRollbackState);
        } catch {
            // Best-effort rollback only.
        }
        throw error;
    }
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });

    console.log(`REVIEW_RESULT_RECORDED: ${reviewType}`);
    console.log(`ArtifactPath: ${normalizePath(artifactPath)}`);
    console.log(`ContextPath: ${normalizePath(contextPath)}`);
    console.log(`ReceiptPath: ${normalizePath(receiptPath)}`);
    console.log(`ReviewerExecutionMode: ${reviewerExecutionMode}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`ReviewOutputMode: ${reviewOutput.reviewOutputMode}`);
    console.log(`ReviewOutputPath: ${normalizePath(reviewOutput.reviewOutputPath)}`);
    if (reviewOutput.reviewOutputSourcePath) {
        console.log(`ReviewOutputSourcePath: ${normalizePath(reviewOutput.reviewOutputSourcePath)}`);
    }
    console.log(`ContextSha256: ${routingUpdate.contextSha256 || 'n/a'}`);
    if (reviewerFallbackReason) {
        console.log(`ReviewerFallbackReason: ${reviewerFallbackReason}`);
    }
    console.log(`VerdictToken: ${verdictToken}`);
}

export async function handleRecordReviewReceipt(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const { preflightPath, artifactPath, contextPath } = resolveCanonicalReviewPaths(
        repoRoot,
        taskId,
        reviewType,
        options.preflightPath,
        options.reviewContextPath
    );
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'."
    );
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents: readDependencyTimelineEvents(timelinePath)
    });
    const receiptPath = await recordReviewReceiptFromArtifacts({
        repoRoot,
        taskId,
        reviewType,
        preflightPath,
        artifactPath,
        contextPath,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
}
