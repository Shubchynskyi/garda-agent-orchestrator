import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    normalizeCompatibilityReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../../../gate-runtime/review-context';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../../gate-runtime/task-events';
import { fileSha256 } from '../../../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync
} from '../../../../gate-runtime/lifecycle-events';
import * as gateHelpers from '../../../../gates/shared/helpers';
import { normalizePath } from '../../../../gates/shared/helpers';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../../gates/review/review-dependencies';
import { resolveCanonicalReviewContextPath } from '../../../../gates/review-context/review-context-paths';
import { assertReviewTreeStateFresh } from '../../../../gates/review/review-tree-state';
import { assertReviewLifecycleGuard } from '../../../../gates/review/review-lifecycle-guard';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { createPrepareReviewerLaunchHandler } from './review-launch-prepare-handler';
import { createCompleteReviewerLaunchHandler } from './review-launch-complete-handler';
import { createReviewerDelegationStartedHandler } from './review-launch-delegation-started-handler';

export interface ReviewRoutingLaunchHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('../index').assertExplicitReviewContextRuntimeIdentity;
    assertNoCurrentCycleReviewRecordedBeforeRouting: typeof import('../index').assertNoCurrentCycleReviewRecordedBeforeRouting;
    assertPreparedReviewerLaunchArtifact: typeof import('../index').assertPreparedReviewerLaunchArtifact;
    assertReviewContextContractOrThrow: typeof import('../index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('../index').assertRoutingCompatibility;
    buildCopyPasteReviewerLaunchPrompt: typeof import('../index').buildCopyPasteReviewerLaunchPrompt;
    buildRecordReviewInvocationCommand: typeof import('../index').buildRecordReviewInvocationCommand;
    buildReviewerLaunchBindingSha256: typeof import('../index').buildReviewerLaunchBindingSha256;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getCurrentPreparedReviewerLaunchMismatches: typeof import('../index').getCurrentPreparedReviewerLaunchMismatches;
    getReviewTreeStateLaunchSummary: typeof import('../index').getReviewTreeStateLaunchSummary;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    getReviewerScopedDiffHandoffPaths: typeof import('../index').getReviewerScopedDiffHandoffPaths;
    getStringField: typeof import('../index').getStringField;
    handleRecordReviewInvocation: typeof import('../index').handleRecordReviewInvocation;
    isCurrentCompletedReviewerLaunchArtifact: typeof import('../index').isCurrentCompletedReviewerLaunchArtifact;
    isForbiddenReviewerLaunchAttestationSource: typeof import('../index').isForbiddenReviewerLaunchAttestationSource;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('../index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    normalizeReviewerLaunchAttestationSource: typeof import('../index').normalizeReviewerLaunchAttestationSource;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE;
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    printCopyPasteReviewerLaunchPrompt: typeof import('../index').printCopyPasteReviewerLaunchPrompt;
    readJsonFile: typeof import('../index').readJsonFile;
    readJsonObjectIfPresent: typeof import('../index').readJsonObjectIfPresent;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveProviderLaunchMetadata: typeof import('../index').resolveProviderLaunchMetadata;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
    resolveReviewerDraftOutputPath: typeof import('../index').resolveReviewerDraftOutputPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
    resolveReviewerLaunchInputAttestation: typeof import('../index').resolveReviewerLaunchInputAttestation;
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS: typeof import('../index').REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS;
    snapshotSupersededReviewerLaunchArtifact: typeof import('../index').snapshotSupersededReviewerLaunchArtifact;
    stringSha256: typeof import('../index').stringSha256;
    toReviewerHandoffAbsolutePath: typeof import('../index').toReviewerHandoffAbsolutePath;
}

export function createReviewRoutingLaunchHandlers(deps: ReviewRoutingLaunchHandlerDependencies) {
    const {
        assertExplicitReviewContextRuntimeIdentity,
        assertNoCurrentCycleReviewRecordedBeforeRouting,
        assertReviewContextContractOrThrow,
        assertRoutingCompatibility,
        resolveCanonicalPreflightArtifactPath,
        toReviewerHandoffAbsolutePath
    } = deps;


async function handleRecordReviewRouting(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
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
    const reviewerExecutionMode = normalizeCompatibilityReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (!reviewerExecutionMode) {
        throw new Error("ReviewerExecutionMode is required. Expected 'delegated_subagent'.");
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode !== 'delegated_subagent') {
        throw new Error(
            `ReviewerExecutionMode '${reviewerExecutionMode}' is no longer supported. ` +
            "Mandatory reviews must use 'delegated_subagent'."
        );
    }
    if (reviewerIdentity.startsWith('self:')) {
        throw new Error('Delegated review routing cannot use a self-scoped reviewer identity.');
    }
    if (!reviewerIdentity.startsWith('agent:')) {
        throw new Error("Delegated review routing requires an agent-scoped reviewer identity (prefix 'agent:').");
    }
    if (reviewerFallbackReason) {
        throw new Error(
            'ReviewerFallbackReason is not supported for delegated_subagent review routing. ' +
            'Remove --reviewer-fallback-reason and rerun the delegated reviewer flow.'
        );
    }
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    assertRequiredUpstreamReviewDependencies({
        taskId,
        preflightPath,
        preflightPayload,
        reviewType,
        timelineEvents,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertNoCurrentCycleReviewRecordedBeforeRouting(timelineEvents, reviewType);

    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewContextContractOrThrow({
        taskId,
        reviewType,
        contextPath,
        reviewContext: parsedReviewContext,
        preflightPath,
        preflightSha256,
        preflightPayload,
        requireStrictBindingMetadata: !!options.reviewContextPath
    });
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-review-routing'
    });
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const runtimeIdentity = assertExplicitReviewContextRuntimeIdentity({
        repoRoot,
        taskId,
        reviewType,
        contextPath,
        reviewerRouting: currentRouting,
        taskModePath: String(options.taskModePath || '').trim()
    });
    assertRoutingCompatibility({
        reviewType,
        runtimeIdentity,
        currentRouting,
        reviewerExecutionMode,
        reviewerFallbackReason
    });

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
    let routingUpdate = {
        updated: false,
        contextSha256: null as string | null
    };
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    let routingError: unknown = null;
    try {
        routingUpdate = applyReviewerRoutingMetadata(contextPath, {
            actualExecutionMode: reviewerExecutionMode,
            reviewerSessionId: reviewerIdentity,
            fallbackReason: reviewerFallbackReason
        });
        const routedEvent = await emitReviewerDelegationRoutedEventAsync(
            orchestratorRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewerFallbackReason
        );
        if (!routedEvent || taskEventAppendHasBlockingFailure(routedEvent, false)) {
            routingError = new Error(
                `Review routing requires REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'. ` +
                'The lifecycle event could not be persisted.'
            );
        }
    } catch (error: unknown) {
        routingError = error;
    }
    if (routingError !== null) {
        try {
            restoreReviewerRoutingMetadata(contextPath, previousRoutingUpdate);
        } catch {
            // Best-effort rollback only.
        }
        throw routingError;
    }
    console.log(
        `REVIEW_ROUTING_RECORDED: ${reviewType} ` +
        `(Context: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}, Sha256: ${routingUpdate.contextSha256 || 'n/a'})`
    );
}




    const handlePrepareReviewerLaunch = createPrepareReviewerLaunchHandler(deps);
    const handleCompleteReviewerLaunch = createCompleteReviewerLaunchHandler(deps);
    const handleRecordReviewerDelegationStarted = createReviewerDelegationStartedHandler(deps);

    return {
        handleRecordReviewRouting,
        handlePrepareReviewerLaunch,
        handleRecordReviewerDelegationStarted,
        handleCompleteReviewerLaunch
    };
}
