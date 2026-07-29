import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
    buildReviewReceiptReviewerProvenance,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    assertValidTaskId,
    emitReviewerLaunchInputPinnedEventAsync,
    emitReviewerLaunchPreparedEventAsync,
    fileSha256,
    gateHelpers,
    normalizeCompatibilityReviewerExecutionMode,
    normalizePath,
    resolveCanonicalReviewContextPath,
    resolveReviewerPromptArtifactBinding,
    taskEventAppendHasBlockingFailure,
    type ReviewDependencyTimelineEvent,
    writeReviewArtifactJson
} from './review-launch-entrypoints';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION
} from '../../../../gate-runtime/reviewer-session-contract';
import {
    getReviewerLaunchLaneReservationPath,
    REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE,
    reviewerLaunchPathsEqual,
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';
import {
    buildCompleteReviewerLaunchCommandTemplate,
    buildPreparedReviewerLaunchNextAction,
    buildRecordReviewerDelegationStartedCommandTemplate,
    buildRecordReviewerLaunchFailedCommandTemplate,
    buildReviewerLaunchNextAction,
    printReviewerLaunchHandoffLines
} from './reviewer-launch-command-templates';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import { resolveReviewerIdentityOption } from './reviewer-identity-options';
import {
    type ParsedOptionsRecord,
    removeArtifactIfExists
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';
import {
    isCompletedReviewerLaunchAttemptConsumed,
    isReviewerLaunchAttemptSupersededByAuthenticatedRestart
} from './reviewer-handoff-support';
type SupersededReviewerLaunchArtifactSnapshot = import('../index').SupersededReviewerLaunchArtifactSnapshot;

export type PrepareReviewerLaunchHandler = (gateArgv: string[]) => Promise<void>;

// Keep prepare-reviewer-launch dependency injection explicit while shared launch command rendering stays in reviewer-launch-command-templates.
export interface PrepareReviewerLaunchHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('../index').assertExplicitReviewContextRuntimeIdentity;
    assertPreparedReviewerLaunchArtifact: typeof import('../index').assertPreparedReviewerLaunchArtifact;
    assertReviewContextContractOrThrow: typeof import('../index').assertReviewContextContractOrThrow;
    assertRoutingCompatibility: typeof import('../index').assertRoutingCompatibility;
    buildCopyPasteReviewerLaunchPrompt: typeof import('../index').buildCopyPasteReviewerLaunchPrompt;
    buildRecordReviewInvocationCommand: typeof import('../index').buildRecordReviewInvocationCommand;
    buildReviewerLaunchBindingSha256: typeof import('../index').buildReviewerLaunchBindingSha256;
    buildReviewerLaunchInputHandoffArtifact: typeof import('../index').buildReviewerLaunchInputHandoffArtifact;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingReviewerLaunchInputPinnedEvent: typeof import('../index').findMatchingReviewerLaunchInputPinnedEvent;
    findMatchingReviewerLaunchPreparedEvent: typeof import('../index').findMatchingReviewerLaunchPreparedEvent;
    findRecoverableReviewerLaunchPreparedEvent: typeof import('../index').findRecoverableReviewerLaunchPreparedEvent;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getCurrentPreparedReviewerLaunchMismatches: typeof import('../index').getCurrentPreparedReviewerLaunchMismatches;
    getReviewTreeStateLaunchSummary: typeof import('../index').getReviewTreeStateLaunchSummary;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    getReviewerScopedDiffHandoffPaths: typeof import('../index').getReviewerScopedDiffHandoffPaths;
    getStringField: typeof import('../index').getStringField;
    isCurrentCompletedReviewerLaunchArtifact: typeof import('../index').isCurrentCompletedReviewerLaunchArtifact;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('../index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE;
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    printCopyPasteReviewerLaunchPrompt: typeof import('../index').printCopyPasteReviewerLaunchPrompt;
    readJsonObjectIfPresent: typeof import('../index').readJsonObjectIfPresent;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveProviderLaunchMetadata: typeof import('../index').resolveProviderLaunchMetadata;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
    resolveReviewerDraftOutputPath: typeof import('../index').resolveReviewerDraftOutputPath;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
    REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS: typeof import('../index').REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS;
    snapshotSupersededReviewerLaunchArtifact: typeof import('../index').snapshotSupersededReviewerLaunchArtifact;
    stringSha256: typeof import('../index').stringSha256;
    toReviewerHandoffAbsolutePath: typeof import('../index').toReviewerHandoffAbsolutePath;
}

function buildPreparedReviewerLaunchCommandSet(options: {
    repoRoot: string;
    taskId: string;
    reviewType: string;
    reviewContextPath: string;
    launchArtifactPath: string;
    launchInputArtifactPath: string;
    launchInputArtifactSha256: string;
    copyPasteReviewerLaunchPromptSha256: string;
}) {
    const commonOptions = {
        ...options
    };
    return {
        recordDelegationStartedLaunchArtifactPath:
            buildRecordReviewerDelegationStartedCommandTemplate({
                ...commonOptions,
                launchInputMode: 'launch_artifact_path'
            }),
        recordDelegationStartedCopyPastePrompt:
            buildRecordReviewerDelegationStartedCommandTemplate({
                ...commonOptions,
                launchInputMode: 'copy_paste_prompt'
            }),
        completeLaunchArtifactPath:
            buildCompleteReviewerLaunchCommandTemplate({
                ...commonOptions,
                launchInputMode: 'launch_artifact_path'
            }),
        completeCopyPastePrompt:
            buildCompleteReviewerLaunchCommandTemplate({
                ...commonOptions,
                launchInputMode: 'copy_paste_prompt'
            }),
        recordLaunchFailed: buildRecordReviewerLaunchFailedCommandTemplate(commonOptions)
    };
}

export function createPrepareReviewerLaunchHandler(deps: PrepareReviewerLaunchHandlerDependencies): PrepareReviewerLaunchHandler {
    const {
        assertExplicitReviewContextRuntimeIdentity,
        assertPreparedReviewerLaunchArtifact,
        assertReviewContextContractOrThrow,
        assertRoutingCompatibility,
        buildCopyPasteReviewerLaunchPrompt,
        buildRecordReviewInvocationCommand,
        buildReviewerLaunchBindingSha256,
        buildReviewerLaunchInputHandoffArtifact,
        COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        findMatchingReviewerLaunchInputPinnedEvent,
        findMatchingReviewerLaunchPreparedEvent,
        findRecoverableReviewerLaunchPreparedEvent,
        findMatchingRoutingEvent,
        getCurrentPreparedReviewerLaunchMismatches,
        getReviewTreeStateLaunchSummary,
        getReviewTreeStateSha256,
        getReviewerScopedDiffHandoffPaths,
        getStringField,
        isCurrentCompletedReviewerLaunchArtifact,
        LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
        parseReviewerIdentity,
        PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
        PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        printCopyPasteReviewerLaunchPrompt,
        readJsonObjectIfPresent,
        resolveCanonicalPreflightArtifactPath,
        resolveProviderLaunchMetadata,
        resolveReviewerHandoffBindings,
        resolveReviewerDraftOutputPath,
        resolveReviewerLaunchArtifactPathForWrite,
        resolveReviewerLaunchInputArtifactPath,
        REVIEWER_LAUNCH_COMPLETION_FIELD_HINTS,
        snapshotSupersededReviewerLaunchArtifact,
        stringSha256,
        toReviewerHandoffAbsolutePath
    } = deps;

return async function handlePrepareReviewerLaunch(gateArgv: string[]): Promise<void> {
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
    const launchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: options.reviewerLaunchArtifactPath
    });
    const canonicalLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
        repoRoot,
        taskId,
        reviewType,
        artifactPathValue: undefined
    });
    return await withReviewerLaunchLaneTransaction(canonicalLaunchArtifactPath, async () => {
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
    const reviewerIdentity = resolveReviewerIdentityOption(options, taskId, reviewType);
    const { reviewerExecutionMode, reviewerFallbackReason } = parseReviewerIdentity(
        {
            ...options,
            reviewerIdentity
        },
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'.",
        { allowPlannedIdentity: true }
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
        requireStrictBindingMetadata: !!options.reviewContextPath,
        repoRoot
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

    const launchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(launchArtifactPath);
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
    const laneReservationPath = getReviewerLaunchLaneReservationPath(canonicalLaunchArtifactPath);
    const laneReservationExists = fs.existsSync(laneReservationPath);
    const laneReservation = readJsonObjectIfPresent(laneReservationPath);
    if (laneReservationExists && !laneReservation) {
        throw new Error(
            `Reviewer launch lane reservation must contain valid JSON object metadata: ` +
            `${normalizePath(laneReservationPath)}.`
        );
    }
    let reservedLaunchArtifactPath = '';
    let reservedLaunchAttemptId = '';
    let reservedReviewContextSha256 = '';
    let reservedRoutingEventSha256 = '';
    let reservedLaunchBindingSha256 = '';
    if (laneReservation) {
        const reservationSchemaVersion = Number(laneReservation.schema_version);
        const reservationEvidenceType = getStringField(laneReservation, 'evidence_type', 'evidenceType');
        const reservationTaskId = getStringField(laneReservation, 'task_id', 'taskId');
        const reservationReviewType = getStringField(laneReservation, 'review_type', 'reviewType').toLowerCase();
        reservedLaunchAttemptId = getStringField(
            laneReservation,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase();
        reservedReviewContextSha256 = getStringField(
            laneReservation,
            'review_context_sha256',
            'reviewContextSha256'
        ).toLowerCase();
        reservedRoutingEventSha256 = getStringField(
            laneReservation,
            'routing_event_sha256',
            'routingEventSha256'
        ).toLowerCase();
        reservedLaunchBindingSha256 = getStringField(
            laneReservation,
            'launch_binding_sha256',
            'launchBindingSha256'
        ).toLowerCase();
        const reservationArtifactPathValue = getStringField(
            laneReservation,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        );
        if (
            reservationSchemaVersion !== 1
            || reservationEvidenceType !== REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE
            || reservationTaskId !== taskId
            || reservationReviewType !== reviewType
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
                .test(reservedLaunchAttemptId)
            || !/^[0-9a-f]{64}$/.test(reservedReviewContextSha256)
            || !/^[0-9a-f]{64}$/.test(reservedRoutingEventSha256)
            || !/^[0-9a-f]{64}$/.test(reservedLaunchBindingSha256)
            || !reservationArtifactPathValue
        ) {
            throw new Error(
                `Reviewer launch lane reservation is malformed or belongs to another lane: ` +
                `${normalizePath(laneReservationPath)}.`
            );
        }
        reservedLaunchArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: reservationArtifactPathValue
        });
        if (!reviewerLaunchPathsEqual(reservedLaunchArtifactPath, reservationArtifactPathValue)) {
            throw new Error(
                `Reviewer launch lane reservation must use its resolved task-owned artifact path: ` +
                `${normalizePath(laneReservationPath)}.`
            );
        }
    }
    const existingArtifact = readJsonObjectIfPresent(launchArtifactPath);
    if (fs.existsSync(launchArtifactPath) && !existingArtifact) {
        throw new Error(
            `Reviewer launch artifact must contain valid JSON object metadata: ${normalizePath(launchArtifactPath)}.`
        );
    }
    const existingAttestationState = existingArtifact
        ? getStringField(existingArtifact, 'attestation_state', 'attestationState')
        : '';
    const existingLaunchAttemptId = existingArtifact
        ? getStringField(existingArtifact, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
        : '';
    const existingAttemptSuperseded = existingArtifact
        ? isReviewerLaunchAttemptSupersededByAuthenticatedRestart(
            timelinePath,
            taskId,
            reviewType,
            launchArtifactPath,
            existingArtifact
        )
        : false;
    if (existingAttestationState === 'delegation_started' && !existingAttemptSuperseded) {
        throw new Error(
            `The immutable reviewer launch attempt is already delegation_started for '${reviewType}'. ` +
            'Complete it or record-reviewer-launch-failed before preparing another attempt.'
        );
    }
    if (
        existingAttestationState === 'launched'
        && existingArtifact
        && !existingAttemptSuperseded
        && !isCompletedReviewerLaunchAttemptConsumed(timelineEvents, existingArtifact)
    ) {
        throw new Error(
            `The immutable reviewer launch attempt is already launched for '${reviewType}'. ` +
            'Record its invocation/result instead of preparing another attempt.'
        );
    }
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
    const getActiveLaneArtifactState = (
        candidateArtifactPath: string,
        candidateArtifact: Record<string, unknown>
    ): string | null => {
        if (isReviewerLaunchAttemptSupersededByAuthenticatedRestart(
            timelinePath,
            taskId,
            reviewType,
            candidateArtifactPath,
            candidateArtifact
        )) {
            return null;
        }
        const candidateState = getStringField(
            candidateArtifact,
            'attestation_state',
            'attestationState'
        );
        if (candidateState === 'prepared' || candidateState === 'delegation_started') {
            return candidateState;
        }
        if (
            candidateState === 'launched'
            && !isCompletedReviewerLaunchAttemptConsumed(timelineEvents, candidateArtifact)
        ) {
            return candidateState;
        }
        return null;
    };
    const reservationMatchesCurrentBinding = laneReservation != null
        && reservedReviewContextSha256 === contextSha256
        && reservedRoutingEventSha256 === routingEventProvenance.event_sha256
        && reservedLaunchBindingSha256 === launchBindingSha256;
    if (laneReservation && !reviewerLaunchPathsEqual(reservedLaunchArtifactPath, launchArtifactPath)) {
        const reservedArtifactExists = fs.existsSync(reservedLaunchArtifactPath);
        const reservedArtifact = readJsonObjectIfPresent(reservedLaunchArtifactPath);
        if (reservedArtifactExists && !reservedArtifact) {
            throw new Error(
                `Reserved reviewer launch artifact must contain valid JSON object metadata: ` +
                `${normalizePath(reservedLaunchArtifactPath)}.`
            );
        }
        const reservedActiveState = reservedArtifact
            ? getActiveLaneArtifactState(reservedLaunchArtifactPath, reservedArtifact)
            : null;
        if (reservedActiveState || (reservationMatchesCurrentBinding && !reservedArtifact)) {
            throw new Error(
                `Reviewer launch lane '${taskId}/${reviewType}' is already reserved at ` +
                `${normalizePath(reservedLaunchArtifactPath)} ` +
                `(attempt '${reservedLaunchAttemptId}', state '${reservedActiveState || 'preparing'}'). ` +
                'Retry that exact artifact path or finish/fail the existing attempt before choosing another path.'
            );
        }
    }
    for (const event of timelineEvents) {
        if (event.event_type !== 'REVIEWER_LAUNCH_PREPARED' || !event.integrity?.event_sha256) {
            continue;
        }
        const details = event.details || {};
        const eventAttemptId = getStringField(
            details,
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase();
        const matchingEvent = findMatchingReviewerLaunchPreparedEvent(timelineEvents, {
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerLaunchAttemptId: eventAttemptId,
            launchBindingSha256,
            preparedLaunchEventSha256: event.integrity.event_sha256,
            minSequenceExclusive: routingEvent.sequence
        });
        if (matchingEvent !== event) {
            continue;
        }
        const eventArtifactPathValue = getStringField(
            details,
            'reviewer_launch_artifact_path',
            'reviewerLaunchArtifactPath'
        );
        const eventArtifactPath = resolveReviewerLaunchArtifactPathForWrite({
            repoRoot,
            taskId,
            reviewType,
            artifactPathValue: eventArtifactPathValue
        });
        const eventArtifactExists = fs.existsSync(eventArtifactPath);
        const eventArtifact = readJsonObjectIfPresent(eventArtifactPath);
        if (!eventArtifact) {
            throw new Error(
                `Current reviewer launch telemetry references a missing or malformed control artifact: ` +
                `${normalizePath(eventArtifactPath)}. Restore or fail the recorded attempt before preparing another.`
            );
        }
        const eventActiveState = getActiveLaneArtifactState(eventArtifactPath, eventArtifact);
        if (eventActiveState && !reviewerLaunchPathsEqual(eventArtifactPath, launchArtifactPath)) {
            throw new Error(
                `Reviewer launch lane '${taskId}/${reviewType}' already has an active ` +
                `${eventActiveState} attempt '${eventAttemptId}' at ${normalizePath(eventArtifactPath)}. ` +
                'Complete or fail it before preparing another artifact path.'
            );
        }
        if (!eventArtifactExists) {
            throw new Error(
                `Current reviewer launch telemetry references a missing control artifact: ` +
                `${normalizePath(eventArtifactPath)}.`
            );
        }
    }
    if (
        existingArtifact
        && reservationMatchesCurrentBinding
        && reviewerLaunchPathsEqual(reservedLaunchArtifactPath, launchArtifactPath)
        && reservedLaunchAttemptId !== existingLaunchAttemptId.toLowerCase()
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
            .test(existingLaunchAttemptId)
        && getActiveLaneArtifactState(launchArtifactPath, existingArtifact)
    ) {
        throw new Error(
            `Reviewer launch lane reservation attempt '${reservedLaunchAttemptId}' does not match active control ` +
            `attempt '${existingLaunchAttemptId}' at ${normalizePath(launchArtifactPath)}.`
        );
    }
    const reviewerLaunchAttemptId = existingAttestationState === 'prepared'
        && !existingAttemptSuperseded
        && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existingLaunchAttemptId)
        ? existingLaunchAttemptId.toLowerCase()
        : (
            !existingArtifact
            && reservationMatchesCurrentBinding
            && reviewerLaunchPathsEqual(reservedLaunchArtifactPath, launchArtifactPath)
                ? reservedLaunchAttemptId
                : randomUUID()
        );
    const emitPreparedLaunchEventForAttemptAsync = async (
        launchPreparedAtUtc: string,
        copyPasteReviewerLaunchPromptSha256: string
    ) => await emitReviewerLaunchPreparedEventAsync(
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
                reviewer_launch_attempt_id: reviewerLaunchAttemptId,
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
    const reviewOutputAttemptSha256 = stringSha256(JSON.stringify({
        task_id: taskId,
        review_type: reviewType,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_identity: reviewerIdentity,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventProvenance.event_sha256,
        routing_event_task_sequence: routingEventProvenance.task_sequence,
        reviewer_prompt_sha256: reviewerPromptSha256,
        role_prompt_sha256: handoffBindings.rolePromptSha256 || null,
        prompt_template_sha256: handoffBindings.promptTemplateSha256,
        output_template_sha256: handoffBindings.outputTemplateSha256,
        evidence_manifest_sha256: handoffBindings.evidenceManifestSha256,
        review_tree_state_sha256: reviewTreeStateSha256 || null,
        launch_binding_sha256: launchBindingSha256
    }));
    let supersededLaunchArtifact: SupersededReviewerLaunchArtifactSnapshot | null = null;
    if (existingArtifact) {
        const existingEvidenceType = getStringField(existingArtifact, 'evidence_type', 'artifact_type');
        const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath, reviewOutputAttemptSha256);
        const copyPasteReviewerLaunchPrompt = buildCopyPasteReviewerLaunchPrompt({
            repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
            executionProvider: providerLaunch.provider,
            taskId,
            reviewType,
            reviewContextSha256: contextSha256,
            reviewTreeStateSha256: reviewTreeStateSha256 || null,
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
        const launchPreparedAtUtc = getStringField(
            existingArtifact,
            'launch_prepared_at_utc',
            'launchPreparedAtUtc'
        );
        let effectiveTimelineEvents = timelineEvents;
        let recoverablePreparedEvent = findRecoverableReviewerLaunchPreparedEvent(effectiveTimelineEvents, {
            artifactPath: launchArtifactPath,
            reviewerLaunchInputArtifactPath: launchInputArtifactPath,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerLaunchAttemptId,
            launchBindingSha256,
            reviewerPromptSha256,
            launchPreparedAtUtc,
            minSequenceExclusive: routingEvent.sequence
        });
        const initialControlPreparedEventSha256 = getStringField(
            existingArtifact,
            'prepared_launch_event_sha256',
            'preparedLaunchEventSha256'
        ).toLowerCase();
        const initialRawControlPreparedEventTaskSequence = (
            existingArtifact.prepared_launch_event_task_sequence
            ?? existingArtifact.preparedLaunchEventTaskSequence
        );
        const initialControlPreparedEventMissing = !initialControlPreparedEventSha256
            && initialRawControlPreparedEventTaskSequence == null;
        const hasLaunchLifecycleEventForAttempt = effectiveTimelineEvents.some((event) => {
            if (
                event.sequence <= routingEvent.sequence
                || ![
                    'REVIEWER_LAUNCH_PREPARED',
                    'REVIEWER_LAUNCH_INPUT_PINNED',
                    'REVIEWER_DELEGATION_STARTED',
                    'REVIEWER_LAUNCH_COMPLETED',
                    'REVIEWER_LAUNCH_FAILED'
                ].includes(event.event_type)
            ) {
                return false;
            }
            return getStringField(
                event.details || {},
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            ).toLowerCase() === reviewerLaunchAttemptId;
        });
        const preEventRecoveryMismatches = getCurrentPreparedReviewerLaunchMismatches({
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
            copyPasteReviewerLaunchPromptSha256,
            reviewTreeStateSha256: reviewTreeStateSha256 || null,
            launchBindingSha256,
            reviewerLaunchAttemptId,
            routingEventSequence: routingEvent.sequence,
            timelineEvents: effectiveTimelineEvents,
            deferPreparedLaunchEventValidationForRecovery: true,
            deferReviewerLaunchInputPinValidationForRecovery: true
        });
        const canRecoverPreEventControlArtifact = (
            existingEvidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'prepared'
            && reservationMatchesCurrentBinding
            && reviewerLaunchPathsEqual(reservedLaunchArtifactPath, launchArtifactPath)
            && reservedLaunchAttemptId === reviewerLaunchAttemptId
            && initialControlPreparedEventMissing
            && !recoverablePreparedEvent
            && !hasLaunchLifecycleEventForAttempt
            && !fs.existsSync(launchInputArtifactPath)
            && getStringField(
                existingArtifact,
                'reviewer_launch_artifact_path',
                'reviewerLaunchArtifactPath'
            ) === normalizePath(launchArtifactPath)
            && getStringField(
                existingArtifact,
                'reviewer_launch_input_artifact_path',
                'reviewerLaunchInputArtifactPath'
            ) === normalizePath(launchInputArtifactPath)
            && launchPreparedAtUtc.length > 0
            && !Number.isNaN(Date.parse(launchPreparedAtUtc))
            && preEventRecoveryMismatches.length === 0
        );
        if (canRecoverPreEventControlArtifact) {
            const recoveredPreparedEvent = await emitPreparedLaunchEventForAttemptAsync(
                launchPreparedAtUtc,
                copyPasteReviewerLaunchPromptSha256
            );
            if (
                !recoveredPreparedEvent
                || taskEventAppendHasBlockingFailure(recoveredPreparedEvent, false)
                || !recoveredPreparedEvent.integrity?.event_sha256
            ) {
                throw new Error(
                    `Reviewer launch preparation recovery requires REVIEWER_LAUNCH_PREPARED telemetry ` +
                    `for '${reviewType}'. The pre-event control artifact remains reserved for a safe retry.`
                );
            }
            const recoveredPreparedEventSha256 = String(
                recoveredPreparedEvent.integrity.event_sha256
            ).trim().toLowerCase();
            Object.assign(existingArtifact, {
                reviewer_launch_prepared_event_recorded_at_utc: launchPreparedAtUtc,
                prepared_launch_event_sha256: recoveredPreparedEventSha256,
                prepared_launch_event_task_sequence: recoveredPreparedEvent.integrity.task_sequence
            });
            writeReviewArtifactJson(launchArtifactPath, existingArtifact);
            effectiveTimelineEvents = readDependencyTimelineEvents(timelinePath);
            recoverablePreparedEvent = findRecoverableReviewerLaunchPreparedEvent(effectiveTimelineEvents, {
                artifactPath: launchArtifactPath,
                reviewerLaunchInputArtifactPath: launchInputArtifactPath,
                taskId,
                reviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewContextSha256: contextSha256,
                routingEventSha256: routingEventProvenance.event_sha256,
                reviewerLaunchAttemptId,
                launchBindingSha256,
                reviewerPromptSha256,
                launchPreparedAtUtc,
                minSequenceExclusive: routingEvent.sequence
            });
            if (!recoverablePreparedEvent) {
                throw new Error(
                    `Recovered REVIEWER_LAUNCH_PREPARED telemetry could not be rebound to ` +
                    `${normalizePath(launchArtifactPath)}.`
                );
            }
        }
        const recoverablePreparedEventSha256 = String(
            recoverablePreparedEvent?.integrity?.event_sha256 || ''
        ).trim().toLowerCase();
        const recoverablePreparedEventTaskSequence = Number(
            recoverablePreparedEvent?.integrity?.task_sequence
        );
        const controlPreparedEventSha256 = getStringField(
            existingArtifact,
            'prepared_launch_event_sha256',
            'preparedLaunchEventSha256'
        ).toLowerCase();
        const rawControlPreparedEventTaskSequence = (
            existingArtifact.prepared_launch_event_task_sequence
            ?? existingArtifact.preparedLaunchEventTaskSequence
        );
        const controlPreparedEventTaskSequence = Number(rawControlPreparedEventTaskSequence);
        const controlPreparedEventMissing = !controlPreparedEventSha256
            && rawControlPreparedEventTaskSequence == null;
        const controlPreparedEventMatches = controlPreparedEventSha256 === recoverablePreparedEventSha256
            && controlPreparedEventTaskSequence === recoverablePreparedEventTaskSequence;
        const canUseRecoverablePreparedEvent = recoverablePreparedEvent != null
            && (controlPreparedEventMissing || controlPreparedEventMatches);
        const preparedLaunchEventSha256 = canUseRecoverablePreparedEvent
            ? recoverablePreparedEventSha256
            : controlPreparedEventSha256;
        const preparedLaunchEventTaskSequence = canUseRecoverablePreparedEvent
            ? recoverablePreparedEventTaskSequence
            : (
                Number.isInteger(controlPreparedEventTaskSequence)
                    ? controlPreparedEventTaskSequence
                    : null
            );
        const expectedReviewerLaunchInputArtifact = buildReviewerLaunchInputHandoffArtifact({
            repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
            executionProvider: providerLaunch.provider,
            taskId,
            reviewerLaunchAttemptId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            reviewContextPath: toReviewerHandoffAbsolutePath(repoRoot, contextPath),
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            routingEventTaskSequence: routingEventProvenance.task_sequence,
            launchBindingSha256,
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
            reviewOutputPath: toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath),
            reviewOutputAttemptSha256,
            reviewTreeStateSha256: reviewTreeStateSha256 || null,
            copyPasteReviewerLaunchPromptSha256,
            preparedLaunchEventSha256,
            preparedLaunchEventTaskSequence,
            localTrustBoundary: LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY
        });
        const expectedLaunchInputArtifactSha256 = stringSha256(`${JSON.stringify(expectedReviewerLaunchInputArtifact, null, 2)}\n`);
        const preparedLaunchCommands = buildPreparedReviewerLaunchCommandSet({
            repoRoot,
            taskId,
            reviewType,
            reviewContextPath: contextPath,
            launchArtifactPath,
            launchInputArtifactPath,
            launchInputArtifactSha256: expectedLaunchInputArtifactSha256,
            copyPasteReviewerLaunchPromptSha256: stringSha256(copyPasteReviewerLaunchPrompt)
        });
        const collectPreparedMismatches = (
            artifact: Record<string, unknown>,
            currentTimelineEvents: readonly ReviewDependencyTimelineEvent[] = timelineEvents,
            deferReviewerLaunchInputPinValidationForRecovery = false,
            includeCompletionCommands = true
        ): string[] => (
            getCurrentPreparedReviewerLaunchMismatches({
                artifactPath: launchArtifactPath,
                artifact,
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
                reviewerLaunchInputArtifactSha256: expectedLaunchInputArtifactSha256,
                reviewerLaunchAttemptId,
                ...(includeCompletionCommands
                    ? {
                        recordReviewerDelegationStartedLaunchArtifactPathCommand:
                            preparedLaunchCommands.recordDelegationStartedLaunchArtifactPath,
                        recordReviewerDelegationStartedCopyPastePromptCommand:
                            preparedLaunchCommands.recordDelegationStartedCopyPastePrompt,
                        completeReviewerLaunchLaunchArtifactPathCommand:
                            preparedLaunchCommands.completeLaunchArtifactPath,
                        completeReviewerLaunchCopyPastePromptCommand:
                            preparedLaunchCommands.completeCopyPastePrompt,
                        recordReviewerLaunchFailedCommand: preparedLaunchCommands.recordLaunchFailed
                    }
                    : {}),
                routingEventSequence: routingEvent.sequence,
                timelineEvents: currentTimelineEvents,
                deferReviewerLaunchInputPinValidationForRecovery
            })
        );
        if (
            existingEvidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'prepared'
            && canUseRecoverablePreparedEvent
            && getStringField(
                existingArtifact,
                'reviewer_launch_input_artifact_path',
                'reviewerLaunchInputArtifactPath'
            ) === normalizePath(launchInputArtifactPath)
        ) {
            const recoveryBaseArtifact: Record<string, unknown> = {
                ...existingArtifact,
                reviewer_launch_prepared_event_recorded_at_utc: launchPreparedAtUtc,
                prepared_launch_event_sha256: preparedLaunchEventSha256,
                prepared_launch_event_task_sequence: preparedLaunchEventTaskSequence
            };
            const recoveryBaseMismatches = collectPreparedMismatches(
                recoveryBaseArtifact,
                effectiveTimelineEvents,
                true,
                false
            );
            let durableInputPin = findMatchingReviewerLaunchInputPinnedEvent({
                artifactPath: launchArtifactPath,
                taskId,
                reviewType,
                reviewerExecutionMode,
                reviewerIdentity,
                reviewContextSha256: contextSha256,
                routingEventSha256: routingEventProvenance.event_sha256,
                launchBindingSha256,
                reviewerLaunchAttemptId,
                preparedLaunchEventSha256,
                reviewerLaunchInputArtifactPath: launchInputArtifactPath,
                reviewerLaunchInputArtifactSha256: expectedLaunchInputArtifactSha256,
                timelineEvents: effectiveTimelineEvents
            });
            const hasInputPinForAttempt = (
                events: readonly ReviewDependencyTimelineEvent[]
            ): boolean => events.some((event) => {
                if (event.event_type !== 'REVIEWER_LAUNCH_INPUT_PINNED') {
                    return false;
                }
                const details = event.details || {};
                return getStringField(details, 'task_id', 'taskId') === taskId
                    && getStringField(details, 'review_type', 'reviewType').toLowerCase() === reviewType
                    && getStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
                        === reviewerLaunchAttemptId
                    && getStringField(details, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')
                        .toLowerCase() === preparedLaunchEventSha256;
            });
            if (
                recoveryBaseMismatches.length === 0
                && !durableInputPin
                && !hasInputPinForAttempt(effectiveTimelineEvents)
            ) {
                writeReviewArtifactJson(launchInputArtifactPath, expectedReviewerLaunchInputArtifact);
                const recoveredLaunchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
                if (recoveredLaunchInputArtifactSha256 !== expectedLaunchInputArtifactSha256) {
                    throw new Error(
                        'Reviewer launch input recovery must reproduce the exact prepared reviewer-facing handoff.'
                    );
                }
                effectiveTimelineEvents = readDependencyTimelineEvents(timelinePath);
                durableInputPin = findMatchingReviewerLaunchInputPinnedEvent({
                    artifactPath: launchArtifactPath,
                    taskId,
                    reviewType,
                    reviewerExecutionMode,
                    reviewerIdentity,
                    reviewContextSha256: contextSha256,
                    routingEventSha256: routingEventProvenance.event_sha256,
                    launchBindingSha256,
                    reviewerLaunchAttemptId,
                    preparedLaunchEventSha256,
                    reviewerLaunchInputArtifactPath: launchInputArtifactPath,
                    reviewerLaunchInputArtifactSha256: expectedLaunchInputArtifactSha256,
                    timelineEvents: effectiveTimelineEvents
                });
                if (!durableInputPin && !hasInputPinForAttempt(effectiveTimelineEvents)) {
                    const recoveredPinEvent = await emitReviewerLaunchInputPinnedEventAsync(
                        gateHelpers.joinOrchestratorPath(repoRoot, ''),
                        taskId,
                        reviewType,
                        reviewerExecutionMode,
                        reviewerIdentity,
                        contextSha256,
                        routingEventProvenance.event_sha256,
                        launchBindingSha256,
                        reviewerLaunchAttemptId,
                        preparedLaunchEventSha256,
                        normalizePath(launchArtifactPath),
                        normalizePath(launchInputArtifactPath),
                        expectedLaunchInputArtifactSha256
                    );
                    if (
                        !recoveredPinEvent
                        || taskEventAppendHasBlockingFailure(recoveredPinEvent, false)
                        || !recoveredPinEvent.integrity?.event_sha256
                    ) {
                        throw new Error(
                            `Reviewer launch preparation recovery requires REVIEWER_LAUNCH_INPUT_PINNED telemetry ` +
                            `for '${reviewType}'. The immutable reviewer-facing handoff hash could not be persisted.`
                        );
                    }
                    effectiveTimelineEvents = readDependencyTimelineEvents(timelinePath);
                    durableInputPin = findMatchingReviewerLaunchInputPinnedEvent({
                        artifactPath: launchArtifactPath,
                        taskId,
                        reviewType,
                        reviewerExecutionMode,
                        reviewerIdentity,
                        reviewContextSha256: contextSha256,
                        routingEventSha256: routingEventProvenance.event_sha256,
                        launchBindingSha256,
                        reviewerLaunchAttemptId,
                        preparedLaunchEventSha256,
                        reviewerLaunchInputArtifactPath: launchInputArtifactPath,
                        reviewerLaunchInputArtifactSha256: expectedLaunchInputArtifactSha256,
                        timelineEvents: effectiveTimelineEvents
                    });
                }
            }
            if (durableInputPin) {
                const reconciledArtifact: Record<string, unknown> = {
                    ...recoveryBaseArtifact,
                    reviewer_launch_input_artifact_sha256: durableInputPin.inputArtifactSha256,
                    reviewer_launch_input_pinned_event_sha256: durableInputPin.eventSha256,
                    reviewer_launch_input_pinned_event_task_sequence: durableInputPin.eventTaskSequence,
                    record_reviewer_delegation_started_launch_artifact_path_command:
                        preparedLaunchCommands.recordDelegationStartedLaunchArtifactPath,
                    record_reviewer_delegation_started_copy_paste_prompt_command:
                        preparedLaunchCommands.recordDelegationStartedCopyPastePrompt,
                    complete_reviewer_launch_launch_artifact_path_command:
                        preparedLaunchCommands.completeLaunchArtifactPath,
                    complete_reviewer_launch_copy_paste_prompt_command:
                        preparedLaunchCommands.completeCopyPastePrompt,
                    record_reviewer_launch_failed_command: preparedLaunchCommands.recordLaunchFailed
                };
                const requiresReconciliation = [
                    'reviewer_launch_input_artifact_sha256',
                    'reviewer_launch_input_pinned_event_sha256',
                    'reviewer_launch_input_pinned_event_task_sequence',
                    'record_reviewer_delegation_started_launch_artifact_path_command',
                    'record_reviewer_delegation_started_copy_paste_prompt_command',
                    'complete_reviewer_launch_launch_artifact_path_command',
                    'complete_reviewer_launch_copy_paste_prompt_command',
                    'record_reviewer_launch_failed_command'
                ].some((field) => existingArtifact[field] !== reconciledArtifact[field]);
                if (
                    requiresReconciliation
                    && collectPreparedMismatches(reconciledArtifact, effectiveTimelineEvents).length === 0
                ) {
                    writeReviewArtifactJson(launchArtifactPath, reconciledArtifact);
                    Object.assign(existingArtifact, reconciledArtifact);
                }
            }
        }
        const existingLaunchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
        const preparedMismatches = collectPreparedMismatches(existingArtifact, effectiveTimelineEvents);
        if (
            existingEvidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'prepared'
            && preparedMismatches.length === 0
        ) {
            const existingLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
            console.log(buildOperatorNextActionBlock({
                status: 'PASSED',
                gate: 'prepare-reviewer-launch',
                action: 'Launch one clean-context delegated reviewer',
                reason: `Current reviewer launch metadata is already prepared for '${reviewType}'.`,
                commandReference: 'launch the reviewer with exactly one handoff mode, then run the matching RecordReviewerDelegationStarted*Command below',
                detailsPath: launchArtifactPath,
                detailsHint: 'Current launch artifact paths, hashes, and copy-paste reviewer instructions are listed below.'
            }).join('\n'));
            console.log('');
            console.log(`REVIEWER_LAUNCH_PREPARED: ${reviewType}`);
            console.log(`ReviewerIdentity: ${reviewerIdentity}`);
            console.log(`RepoRoot: ${toReviewerHandoffAbsolutePath(repoRoot, repoRoot)}`);
            console.log(`ReviewContextPath: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}`);
            console.log(`ReviewContextSha256: ${contextSha256}`);
            console.log(`RoutingEventSha256: ${routingEventProvenance.event_sha256}`);
            console.log(`LaunchBindingSha256: ${launchBindingSha256}`);
            console.log(`PreparedLaunchEventSha256: ${getStringField(existingArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')}`);
            console.log(`ReviewerLaunchAttemptId: ${reviewerLaunchAttemptId}`);
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
            printReviewerLaunchHandoffLines();
            console.log(`CopyPasteReviewerLaunchPromptSha256: ${stringSha256(copyPasteReviewerLaunchPrompt)}`);
            console.log('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256; launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields, not CLI flags.');
            console.log('AttestationState: prepared');
            console.log('SupersededLaunchArtifact: none');
            console.log(`RecordReviewerDelegationStartedLaunchArtifactPathCommand: ${preparedLaunchCommands.recordDelegationStartedLaunchArtifactPath}`);
            console.log(`RecordReviewerDelegationStartedCopyPastePromptCommand: ${preparedLaunchCommands.recordDelegationStartedCopyPastePrompt}`);
            console.log(`CompleteReviewerLaunchLaunchArtifactPathCommand: ${preparedLaunchCommands.completeLaunchArtifactPath}`);
            console.log(`CompleteReviewerLaunchCopyPastePromptCommand: ${preparedLaunchCommands.completeCopyPastePrompt}`);
            console.log(`RecordReviewerLaunchFailedCommand: ${preparedLaunchCommands.recordLaunchFailed}`);
            printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
            console.log(`NextStep: existing reviewer launch metadata is current; ${buildReviewerLaunchNextAction()}`);
            return;
        }
        if (
            existingEvidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'prepared'
            && existingLaunchAttemptId
            && !existingAttemptSuperseded
        ) {
            throw new Error(
                `Prepared reviewer launch attempt '${existingLaunchAttemptId}' is immutable and no longer matches ` +
                `the requested '${reviewType}' routing/context. Record-reviewer-launch-failed before creating a new audited attempt.`
            );
        }
        if (
            existingEvidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
            && existingAttestationState === 'launched'
            && !existingAttemptSuperseded
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
    const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath, reviewOutputAttemptSha256);
    const copyPasteReviewerLaunchPrompt = buildCopyPasteReviewerLaunchPrompt({
        repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
        executionProvider: providerLaunch.provider,
        taskId,
        reviewType,
        reviewContextSha256: contextSha256,
        reviewTreeStateSha256: reviewTreeStateSha256 || null,
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
        'reviewer_launch_attempt_id',
        'review_context_sha256',
        'routing_event_sha256',
        'reviewer_prompt_sha256',
        ...(handoffBindings.rolePromptSha256 ? ['role_prompt_sha256'] : []),
        'prompt_template_sha256',
        'output_template_sha256',
        'evidence_manifest_sha256',
        'copy_paste_reviewer_launch_prompt_sha256',
        'review_output_attempt_sha256',
        'review_tree_state_sha256',
        'launch_binding_sha256',
        'prepared_launch_event_sha256',
        'prepared_launch_event_task_sequence',
        'reviewer_launch_input_artifact_sha256',
        'reviewer_launch_input_pinned_event_sha256',
        'reviewer_launch_input_pinned_event_task_sequence'
    ];
    const handoffArtifactNames = handoffBindings.rolePromptPath
        ? 'role_prompt_path, prompt_template_path, reviewer_prompt_path, output_template_path, and evidence_manifest_path'
        : 'prompt_template_path, reviewer_prompt_path, output_template_path, and evidence_manifest_path';
    const preparedArtifact = {
        schema_version: 1,
        evidence_type: PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        attestation_state: 'prepared',
        task_id: taskId,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        review_type: reviewType,
        reviewer_execution_mode: reviewerExecutionMode,
        reviewer_identity: reviewerIdentity,
        planned_reviewer_identity: reviewerIdentity,
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
        review_output_attempt_sha256: reviewOutputAttemptSha256,
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
            delegation_started_at_utc: '<gate-owned UTC timestamp recorded by record-reviewer-delegation-started>',
            launched_at_utc: '<same delegation_started_at_utc value for compatibility>',
            launch_completed_at_utc: '<gate-owned ISO-8601 completion timestamp>',
            launch_input_mode: 'launch_artifact_path or copy_paste_prompt',
            launch_input_sha256: '<ReviewerLaunchInputArtifactSha256 for launch_artifact_path, or CopyPasteReviewerLaunchPromptSha256>',
            launch_input_artifact_path: '<ReviewerLaunchInputArtifactPath when launch_input_mode is launch_artifact_path>',
            launch_input_artifact_sha256: '<ReviewerLaunchInputArtifactSha256 when launch_input_mode is launch_artifact_path>',
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
        next_action: buildPreparedReviewerLaunchNextAction(handoffArtifactNames)
    };
    writeReviewArtifactJson(laneReservationPath, {
        schema_version: 1,
        evidence_type: REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE,
        task_id: taskId,
        review_type: reviewType,
        reviewer_launch_attempt_id: reviewerLaunchAttemptId,
        reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventProvenance.event_sha256,
        launch_binding_sha256: launchBindingSha256,
        reserved_at_utc: launchPreparedAtUtc,
        generated_by: 'garda prepare-reviewer-launch'
    });
    writeReviewArtifactJson(launchArtifactPath, preparedArtifact);
    const preparedEvent = await emitPreparedLaunchEventForAttemptAsync(
        launchPreparedAtUtc,
        copyPasteReviewerLaunchPromptSha256
    );
    if (!preparedEvent || taskEventAppendHasBlockingFailure(preparedEvent, false) || !preparedEvent.integrity?.event_sha256) {
        throw new Error(
            `Reviewer launch preparation requires REVIEWER_LAUNCH_PREPARED telemetry for '${reviewType}'. ` +
            'The lifecycle event could not be persisted; the reserved control artifact was retained for a safe retry.'
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
    const reviewerLaunchInputArtifact = buildReviewerLaunchInputHandoffArtifact({
        repoRoot: toReviewerHandoffAbsolutePath(repoRoot, repoRoot),
        executionProvider: providerLaunch.provider,
        taskId,
        reviewerLaunchAttemptId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewContextPath: toReviewerHandoffAbsolutePath(repoRoot, contextPath),
        reviewContextSha256: contextSha256,
        routingEventSha256: routingEventProvenance.event_sha256,
        routingEventTaskSequence: routingEventProvenance.task_sequence,
        launchBindingSha256,
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
        reviewOutputPath: toReviewerHandoffAbsolutePath(repoRoot, reviewOutputPath),
        reviewOutputAttemptSha256,
        reviewTreeStateSha256: reviewTreeStateSha256 || null,
        copyPasteReviewerLaunchPromptSha256,
        preparedLaunchEventSha256,
        preparedLaunchEventTaskSequence,
        localTrustBoundary: LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY
    });
    writeReviewArtifactJson(launchInputArtifactPath, reviewerLaunchInputArtifact);
    const pinnedReviewerLaunchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
    if (!pinnedReviewerLaunchInputArtifactSha256) {
        throw new Error('Reviewer launch input artifact must be hashable immediately after prepare-reviewer-launch.');
    }
    const pinnedInputEvent = await emitReviewerLaunchInputPinnedEventAsync(
        gateHelpers.joinOrchestratorPath(repoRoot, ''),
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        contextSha256,
        routingEventProvenance.event_sha256,
        launchBindingSha256,
        reviewerLaunchAttemptId,
        preparedLaunchEventSha256,
        normalizePath(launchArtifactPath),
        normalizePath(launchInputArtifactPath),
        pinnedReviewerLaunchInputArtifactSha256
    );
    if (
        !pinnedInputEvent
        || taskEventAppendHasBlockingFailure(pinnedInputEvent, false)
        || !pinnedInputEvent.integrity?.event_sha256
    ) {
        removeArtifactIfExists(launchInputArtifactPath);
        throw new Error(
            `Reviewer launch preparation requires REVIEWER_LAUNCH_INPUT_PINNED telemetry for '${reviewType}'. ` +
            'The immutable reviewer-facing handoff hash could not be persisted; ' +
            'the prepared control artifact was retained for a safe retry.'
        );
    }
    const pinnedInputEventSha256 = String(pinnedInputEvent.integrity.event_sha256 || '').trim().toLowerCase();
    const preparedArtifactWithPinnedInput = {
        ...preparedArtifactWithEvent,
        reviewer_launch_input_artifact_sha256: pinnedReviewerLaunchInputArtifactSha256,
        reviewer_launch_input_pinned_event_sha256: pinnedInputEventSha256,
        reviewer_launch_input_pinned_event_task_sequence: pinnedInputEvent.integrity.task_sequence
    };
    writeReviewArtifactJson(launchArtifactPath, preparedArtifactWithPinnedInput);
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
        reviewerLaunchInputArtifactSha256: pinnedReviewerLaunchInputArtifactSha256,
        copyPasteReviewerLaunchPrompt,
        copyPasteReviewerLaunchPromptSha256,
        reviewTreeStateSha256,
        timelineEvents: readDependencyTimelineEvents(timelinePath)
    });
    const launchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
    if (launchInputArtifactSha256 !== pinnedReviewerLaunchInputArtifactSha256) {
        throw new Error(
            'Reviewer launch input artifact must remain byte-for-byte identical to the immutable prepare-time handoff copy.'
        );
    }
    const preparedLaunchCommands = buildPreparedReviewerLaunchCommandSet({
        repoRoot,
        taskId,
        reviewType,
        reviewContextPath: contextPath,
        launchArtifactPath,
        launchInputArtifactPath,
        launchInputArtifactSha256,
        copyPasteReviewerLaunchPromptSha256
    });
    const preparedArtifactWithCommands = {
        ...preparedArtifactWithPinnedInput,
        record_reviewer_delegation_started_launch_artifact_path_command:
            preparedLaunchCommands.recordDelegationStartedLaunchArtifactPath,
        record_reviewer_delegation_started_copy_paste_prompt_command:
            preparedLaunchCommands.recordDelegationStartedCopyPastePrompt,
        complete_reviewer_launch_launch_artifact_path_command:
            preparedLaunchCommands.completeLaunchArtifactPath,
        complete_reviewer_launch_copy_paste_prompt_command:
            preparedLaunchCommands.completeCopyPastePrompt,
        record_reviewer_launch_failed_command: preparedLaunchCommands.recordLaunchFailed
    };
    writeReviewArtifactJson(launchArtifactPath, preparedArtifactWithCommands);
    const launchArtifactSha256 = fileSha256(launchArtifactPath) || '';

    console.log(buildOperatorNextActionBlock({
        status: 'PASSED',
        gate: 'prepare-reviewer-launch',
        action: 'Launch one clean-context delegated reviewer',
        reason: `Reviewer launch metadata prepared for '${reviewType}'.`,
        commandReference: 'launch the reviewer with exactly one handoff mode, then run the matching RecordReviewerDelegationStarted*Command below',
        detailsPath: launchArtifactPath,
        detailsHint: 'Launch artifact paths, hashes, and copy-paste reviewer instructions are listed below.'
    }).join('\n'));
    console.log('');
    console.log(`REVIEWER_LAUNCH_PREPARED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`RepoRoot: ${toReviewerHandoffAbsolutePath(repoRoot, repoRoot)}`);
    console.log(`ReviewContextPath: ${toReviewerHandoffAbsolutePath(repoRoot, contextPath)}`);
    console.log(`ReviewContextSha256: ${contextSha256}`);
    console.log(`RoutingEventSha256: ${routingEventProvenance.event_sha256}`);
    console.log(`LaunchBindingSha256: ${launchBindingSha256}`);
    console.log(`PreparedLaunchEventSha256: ${preparedLaunchEventSha256}`);
    console.log(`ReviewerLaunchAttemptId: ${reviewerLaunchAttemptId}`);
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
    printReviewerLaunchHandoffLines();
    console.log(`CopyPasteReviewerLaunchPromptSha256: ${copyPasteReviewerLaunchPromptSha256}`);
    console.log('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256; launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields, not CLI flags.');
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
    console.log(`RecordReviewerDelegationStartedLaunchArtifactPathCommand: ${preparedLaunchCommands.recordDelegationStartedLaunchArtifactPath}`);
    console.log(`RecordReviewerDelegationStartedCopyPastePromptCommand: ${preparedLaunchCommands.recordDelegationStartedCopyPastePrompt}`);
    console.log(`CompleteReviewerLaunchLaunchArtifactPathCommand: ${preparedLaunchCommands.completeLaunchArtifactPath}`);
    console.log(`CompleteReviewerLaunchCopyPastePromptCommand: ${preparedLaunchCommands.completeCopyPastePrompt}`);
    console.log(`RecordReviewerLaunchFailedCommand: ${preparedLaunchCommands.recordLaunchFailed}`);
    console.log(`RecordInvocationCommand: ${recordInvocationCommand}`);
    printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
    console.log(`NextStep: ${buildReviewerLaunchNextAction()}`);
    });
}

;
}
