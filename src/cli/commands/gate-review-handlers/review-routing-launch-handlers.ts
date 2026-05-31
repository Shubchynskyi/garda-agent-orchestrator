import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceiptReviewerProvenance,
    normalizeCompatibilityReviewerExecutionMode,
    restoreReviewerRoutingMetadata
} from '../../../gate-runtime/review-context';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION
} from '../../../gate-runtime/reviewer-session-contract';
import {
    assertValidTaskId,
    taskEventAppendHasBlockingFailure
} from '../../../gate-runtime/task-events';
import { fileSha256 } from '../../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync,
    emitReviewerLaunchPreparedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import {
    writeReviewArtifactJson
} from '../../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../../gates/helpers';
import { normalizePath } from '../../../gates/helpers';
import {
    assertRequiredUpstreamReviewDependencies
} from '../../../gates/review-dependencies';
import { resolveCanonicalReviewContextPath } from '../../../gates/review-context-paths';
import { assertReviewTreeStateFresh } from '../../../gates/review-tree-state';
import { resolveReviewerPromptArtifactBinding } from '../../../gates/review-prompt-artifact';
import { assertReviewLifecycleGuard } from '../../../gates/review-lifecycle-guard';
import { parseOptions, normalizePathValue } from '../cli-helpers';
import {
    type ParsedOptionsRecord,
    removeArtifactIfExists
} from '../shared-command-utils';
import { readDependencyTimelineEvents } from './review-dependency-timeline';
type SupersededReviewerLaunchArtifactSnapshot = import('./index').SupersededReviewerLaunchArtifactSnapshot;

export interface ReviewRoutingLaunchHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('./index').assertExplicitReviewContextRuntimeIdentity;
    assertNoCurrentCycleReviewRecordedBeforeRouting: typeof import('./index').assertNoCurrentCycleReviewRecordedBeforeRouting;
    assertPreparedReviewerLaunchArtifact: typeof import('./index').assertPreparedReviewerLaunchArtifact;
    assertReviewContextContractOrThrow: typeof import('./index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('./index').assertRoutingCompatibility;
    buildCopyPasteReviewerLaunchPrompt: typeof import('./index').buildCopyPasteReviewerLaunchPrompt;
    buildRecordReviewInvocationCommand: typeof import('./index').buildRecordReviewInvocationCommand;
    buildReviewerLaunchBindingSha256: typeof import('./index').buildReviewerLaunchBindingSha256;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('./index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingRoutingEvent: typeof import('./index').findMatchingRoutingEvent;
    getCurrentPreparedReviewerLaunchMismatches: typeof import('./index').getCurrentPreparedReviewerLaunchMismatches;
    getReviewTreeStateLaunchSummary: typeof import('./index').getReviewTreeStateLaunchSummary;
    getReviewTreeStateSha256: typeof import('./index').getReviewTreeStateSha256;
    getReviewerScopedDiffHandoffPaths: typeof import('./index').getReviewerScopedDiffHandoffPaths;
    getStringField: typeof import('./index').getStringField;
    handleRecordReviewInvocation: typeof import('./index').handleRecordReviewInvocation;
    isCurrentCompletedReviewerLaunchArtifact: typeof import('./index').isCurrentCompletedReviewerLaunchArtifact;
    isForbiddenReviewerLaunchAttestationSource: typeof import('./index').isForbiddenReviewerLaunchAttestationSource;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('./index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    normalizeReviewerLaunchAttestationSource: typeof import('./index').normalizeReviewerLaunchAttestationSource;
    parseReviewerIdentity: typeof import('./index').parseReviewerIdentity;
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE: typeof import('./index').PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE;
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('./index').PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    printCopyPasteReviewerLaunchPrompt: typeof import('./index').printCopyPasteReviewerLaunchPrompt;
    readJsonFile: typeof import('./index').readJsonFile;
    readJsonObjectIfPresent: typeof import('./index').readJsonObjectIfPresent;
    resolveCanonicalPreflightArtifactPath: typeof import('./index').resolveCanonicalPreflightArtifactPath;
    resolveProviderLaunchMetadata: typeof import('./index').resolveProviderLaunchMetadata;
    resolveReviewerHandoffBindings: typeof import('./index').resolveReviewerHandoffBindings;
    resolveReviewerDraftOutputPath: typeof import('./index').resolveReviewerDraftOutputPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('./index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('./index').resolveReviewerLaunchInputArtifactPath;
    resolveReviewerLaunchInputAttestation: typeof import('./index').resolveReviewerLaunchInputAttestation;
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS: typeof import('./index').REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS;
    snapshotSupersededReviewerLaunchArtifact: typeof import('./index').snapshotSupersededReviewerLaunchArtifact;
    stringSha256: typeof import('./index').stringSha256;
    toReviewerHandoffAbsolutePath: typeof import('./index').toReviewerHandoffAbsolutePath;
}

export function createReviewRoutingLaunchHandlers(deps: ReviewRoutingLaunchHandlerDependencies) {
    const {
        assertExplicitReviewContextRuntimeIdentity,
        assertNoCurrentCycleReviewRecordedBeforeRouting,
        assertPreparedReviewerLaunchArtifact,
        assertReviewContextContractOrThrow,
        assertRoutingCompatibility,
        buildCopyPasteReviewerLaunchPrompt,
        buildRecordReviewInvocationCommand,
        buildReviewerLaunchBindingSha256,
        COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        findMatchingRoutingEvent,
        getCurrentPreparedReviewerLaunchMismatches,
        getReviewTreeStateLaunchSummary,
        getReviewTreeStateSha256,
        getReviewerScopedDiffHandoffPaths,
        getStringField,
        handleRecordReviewInvocation,
        isCurrentCompletedReviewerLaunchArtifact,
        isForbiddenReviewerLaunchAttestationSource,
        LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
        normalizeReviewerLaunchAttestationSource,
        parseReviewerIdentity,
        PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
        PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        printCopyPasteReviewerLaunchPrompt,
        readJsonFile,
        readJsonObjectIfPresent,
        resolveCanonicalPreflightArtifactPath,
        resolveProviderLaunchMetadata,
        resolveReviewerHandoffBindings,
        resolveReviewerDraftOutputPath,
        resolveReviewerLaunchArtifactPathForWrite,
        resolveReviewerLaunchInputArtifactPath,
        resolveReviewerLaunchInputAttestation,
        REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
        snapshotSupersededReviewerLaunchArtifact,
        stringSha256,
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

async function handlePrepareReviewerLaunch(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'prepare-reviewer-launch', 'review_phase');
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const reviewsRoot = path.dirname(preflightPath);
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
    const { reviewerExecutionMode, reviewerIdentity, reviewerFallbackReason } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const preflightPayload = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
    const preflightSha256 = fileSha256(preflightPath);
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
        gateName: 'prepare-reviewer-launch'
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

    const currentExecutionMode = normalizeCompatibilityReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== reviewerExecutionMode || currentReviewerSessionId !== reviewerIdentity) {
        throw new Error(
            `Reviewer launch preparation requires review-context routing metadata for '${reviewType}' ` +
            `to match reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'. ` +
            'Run record-review-routing first.'
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    );
    if (!routingEvent) {
        throw new Error(
            `Reviewer launch preparation requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${reviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer launch preparation requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    const contextSha256 = fileSha256(contextPath);
    if (!contextSha256) {
        throw new Error(`Reviewer launch preparation requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    const launchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(launchArtifactPath);
    const existingArtifact = readJsonObjectIfPresent(launchArtifactPath);

    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'prepare-reviewer-launch'
    });
    const handoffBindings = resolveReviewerHandoffBindings({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'prepare-reviewer-launch'
    });
    const promptPath = promptBinding.promptPath;
    const scopedDiffHandoffPaths = getReviewerScopedDiffHandoffPaths(repoRoot, parsedReviewContext);
    const reviewTreeStateSha256 = getReviewTreeStateSha256(parsedReviewContext);
    const reviewTreeStateSummary = getReviewTreeStateLaunchSummary(parsedReviewContext);
    const providerLaunch = resolveProviderLaunchMetadata(runtimeIdentity);
    const reviewerPromptSha256 = promptBinding.reviewerPromptSha256;
    const launchBindingSha256 = buildReviewerLaunchBindingSha256({
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256
    });
    let supersededLaunchArtifact: SupersededReviewerLaunchArtifactSnapshot | null = null;
    if (existingArtifact) {
        const existingEvidenceType = getStringField(existingArtifact, 'evidence_type', 'artifact_type');
        const existingAttestationState = getStringField(existingArtifact, 'attestation_state', 'attestationState');
        const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath);
        const copyPasteReviewerLaunchPrompt = buildCopyPasteReviewerLaunchPrompt({
            repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
            reviewType,
            rolePromptPath: handoffBindings.rolePromptPath
                ? toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.rolePromptPath)
                : null,
            rolePromptSha256: handoffBindings.rolePromptSha256,
            reviewerPromptPath: toReviewerHandoffAbsolutePath(repoRoot, promptPath),
            reviewerPromptSha256,
            promptTemplatePath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.promptTemplatePath),
            promptTemplateSha256: handoffBindings.promptTemplateSha256,
            outputTemplatePath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.outputTemplatePath),
            outputTemplateSha256: handoffBindings.outputTemplateSha256,
            evidenceManifestPath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.evidenceManifestPath),
            evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
            reviewOutputPath: toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath)
        });
        const preparedMismatches = getCurrentPreparedReviewerLaunchMismatches({
            artifactPath: launchArtifactPath,
            artifact: existingArtifact,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerPromptSha256,
            rolePromptSha256: handoffBindings.rolePromptSha256,
            promptTemplateSha256: handoffBindings.promptTemplateSha256,
            outputTemplateSha256: handoffBindings.outputTemplateSha256,
            evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
            reviewOutputPath,
            copyPasteReviewerLaunchPrompt,
            copyPasteReviewerLaunchPromptSha256: stringSha256(copyPasteReviewerLaunchPrompt),
            reviewTreeStateSha256: reviewTreeStateSha256 || null,
            launchBindingSha256,
            routingEventSequence: routingEvent.sequence,
            timelineEvents
        });
        if (
            existingEvidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'prepared'
            && preparedMismatches.length === 0
        ) {
            const existingLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
            const existingLaunchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
            console.log(`REVIEWER_LAUNCH_PREPARED: ${reviewType}`);
            console.log(`ReviewerIdentity: ${reviewerIdentity}`);
            console.log(`RepoRoot: ${toReviewerHandoffAbsolutePath(repoRoot, repoRoot)}`);
            console.log(`ReviewContextPath: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}`);
            console.log(`ReviewContextSha256: ${contextSha256}`);
            console.log(`RoutingEventSha256: ${routingEventProvenance.event_sha256}`);
            console.log(`LaunchBindingSha256: ${launchBindingSha256}`);
            console.log(`PreparedLaunchEventSha256: ${getStringField(existingArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')}`);
            if (handoffBindings.rolePromptPath) {
                console.log(`RolePromptPath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.rolePromptPath)}`);
            }
            console.log(`ReviewerPromptPath: ${toReviewerHandoffAbsolutePath(repoRoot, promptPath)}`);
            console.log(`PromptTemplatePath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.promptTemplatePath)}`);
            console.log(`OutputTemplatePath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.outputTemplatePath)}`);
            console.log(`EvidenceManifestPath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.evidenceManifestPath)}`);
            console.log(`ReviewOutputPath: ${toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath)}`);
            if (scopedDiffHandoffPaths.metadataPath) {
                console.log(`ScopedDiffMetadataPath: ${scopedDiffHandoffPaths.metadataPath}`);
            }
            if (scopedDiffHandoffPaths.outputPath) {
                console.log(`ScopedDiffPath: ${scopedDiffHandoffPaths.outputPath}`);
            }
            if (scopedDiffHandoffPaths.cachePath) {
                console.log(`ScopedDiffCachePath: ${scopedDiffHandoffPaths.cachePath}`);
            }
            if (reviewTreeStateSha256) {
                console.log(`ReviewTreeStateSha256: ${reviewTreeStateSha256}`);
            }
            console.log(`ReviewerLaunchArtifactPath: ${toReviewerHandoffAbsolutePath(repoRoot, launchArtifactPath)}`);
            console.log(`ReviewerLaunchArtifactSha256: ${existingLaunchArtifactSha256}`);
            console.log(`ReviewerLaunchInputArtifactPath: ${toReviewerHandoffAbsolutePath(repoRoot, launchInputArtifactPath)}`);
            console.log(`ReviewerLaunchInputArtifactSha256: ${existingLaunchInputArtifactSha256}`);
            console.log(`CopyPasteReviewerLaunchPromptSha256: ${stringSha256(copyPasteReviewerLaunchPrompt)}`);
            console.log('AttestationState: prepared');
            console.log('SupersededLaunchArtifact: none');
            printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
            console.log(`NextAction: existing reviewer launch metadata is current; launch the delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath, then run complete-reviewer-launch with launch_input evidence. ${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION}`);
            return;
        }
        if (
            existingEvidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'launched'
            && isCurrentCompletedReviewerLaunchArtifact({
                repoRoot,
                artifactPath: launchArtifactPath,
                taskId,
                reviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewContextSha256: contextSha256,
                routingEventSha256: routingEventProvenance.event_sha256,
                reviewerPromptSha256,
                rolePromptSha256: handoffBindings.rolePromptSha256,
                promptTemplateSha256: handoffBindings.promptTemplateSha256,
                outputTemplateSha256: handoffBindings.outputTemplateSha256,
                evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
                reviewTreeStateSha256: reviewTreeStateSha256 || null,
                routingEventSequence: routingEvent.sequence,
                timelineEvents
            })
        ) {
            throw new Error(
                `Completed reviewer launch artifact already exists: ${normalizePath(launchArtifactPath)}. ` +
                'Run record-review-invocation for this completed launch evidence instead of replacing it.'
            );
        }
        supersededLaunchArtifact = snapshotSupersededReviewerLaunchArtifact({
            artifactPath: launchArtifactPath,
            mismatches: preparedMismatches
        });
    }
    const recordInvocationCommand = buildRecordReviewInvocationCommand({
        repoRoot,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextPath: contextPath,
        reviewerLaunchArtifactPath: launchArtifactPath
    });
    const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath);
    const copyPasteReviewerLaunchPrompt = buildCopyPasteReviewerLaunchPrompt({
        repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
        reviewType,
        rolePromptPath: handoffBindings.rolePromptPath
            ? toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.rolePromptPath)
            : null,
        rolePromptSha256: handoffBindings.rolePromptSha256,
        reviewerPromptPath: toReviewerHandoffAbsolutePath(repoRoot, promptPath),
        reviewerPromptSha256,
        promptTemplatePath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.promptTemplatePath),
        promptTemplateSha256: handoffBindings.promptTemplateSha256,
        outputTemplatePath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.outputTemplatePath),
        outputTemplateSha256: handoffBindings.outputTemplateSha256,
        evidenceManifestPath: toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.evidenceManifestPath),
        evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
        reviewOutputPath: toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath)
    });
    const copyPasteReviewerLaunchPromptSha256 = stringSha256(copyPasteReviewerLaunchPrompt);
    const launchPreparedAtUtc = new Date().toISOString();
    const preservePreparedFields = [
        'review_context_sha256',
        'routing_event_sha256',
        'reviewer_prompt_sha256',
        ...(handoffBindings.rolePromptSha256 ? ['role_prompt_sha256'] : []),
        'prompt_template_sha256',
        'output_template_sha256',
        'evidence_manifest_sha256',
        'copy_paste_reviewer_launch_prompt_sha256',
        'review_tree_state_sha256',
        'launch_binding_sha256',
        'prepared_launch_event_sha256',
        'prepared_launch_event_task_sequence'
    ];
    const handoffArtifactNames = handoffBindings.rolePromptPath
        ? 'role_prompt_path, prompt_template_path, reviewer_prompt_path, output_template_path, and evidence_manifest_path'
        : 'prompt_template_path, reviewer_prompt_path, output_template_path, and evidence_manifest_path';
    const preparedArtifact = {
        schema_version: 1,
        evidence_type: PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        attestation_state: 'prepared',
        task_id: taskId,
        review_type: reviewType,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_identity: reviewerIdentity,
        review_context_path: normalizePath(contextPath),
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventProvenance.event_sha256,
        routing_event_task_sequence: routingEventProvenance.task_sequence,
        reviewer_prompt_path: normalizePath(promptPath),
        reviewer_prompt_sha256: reviewerPromptSha256,
        ...(handoffBindings.rolePromptPath && handoffBindings.rolePromptSha256
            ? {
                role_prompt_path: normalizePath(handoffBindings.rolePromptPath),
                role_prompt_sha256: handoffBindings.rolePromptSha256
            }
            : {}),
        prompt_template_path: normalizePath(handoffBindings.promptTemplatePath),
        prompt_template_sha256: handoffBindings.promptTemplateSha256,
        output_template_path: normalizePath(handoffBindings.outputTemplatePath),
        output_template_sha256: handoffBindings.outputTemplateSha256,
        evidence_manifest_path: normalizePath(handoffBindings.evidenceManifestPath),
        evidence_manifest_sha256: handoffBindings.evidenceManifestSha256,
        review_output_path: normalizePath(reviewOutputPath),
        reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
        reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
        copy_paste_reviewer_launch_prompt: copyPasteReviewerLaunchPrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPasteReviewerLaunchPromptSha256,
        review_tree_state_sha256: reviewTreeStateSha256 || null,
        review_tree_state: reviewTreeStateSummary,
        launch_binding_sha256: launchBindingSha256,
        launch_prepared_at_utc: launchPreparedAtUtc,
        provider: providerLaunch.provider,
        launch_tool: providerLaunch.launchTool,
        launch_instruction: providerLaunch.launchInstruction,
        fresh_context_required: true,
        isolated_context_required: true,
        local_trust_boundary: LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
        after_launch_required_updates: {
            evidence_type: COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
            attestation_state: 'launched',
            attestation_source: '<provider/controller source, not garda_prepare_reviewer_launch/manual/mock>',
            launch_tool: providerLaunch.launchTool,
            provider_invocation_id_or_controller_invocation_id: '<actual delegated reviewer invocation id>',
            launched_at_utc: '<gate-owned UTC timestamp recorded by complete-reviewer-launch>',
            launch_completed_at_utc: '<gate-owned ISO-8601 completion timestamp>',
            launch_input_mode: 'launch_artifact_path or copy_paste_prompt',
            launch_input_sha256: '<prepared reviewer launch artifact sha256, or CopyPasteReviewerLaunchPromptSha256>',
            launch_input_artifact_path: '<ReviewerLaunchInputArtifactPath when launch_input_mode is launch_artifact_path>',
            launch_input_artifact_sha256: '<prepared reviewer launch artifact sha256 when launch_input_mode is launch_artifact_path>',
            copy_paste_reviewer_launch_prompt_sha256: copyPasteReviewerLaunchPromptSha256,
            fresh_context: true,
            isolated_context: true,
            fork_context: false
        },
        preserve_prepared_fields: preservePreparedFields,
        record_invocation_command: recordInvocationCommand,
        attestation_source: PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
        superseded_launch_artifact: supersededLaunchArtifact,
        generated_by: 'garda prepare-reviewer-launch',
        generated_at_utc: launchPreparedAtUtc,
        next_action: (
            `Launch a fresh delegated reviewer with ${handoffArtifactNames} as opaque handoff artifacts; ` +
            `${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ` +
            'do not open or summarize the generated review context in the main agent. Then update only the ' +
            'after_launch_required_updates fields while preserving the prepared hashes. ' +
            'Run record_invocation_command after the real launch is recorded in this artifact.'
        )
    };
    writeReviewArtifactJson(launchArtifactPath, preparedArtifact);
    const preparedEvent = await emitReviewerLaunchPreparedEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        contextSha256,
        routingEventProvenance.event_sha256,
        launchBindingSha256,
        {
            launchDetails: {
                reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
                reviewer_prompt_path: normalizePath(promptPath),
                reviewer_prompt_sha256: reviewerPromptSha256,
                ...(handoffBindings.rolePromptPath && handoffBindings.rolePromptSha256
                    ? {
                        role_prompt_path: normalizePath(handoffBindings.rolePromptPath),
                        role_prompt_sha256: handoffBindings.rolePromptSha256
                    }
                    : {}),
                prompt_template_path: normalizePath(handoffBindings.promptTemplatePath),
                prompt_template_sha256: handoffBindings.promptTemplateSha256,
                output_template_path: normalizePath(handoffBindings.outputTemplatePath),
                output_template_sha256: handoffBindings.outputTemplateSha256,
                evidence_manifest_path: normalizePath(handoffBindings.evidenceManifestPath),
                evidence_manifest_sha256: handoffBindings.evidenceManifestSha256,
                copy_paste_reviewer_launch_prompt_sha256: copyPasteReviewerLaunchPromptSha256,
                launch_tool: providerLaunch.launchTool,
                launch_prepared_at_utc: launchPreparedAtUtc,
                attestation_source: PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE
            }
        }
    );
    if (!preparedEvent || taskEventAppendHasBlockingFailure(preparedEvent, false) || !preparedEvent.integrity?.event_sha256) {
        removeArtifactIfExists(launchArtifactPath);
        throw new Error(
            `Reviewer launch preparation requires REVIEWER_LAUNCH_PREPARED telemetry for '${reviewType}'. ` +
            'The lifecycle event could not be persisted.'
        );
    }
    const preparedLaunchEventSha256 = String(preparedEvent.integrity.event_sha256 || '').trim().toLowerCase();
    const preparedLaunchEventTaskSequence = preparedEvent.integrity.task_sequence;
    const preparedArtifactWithEvent = {
        ...preparedArtifact,
        reviewer_launch_prepared_event_recorded_at_utc: launchPreparedAtUtc,
        prepared_launch_event_sha256: preparedLaunchEventSha256,
        prepared_launch_event_task_sequence: preparedLaunchEventTaskSequence
    };
    writeReviewArtifactJson(launchArtifactPath, preparedArtifactWithEvent);
    fs.copyFileSync(launchArtifactPath, launchInputArtifactPath);
    assertPreparedReviewerLaunchArtifact({
        artifactPath: launchArtifactPath,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256,
        rolePromptSha256: handoffBindings.rolePromptSha256,
        promptTemplateSha256: handoffBindings.promptTemplateSha256,
        outputTemplateSha256: handoffBindings.outputTemplateSha256,
        evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
        reviewOutputPath,
        reviewerLaunchInputArtifactPath: launchInputArtifactPath,
        copyPasteReviewerLaunchPrompt,
        copyPasteReviewerLaunchPromptSha256,
        reviewTreeStateSha256
    });
    const launchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const launchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
    if (launchInputArtifactSha256 !== launchArtifactSha256) {
        throw new Error(
            'Reviewer launch input artifact must be an immutable byte-for-byte copy of the prepared launch artifact.'
        );
    }

    console.log(`REVIEWER_LAUNCH_PREPARED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`RepoRoot: ${toReviewerHandoffAbsolutePath(repoRoot, repoRoot)}`);
    console.log(`ReviewContextPath: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}`);
    console.log(`ReviewContextSha256: ${contextSha256}`);
    console.log(`RoutingEventSha256: ${routingEventProvenance.event_sha256}`);
    console.log(`LaunchBindingSha256: ${launchBindingSha256}`);
    console.log(`PreparedLaunchEventSha256: ${preparedLaunchEventSha256}`);
    if (handoffBindings.rolePromptPath) {
        console.log(`RolePromptPath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.rolePromptPath)}`);
    }
    console.log(`ReviewerPromptPath: ${toReviewerHandoffAbsolutePath(repoRoot, promptPath)}`);
    console.log(`PromptTemplatePath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.promptTemplatePath)}`);
    console.log(`OutputTemplatePath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.outputTemplatePath)}`);
    console.log(`EvidenceManifestPath: ${toReviewerHandoffAbsolutePath(repoRoot, handoffBindings.evidenceManifestPath)}`);
    console.log(`ReviewOutputPath: ${toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath)}`);
    if (scopedDiffHandoffPaths.metadataPath) {
        console.log(`ScopedDiffMetadataPath: ${scopedDiffHandoffPaths.metadataPath}`);
    }
    if (scopedDiffHandoffPaths.outputPath) {
        console.log(`ScopedDiffPath: ${scopedDiffHandoffPaths.outputPath}`);
    }
    if (scopedDiffHandoffPaths.cachePath) {
        console.log(`ScopedDiffCachePath: ${scopedDiffHandoffPaths.cachePath}`);
    }
    if (reviewTreeStateSha256) {
        console.log(`ReviewTreeStateSha256: ${reviewTreeStateSha256}`);
    }
    console.log(`ReviewerLaunchArtifactPath: ${toReviewerHandoffAbsolutePath(repoRoot, launchArtifactPath)}`);
    console.log(`ReviewerLaunchArtifactSha256: ${launchArtifactSha256}`);
    console.log(`ReviewerLaunchInputArtifactPath: ${toReviewerHandoffAbsolutePath(repoRoot, launchInputArtifactPath)}`);
    console.log(`ReviewerLaunchInputArtifactSha256: ${launchInputArtifactSha256}`);
    console.log(`CopyPasteReviewerLaunchPromptSha256: ${copyPasteReviewerLaunchPromptSha256}`);
    console.log('AttestationState: prepared');
    if (supersededLaunchArtifact) {
        console.log(`SupersededLaunchArtifactSnapshotPath: ${toReviewerHandoffAbsolutePath(repoRoot, supersededLaunchArtifact.snapshot_path)}`);
        console.log(`SupersededLaunchArtifactSha256: ${supersededLaunchArtifact.artifact_sha256}`);
        console.log(`SupersededLaunchArtifactReason: ${supersededLaunchArtifact.superseded_reason}`);
    }
    console.log(`LaunchTool: ${providerLaunch.launchTool}`);
    console.log(`LaunchInstruction: ${providerLaunch.launchInstruction}`);
    console.log(`HandoffInstruction: ${REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION}`);
    console.log(`TrustBoundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`);
    console.log(`RequiredCompletedFields: ${REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS.join('; ')}`);
    console.log(`PreservePreparedFields: ${preservePreparedFields.join(', ')}`);
    console.log(`RecordInvocationCommand: ${recordInvocationCommand}`);
    printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
    console.log(`NextAction: launch the delegated reviewer with the exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath; do not reconstruct reviewer prompts from memory. ${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} Update after_launch_required_updates, then run complete-reviewer-launch with launch_input evidence or run RecordInvocationCommand after completion.`);
}

async function handleCompleteReviewerLaunch(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--reviewer-launch-artifact-path': { key: 'reviewerLaunchArtifactPath', type: 'string' },
        '--provider-invocation-id': { key: 'providerInvocationId', type: 'string' },
        '--controller-invocation-id': { key: 'controllerInvocationId', type: 'string' },
        '--launched-at-utc': { key: 'launchedAtUtc', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--launch-input-mode': { key: 'launchInputMode', type: 'string' },
        '--launch-input-sha256': { key: 'launchInputSha256', type: 'string' },
        '--launch-input-artifact-path': { key: 'launchInputArtifactPath', type: 'string' },
        '--fresh-context': { key: 'freshContext', type: 'boolean' },
        '--isolated-context': { key: 'isolatedContext', type: 'boolean' },
        '--fork-context': { key: 'forkContext', type: 'boolean' },
        '--record-invocation': { key: 'recordInvocation', type: 'boolean' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'complete-reviewer-launch', 'review_phase');
    const preflightPath = resolveCanonicalPreflightArtifactPath(repoRoot, taskId);
    const reviewsRoot = path.dirname(preflightPath);
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
    const { reviewerExecutionMode, reviewerIdentity } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );

    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const controllerInvocationId = String(options.controllerInvocationId || '').trim();
    if (!providerInvocationId && !controllerInvocationId) {
        throw new Error('ProviderInvocationId or ControllerInvocationId is required (the actual delegated reviewer invocation id).');
    }
    if (providerInvocationId && controllerInvocationId) {
        throw new Error('Provide either --provider-invocation-id or --controller-invocation-id, not both.');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'launchedAtUtc')) {
        throw new Error(
            'Caller-supplied --launched-at-utc is not accepted for complete-reviewer-launch. ' +
            'This is spoof-like launch freshness input; omit the flag so the gate records its own UTC timestamp.'
        );
    }
    const launchedAtUtc = new Date().toISOString();
    const attestationSource = normalizeReviewerLaunchAttestationSource(options.attestationSource);
    if (!attestationSource) {
        throw new Error('AttestationSource is required (provider/controller source).');
    }
    if (isForbiddenReviewerLaunchAttestationSource(attestationSource)) {
        throw new Error(
            `AttestationSource '${attestationSource}' is not a valid provider/controller-owned attestation source. ` +
            'Use the actual provider or controller identifier (e.g., claude_task_tool_launch, codex_agent_launch).'
        );
    }
    const freshContext = options.freshContext === true || options.isolatedContext === true || options.forkContext === false;
    if (!freshContext) {
        throw new Error(
            'At least one of --fresh-context, --isolated-context, or --fork-context false must attest clean reviewer context.'
        );
    }

    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    const launchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(launchArtifactPath);
    if (!fs.existsSync(launchArtifactPath) || !fs.statSync(launchArtifactPath).isFile()) {
        throw new Error(
            `Reviewer launch artifact not found: ${normalizePath(launchArtifactPath)}. ` +
            'Run prepare-reviewer-launch first.'
        );
    }

    const contextSha256 = fileSha256(contextPath);
    if (!contextSha256) {
        throw new Error(`Reviewer launch completion requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'complete-reviewer-launch'
    });
    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'complete-reviewer-launch'
    });
    const handoffBindings = resolveReviewerHandoffBindings({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'complete-reviewer-launch'
    });
    const reviewTreeStateSha256 = getReviewTreeStateSha256(parsedReviewContext);
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(timelineEvents, reviewType, reviewerExecutionMode, reviewerIdentity, null);
    if (!routingEvent) {
        throw new Error(
            `Reviewer launch completion requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${reviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer launch completion requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    assertPreparedReviewerLaunchArtifact({
        artifactPath: launchArtifactPath,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        reviewerPromptSha256: promptBinding.reviewerPromptSha256,
        rolePromptSha256: handoffBindings.rolePromptSha256,
        promptTemplateSha256: handoffBindings.promptTemplateSha256,
        outputTemplateSha256: handoffBindings.outputTemplateSha256,
        evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
        reviewerLaunchInputArtifactPath: launchInputArtifactPath,
        reviewTreeStateSha256
    });

    const preparedArtifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
    const preparedLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const launchInputAttestation = resolveReviewerLaunchInputAttestation({
        repoRoot,
        launchArtifactPath,
        preparedArtifact,
        preparedLaunchArtifactSha256,
        rawMode: options.launchInputMode,
        rawSha256: options.launchInputSha256,
        rawArtifactPath: options.launchInputArtifactPath
    });
    const launchCompletedAtUtc = new Date().toISOString();
    const completedArtifact: Record<string, unknown> = {
        ...preparedArtifact,
        evidence_type: COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        attestation_state: 'launched',
        attestation_source: attestationSource,
        launch_input_mode: launchInputAttestation.mode,
        launch_input_sha256: launchInputAttestation.sha256,
        launch_input_attestation_source: 'complete-reviewer-launch',
        launch_input_verified_at_utc: launchCompletedAtUtc,
        launch_input_copy_paste_reviewer_launch_prompt_sha256: launchInputAttestation.copyPasteReviewerLaunchPromptSha256,
        launch_completed_at_utc: launchCompletedAtUtc
    };
    if (launchInputAttestation.artifactPath) {
        completedArtifact.launch_input_artifact_path = normalizePath(launchInputAttestation.artifactPath);
    }
    if (launchInputAttestation.artifactSha256) {
        completedArtifact.launch_input_artifact_sha256 = launchInputAttestation.artifactSha256;
        completedArtifact.prepared_reviewer_launch_artifact_sha256 = launchInputAttestation.artifactSha256;
    }
    if (providerInvocationId) {
        completedArtifact.provider_invocation_id = providerInvocationId;
    } else {
        completedArtifact.controller_invocation_id = controllerInvocationId;
    }
    completedArtifact.launched_at_utc = launchedAtUtc;
    if (options.freshContext === true) {
        completedArtifact.fresh_context = true;
    }
    if (options.isolatedContext === true) {
        completedArtifact.isolated_context = true;
    }
    if (options.forkContext !== undefined) {
        completedArtifact.fork_context = options.forkContext;
    }
    writeReviewArtifactJson(launchArtifactPath, completedArtifact);
    const completedLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';

    const invocationId = providerInvocationId || controllerInvocationId;
    const invocationIdLabel = providerInvocationId ? 'ProviderInvocationId' : 'ControllerInvocationId';
    console.log(`REVIEWER_LAUNCH_COMPLETED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`LaunchArtifactSha256: ${completedLaunchArtifactSha256}`);
    console.log(`${invocationIdLabel}: ${invocationId}`);
    console.log(`LaunchedAtUtc: ${launchedAtUtc}`);
    console.log(`LaunchCompletedAtUtc: ${launchCompletedAtUtc}`);
    console.log(`AttestationSource: ${attestationSource}`);
    console.log(`LaunchInputMode: ${launchInputAttestation.mode}`);
    console.log(`LaunchInputSha256: ${launchInputAttestation.sha256}`);
    console.log(`CopyPasteReviewerLaunchPromptSha256: ${launchInputAttestation.copyPasteReviewerLaunchPromptSha256}`);
    if (launchInputAttestation.artifactPath) {
        console.log(`LaunchInputArtifactPath: ${normalizePath(launchInputAttestation.artifactPath)}`);
    }
    if (launchInputAttestation.artifactSha256) {
        console.log(`LaunchInputArtifactSha256: ${launchInputAttestation.artifactSha256}`);
    }
    console.log(`TrustBoundary: ${LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY}`);
    const recordCommand = getStringField(preparedArtifact, 'record_invocation_command', 'recordInvocationCommand');
    if (recordCommand) {
        console.log(`RecordInvocationCommand: ${recordCommand}`);
    }
    if (options.recordInvocation === true) {
        await handleRecordReviewInvocation([
            '--task-id', taskId,
            '--review-type', reviewType,
            '--reviewer-execution-mode', reviewerExecutionMode,
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            ...(options.reviewContextPath ? ['--review-context-path', String(options.reviewContextPath)] : []),
            ...(options.taskModePath ? ['--task-mode-path', String(options.taskModePath)] : []),
            '--repo-root', repoRoot
        ]);
        console.log('NextAction: record-review-invocation was attested by complete-reviewer-launch; run record-review-result after the delegated reviewer returns.');
        return;
    }
    console.log('NextAction: run RecordInvocationCommand to attest the invocation.');
}


    return {
        handleRecordReviewRouting,
        handlePrepareReviewerLaunch,
        handleCompleteReviewerLaunch
    };
}
