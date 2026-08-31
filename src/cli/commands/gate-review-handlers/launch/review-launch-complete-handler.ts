import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceiptReviewerProvenance,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    assertValidTaskId,
    emitReviewerLaunchCompletedEventAsync,
    fileSha256,
    gateHelpers,
    normalizePath,
    resolveCanonicalReviewContextPath,
    resolveReviewerPromptArtifactBinding,
    taskEventAppendHasBlockingFailure,
    writeReviewArtifactJson
} from './review-launch-entrypoints';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { buildRecordReviewResultCommand } from './reviewer-handoff-support';
import { isPlannedReviewerIdentity } from '../../../../gate-runtime/review/reviewer-identity-contract';
import { writeFileAtomically } from '../../../../core/filesystem';
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';
import {
    getReviewerLaunchLaneReservationPath,
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';
import {
    findMatchingReviewerLaunchCompletedEvent
} from './review-launch-artifact-fields';
import {
    validateReviewerLaunchArtifact
} from './review-launch-completed-artifact';
import {
    assertArtifactReviewLaneEvidence,
    assertCanonicalReviewTypeId,
    resolveAuthenticatedReviewLaneContract
} from '../review-lane-contract';
import {
    assertReviewExecutionRuntimeBindings,
    resolveReviewExecutionRuntimeBindings
} from '../context/review-context-runtime-validation';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function persistReviewerLaunchCompletionTransition(options: {
    artifactPath: string;
    originalArtifactText: string;
    completedArtifact: Record<string, unknown>;
    recoveringPersistedCompletion: boolean;
    reviewType: string;
    emitCompletedEvent: (completedArtifactSha256: string) => Promise<boolean>;
    hasMatchingCompletedEvent: (completedArtifactSha256: string) => boolean;
}): Promise<{
    completedArtifactSha256: string;
    reusedExistingEvent: boolean;
}> {
    if (!options.recoveringPersistedCompletion) {
        writeReviewArtifactJson(options.artifactPath, options.completedArtifact);
    }
    const completedArtifactSha256 = fileSha256(options.artifactPath) || '';
    if (!completedArtifactSha256) {
        if (!options.recoveringPersistedCompletion) {
            writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
        }
        throw new Error(
            `Reviewer launch completion requires a hashable completed launch artifact for '${options.reviewType}'.`
        );
    }
    if (options.hasMatchingCompletedEvent(completedArtifactSha256)) {
        return {
            completedArtifactSha256,
            reusedExistingEvent: true
        };
    }

    let appendFailure: unknown = null;
    let appendCommitted = false;
    try {
        appendCommitted = await options.emitCompletedEvent(completedArtifactSha256);
    } catch (error) {
        appendFailure = error;
    }
    if (appendCommitted || options.hasMatchingCompletedEvent(completedArtifactSha256)) {
        return {
            completedArtifactSha256,
            reusedExistingEvent: false
        };
    }

    const appendFailureSuffix = appendFailure
        ? ` Cause: ${getErrorMessage(appendFailure)}`
        : '';
    if (options.recoveringPersistedCompletion) {
        throw new Error(
            `Reviewer launch completion requires REVIEWER_LAUNCH_COMPLETED telemetry for '${options.reviewType}'. ` +
            'The recoverable launched artifact was retained so the same completion attempt can be retried.' +
            appendFailureSuffix
        );
    }
    try {
        writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
    } catch (rollbackError) {
        throw new Error(
            `Reviewer launch completion requires REVIEWER_LAUNCH_COMPLETED telemetry for '${options.reviewType}'. ` +
            `Telemetry persistence failed and the delegation-started artifact rollback also failed: ` +
            `${getErrorMessage(rollbackError)}.` +
            appendFailureSuffix
        );
    }
    throw new Error(
        `Reviewer launch completion requires REVIEWER_LAUNCH_COMPLETED telemetry for '${options.reviewType}'. ` +
        'The original delegation-started artifact was restored because telemetry could not be persisted.' +
        appendFailureSuffix
    );
}

export interface CompleteReviewerLaunchHandlerDependencies {
    assertPreparedReviewerLaunchArtifact: typeof import('../index').assertPreparedReviewerLaunchArtifact;
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE: typeof import('../index').COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    getStringField: typeof import('../index').getStringField;
    handleRecordReviewInvocationWithLaneHeld: (gateArgv: string[]) => Promise<void>;
    isForbiddenReviewerLaunchAttestationSource: typeof import('../index').isForbiddenReviewerLaunchAttestationSource;
    LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY: typeof import('../index').LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY;
    normalizeReviewerLaunchAttestationSource: typeof import('../index').normalizeReviewerLaunchAttestationSource;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    readJsonFile: typeof import('../index').readJsonFile;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
    resolveReviewerLaunchInputAttestation: typeof import('../index').resolveReviewerLaunchInputAttestation;
}

export function createCompleteReviewerLaunchHandler(deps: CompleteReviewerLaunchHandlerDependencies) {
    const {
        assertPreparedReviewerLaunchArtifact,
        COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
        findMatchingRoutingEvent,
        getReviewTreeStateSha256,
        getStringField,
        handleRecordReviewInvocationWithLaneHeld,
        isForbiddenReviewerLaunchAttestationSource,
        LOCAL_REVIEWER_LAUNCH_TRUST_BOUNDARY,
        normalizeReviewerLaunchAttestationSource,
        parseReviewerIdentity,
        readJsonFile,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerHandoffBindings,
        resolveReviewerLaunchArtifactPathForWrite,
        resolveReviewerLaunchInputArtifactPath,
        resolveReviewerLaunchInputAttestation
    } = deps;

return async function handleCompleteReviewerLaunch(gateArgv: string[]): Promise<void> {
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
    const reviewType = assertCanonicalReviewTypeId(options.reviewType);

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'complete-reviewer-launch', 'review_phase');
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
    const { reviewerExecutionMode, reviewerIdentity } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'."
    );

    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const controllerInvocationId = String(options.controllerInvocationId || '').trim();
    if (providerInvocationId && controllerInvocationId) {
        throw new Error('Provide either --provider-invocation-id or --controller-invocation-id, not both.');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'launchedAtUtc')) {
        throw new Error(
            'Caller-supplied --launched-at-utc is not accepted for complete-reviewer-launch. ' +
            'This is spoof-like launch freshness input; omit the flag so the gate records its own UTC timestamp.'
        );
    }
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
    const reviewExecutionBindings = resolveReviewExecutionRuntimeBindings(parsedReviewContext);
    const reviewLaneContract = resolveAuthenticatedReviewLaneContract({
        preflight: readJsonFile(preflightPath, 'Preflight artifact'),
        reviewContext: parsedReviewContext,
        reviewType
    });
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
    const originalArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
    const preparedArtifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
    const launchInputArtifact = readJsonFile(launchInputArtifactPath, 'Reviewer launch input artifact');
    const laneReservation = readJsonFile(
        getReviewerLaunchLaneReservationPath(canonicalLaunchArtifactPath),
        'Reviewer launch lane reservation'
    );
    assertArtifactReviewLaneEvidence(preparedArtifact, reviewLaneContract, 'Reviewer launch artifact');
    assertArtifactReviewLaneEvidence(
        launchInputArtifact,
        reviewLaneContract,
        'Reviewer launch input artifact'
    );
    assertArtifactReviewLaneEvidence(
        laneReservation,
        reviewLaneContract,
        'Reviewer launch lane reservation'
    );
    assertReviewExecutionRuntimeBindings(
        preparedArtifact,
        reviewExecutionBindings,
        'Reviewer launch artifact'
    );
    assertReviewExecutionRuntimeBindings(
        launchInputArtifact,
        reviewExecutionBindings,
        'Reviewer launch input artifact'
    );
    assertReviewExecutionRuntimeBindings(
        laneReservation,
        reviewExecutionBindings,
        'Reviewer launch lane reservation'
    );
    const artifactEvidenceType = getStringField(
        preparedArtifact,
        'evidence_type',
        'evidenceType',
        'artifact_type',
        'artifactType'
    );
    const artifactAttestationState = getStringField(
        preparedArtifact,
        'attestation_state',
        'attestationState'
    );
    const recoveringPersistedCompletion =
        artifactEvidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        && artifactAttestationState === 'launched';
    const reviewerLaunchAttemptId = getStringField(
        preparedArtifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    );
    const plannedReviewerIdentity = getStringField(
        preparedArtifact,
        'planned_reviewer_identity',
        'plannedReviewerIdentity'
    ) || getStringField(
        preparedArtifact,
        'reviewer_identity',
        'reviewerIdentity',
        'reviewer_session_id',
        'reviewerSessionId'
    );
    if (!plannedReviewerIdentity) {
        throw new Error('Reviewer launch artifact is missing planned reviewer identity metadata.');
    }
    const routingReviewerIdentity = isPlannedReviewerIdentity(plannedReviewerIdentity)
        ? plannedReviewerIdentity
        : reviewerIdentity;
    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        routingReviewerIdentity,
        null
    );
    if (!routingEvent) {
        throw new Error(
            `Reviewer launch completion requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${routingReviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer launch completion requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
    if (recoveringPersistedCompletion) {
        validateReviewerLaunchArtifact({
            repoRoot,
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
            reviewTreeStateSha256,
            routingEventSequence: routingEvent.sequence,
            timelineEvents,
            artifactPathValue: launchArtifactPath,
            allowMissingCompletedEventForRecovery: true
        });
    } else {
        assertPreparedReviewerLaunchArtifact({
            artifactPath: launchArtifactPath,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity: routingReviewerIdentity,
            ...(reviewerIdentity !== routingReviewerIdentity
                ? { resolvedReviewerIdentity: reviewerIdentity }
                : {}),
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerPromptSha256: promptBinding.reviewerPromptSha256,
            rolePromptSha256: handoffBindings.rolePromptSha256,
            promptTemplateSha256: handoffBindings.promptTemplateSha256,
            outputTemplateSha256: handoffBindings.outputTemplateSha256,
            evidenceManifestSha256: handoffBindings.evidenceManifestSha256,
            reviewerLaunchInputArtifactPath: launchInputArtifactPath,
            reviewTreeStateSha256,
            allowedAttestationStates: ['delegation_started'],
            timelineEvents
        });
    }
    const preparedLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const artifactProviderInvocationId = getStringField(preparedArtifact, 'provider_invocation_id', 'providerInvocationId');
    const artifactControllerInvocationId = getStringField(preparedArtifact, 'controller_invocation_id', 'controllerInvocationId');
    if (providerInvocationId && artifactProviderInvocationId && providerInvocationId !== artifactProviderInvocationId) {
        throw new Error('ProviderInvocationId must match the recorded reviewer delegation start artifact.');
    }
    if (controllerInvocationId && artifactControllerInvocationId && controllerInvocationId !== artifactControllerInvocationId) {
        throw new Error('ControllerInvocationId must match the recorded reviewer delegation start artifact.');
    }
    if (
        recoveringPersistedCompletion
        && providerInvocationId
        && !artifactProviderInvocationId
    ) {
        throw new Error('Completion recovery cannot replace a controller invocation with a provider invocation.');
    }
    if (
        recoveringPersistedCompletion
        && controllerInvocationId
        && !artifactControllerInvocationId
    ) {
        throw new Error('Completion recovery cannot replace a provider invocation with a controller invocation.');
    }
    if (
        recoveringPersistedCompletion
        && getStringField(preparedArtifact, 'attestation_source', 'attestationSource') !== attestationSource
    ) {
        throw new Error('Completion recovery attestation source must match the persisted launched artifact.');
    }
    const effectiveProviderInvocationId = providerInvocationId || artifactProviderInvocationId;
    const effectiveControllerInvocationId = controllerInvocationId || artifactControllerInvocationId;
    if (!effectiveProviderInvocationId && !effectiveControllerInvocationId) {
        throw new Error(
            'ProviderInvocationId or ControllerInvocationId is required. ' +
            'Run record-reviewer-delegation-started immediately after launching the delegated reviewer.'
        );
    }
    const delegationStartedAtUtc = getStringField(
        preparedArtifact,
        'delegation_started_at_utc',
        'delegationStartedAtUtc'
    );
    if (!delegationStartedAtUtc) {
        throw new Error(
            'delegation_started_at_utc is required. Run record-reviewer-delegation-started immediately after launching the delegated reviewer before complete-reviewer-launch.'
        );
    }
    const effectiveDelegationStartedAtUtc = delegationStartedAtUtc;
    const launchInputAttestation = resolveReviewerLaunchInputAttestation({
        repoRoot,
        launchArtifactPath,
        preparedArtifact,
        preparedLaunchArtifactSha256,
        rawMode: options.launchInputMode || preparedArtifact.launch_input_mode,
        rawSha256: options.launchInputSha256 || preparedArtifact.launch_input_sha256,
        rawArtifactPath: options.launchInputArtifactPath || preparedArtifact.launch_input_artifact_path
    });
    const launchCompletedAtUtc = recoveringPersistedCompletion
        ? getStringField(preparedArtifact, 'launch_completed_at_utc', 'launchCompletedAtUtc')
        : new Date().toISOString();
    if (!launchCompletedAtUtc) {
        throw new Error('Completion recovery requires persisted launch_completed_at_utc metadata.');
    }
    const completedArtifact: Record<string, unknown> = recoveringPersistedCompletion
        ? preparedArtifact
        : {
            ...preparedArtifact,
            evidence_type: COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
            attestation_state: 'launched',
            attestation_source: attestationSource,
            launch_input_mode: launchInputAttestation.mode,
            launch_input_sha256: launchInputAttestation.sha256,
            launch_input_attestation_source: 'complete-reviewer-launch',
            launch_input_verified_at_utc: launchCompletedAtUtc,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: launchInputAttestation.copyPasteReviewerLaunchPromptSha256,
            delegation_started_at_utc: effectiveDelegationStartedAtUtc,
            launched_at_utc: effectiveDelegationStartedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc
        };
    if (!recoveringPersistedCompletion) {
        if (launchInputAttestation.artifactPath) {
            completedArtifact.launch_input_artifact_path = normalizePath(launchInputAttestation.artifactPath);
        }
        if (launchInputAttestation.artifactSha256) {
            completedArtifact.launch_input_artifact_sha256 = launchInputAttestation.artifactSha256;
            completedArtifact.prepared_reviewer_launch_artifact_sha256 = launchInputAttestation.artifactSha256;
        }
        if (effectiveProviderInvocationId) {
            completedArtifact.provider_invocation_id = effectiveProviderInvocationId;
        } else {
            completedArtifact.controller_invocation_id = effectiveControllerInvocationId;
        }
        if (options.freshContext === true) {
            completedArtifact.fresh_context = true;
        }
        if (options.isolatedContext === true) {
            completedArtifact.isolated_context = true;
        }
        if (options.forkContext !== undefined) {
            completedArtifact.fork_context = options.forkContext;
        }
    }

    const effectiveInvocationId = effectiveProviderInvocationId || effectiveControllerInvocationId;
    const findPersistedCompletedEvent = (completedArtifactSha256: string) =>
        findMatchingReviewerLaunchCompletedEvent(
            readDependencyTimelineEvents(timelinePath),
            {
                taskId,
                reviewType,
                reviewerExecutionMode,
                reviewerIdentity: routingReviewerIdentity,
                reviewContextSha256: contextSha256,
                routingEventSha256: routingEventProvenance.event_sha256,
                reviewerLaunchAttemptId,
                reviewerLaunchArtifactSha256: completedArtifactSha256,
                providerInvocationId: effectiveInvocationId,
                delegationStartedAtUtc: effectiveDelegationStartedAtUtc,
                launchCompletedAtUtc,
                minSequenceExclusive: routingEvent.sequence
            }
        );
    const existingCompletionForAttempt = timelineEvents.find((event) => (
        event.event_type === 'REVIEWER_LAUNCH_COMPLETED'
        && event.sequence > routingEvent.sequence
        && getStringField(
            event.details || {},
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase() === reviewerLaunchAttemptId.toLowerCase()
    ));
    if (
        existingCompletionForAttempt
        && !findMatchingReviewerLaunchCompletedEvent(timelineEvents, {
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity: routingReviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerLaunchAttemptId,
            reviewerLaunchArtifactSha256: preparedLaunchArtifactSha256,
            providerInvocationId: effectiveInvocationId,
            delegationStartedAtUtc: effectiveDelegationStartedAtUtc,
            launchCompletedAtUtc,
            minSequenceExclusive: routingEvent.sequence
        })
    ) {
        throw new Error(
            'Completion recovery found conflicting REVIEWER_LAUNCH_COMPLETED telemetry for the same immutable launch attempt.'
        );
    }

    const { completedArtifactSha256: completedLaunchArtifactSha256 } =
        await persistReviewerLaunchCompletionTransition({
            artifactPath: launchArtifactPath,
            originalArtifactText,
            completedArtifact,
            recoveringPersistedCompletion,
            reviewType,
            hasMatchingCompletedEvent: (completedArtifactSha256) =>
                Boolean(findPersistedCompletedEvent(completedArtifactSha256)),
            emitCompletedEvent: async (completedArtifactSha256) => {
                const completedEvent = await emitReviewerLaunchCompletedEventAsync(
                    gateHelpers.joinOrchestratorPath(repoRoot, ''),
                    taskId,
                    reviewType,
                    reviewerExecutionMode,
                    reviewerIdentity,
                    contextSha256,
                    routingEventProvenance.event_sha256,
                    {
                        launchDetails: {
                            reviewer_launch_artifact_path: normalizePath(launchArtifactPath),
                            reviewer_launch_attempt_id: reviewerLaunchAttemptId,
                            reviewer_launch_artifact_sha256: completedArtifactSha256,
                            reviewer_launch_attestation_source: attestationSource,
                            launch_tool: getStringField(completedArtifact, 'launch_tool', 'launchTool'),
                            provider_invocation_id: effectiveProviderInvocationId || null,
                            controller_invocation_id: effectiveControllerInvocationId || null,
                            launch_input_mode: launchInputAttestation.mode,
                            launch_input_sha256: launchInputAttestation.sha256,
                            launch_input_artifact_path: launchInputAttestation.artifactPath
                                ? normalizePath(launchInputAttestation.artifactPath)
                                : null,
                            launch_input_artifact_sha256: launchInputAttestation.artifactSha256,
                            copy_paste_reviewer_launch_prompt_sha256: launchInputAttestation.copyPasteReviewerLaunchPromptSha256,
                            launch_prepared_at_utc: getStringField(completedArtifact, 'launch_prepared_at_utc', 'launchPreparedAtUtc'),
                            delegation_started_at_utc: effectiveDelegationStartedAtUtc,
                            launched_at_utc: effectiveDelegationStartedAtUtc,
                            launch_completed_at_utc: launchCompletedAtUtc,
                            review_tree_state_sha256: reviewTreeStateSha256 || null,
                            ...reviewExecutionBindings
                        }
                    }
                );
                return Boolean(
                    completedEvent
                    && !taskEventAppendHasBlockingFailure(completedEvent, false)
                );
            }
        });

    const invocationId = effectiveInvocationId;
    const invocationIdLabel = effectiveProviderInvocationId ? 'ProviderInvocationId' : 'ControllerInvocationId';
    const recordCommand = getStringField(preparedArtifact, 'record_invocation_command', 'recordInvocationCommand');
    const reviewOutputPath = getStringField(completedArtifact, 'review_output_path', 'reviewOutputPath')
        || '<ReviewOutputPath>';
    const recordReviewResultCommand = options.recordInvocation === true
        ? buildRecordReviewResultCommand({
            repoRoot,
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity,
            preflightPath,
            reviewContextPath: contextPath,
            reviewOutputPath,
            taskModePath: options.taskModePath ? String(options.taskModePath) : null
        })
        : '';
    console.log(buildOperatorNextActionBlock({
        status: 'PASSED',
        gate: 'complete-reviewer-launch',
        action: options.recordInvocation === true
            ? 'Record delegated review result'
            : 'Record delegated review invocation',
        reason: `Reviewer launch completion recorded for '${reviewType}'.`,
        command: options.recordInvocation === true
            ? recordReviewResultCommand
            : (recordCommand || undefined),
        commandReference: options.recordInvocation === true
            ? undefined
            : 'run RecordInvocationCommand below',
        detailsPath: launchArtifactPath,
        detailsHint: 'Completion attestation and next review-recording command are listed below.'
    }).join('\n'));
    console.log('');
    console.log(`REVIEWER_LAUNCH_COMPLETED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`LaunchArtifactSha256: ${completedLaunchArtifactSha256}`);
    console.log(`${invocationIdLabel}: ${invocationId}`);
    console.log(`DelegationStartedAtUtc: ${effectiveDelegationStartedAtUtc}`);
    console.log(`LaunchedAtUtc: ${effectiveDelegationStartedAtUtc}`);
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
    if (recordCommand) {
        console.log(`RecordInvocationCommand: ${recordCommand}`);
    }
    if (options.recordInvocation === true) {
        await handleRecordReviewInvocationWithLaneHeld([
            '--task-id', taskId,
            '--review-type', reviewType,
            '--reviewer-execution-mode', reviewerExecutionMode,
            '--reviewer-identity', reviewerIdentity,
            '--reviewer-launch-artifact-path', launchArtifactPath,
            ...(options.reviewContextPath ? ['--review-context-path', String(options.reviewContextPath)] : []),
            ...(options.taskModePath ? ['--task-mode-path', String(options.taskModePath)] : []),
            '--repo-root', repoRoot
        ]);
        console.log(`RecordReviewResultCommand: ${recordReviewResultCommand}`);
        console.log('NextStep: record-review-invocation was attested by complete-reviewer-launch; run RecordReviewResultCommand after the delegated reviewer returns.');
        return;
    }
    console.log('NextStep: run RecordInvocationCommand to attest the invocation.');
    });
}

;
}
