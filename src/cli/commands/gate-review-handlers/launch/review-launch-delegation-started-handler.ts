import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceiptReviewerProvenance,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    assertValidTaskId,
    emitReviewerDelegationStartedEventAsync,
    fileSha256,
    gateHelpers,
    normalizePath,
    resolveCanonicalReviewContextPath,
    resolveReviewerPromptArtifactBinding,
    taskEventAppendHasBlockingFailure,
    writeReviewArtifactJson
} from './review-launch-entrypoints';
import {
    isPlannedReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import { writeFileAtomically } from '../../../../core/filesystem';
import {
    resolveRuntimeReviewerIdentity
} from '../../../../gates/review/reviewer-routing';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
import { buildOperatorNextActionBlock } from '../../../../gates/shared/operator-action-output';
import {
    buildCompleteReviewerLaunchCommand,
    buildRecordReviewerLaunchFailedCommand
} from './reviewer-handoff-support';
import {
    withReviewerLaunchLaneTransaction
} from './reviewer-launch-lane-transaction';
import {
    findMatchingReviewerDelegationStartedEvent,
    isValidUtcIso8601Timestamp,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
} from './review-launch-artifact-fields';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export async function persistReviewerDelegationStartedTransition(options: {
    artifactPath: string;
    originalArtifactText: string;
    startedArtifact: Record<string, unknown>;
    recoveringPersistedDelegationStart: boolean;
    reviewType: string;
    emitStartedEvent: (startedArtifactSha256: string) => Promise<boolean>;
    hasMatchingStartedEvent: (startedArtifactSha256: string) => boolean;
}): Promise<{
    startedArtifactSha256: string;
    reusedExistingEvent: boolean;
}> {
    if (!options.recoveringPersistedDelegationStart) {
        writeReviewArtifactJson(options.artifactPath, options.startedArtifact);
    }
    const startedArtifactSha256 = fileSha256(options.artifactPath) || '';
    if (!startedArtifactSha256) {
        if (!options.recoveringPersistedDelegationStart) {
            writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
        }
        throw new Error(
            `Reviewer delegation start requires a hashable launch artifact for '${options.reviewType}'.`
        );
    }
    if (options.hasMatchingStartedEvent(startedArtifactSha256)) {
        return {
            startedArtifactSha256,
            reusedExistingEvent: true
        };
    }

    let appendFailure: unknown = null;
    let appendCommitted = false;
    try {
        appendCommitted = await options.emitStartedEvent(startedArtifactSha256);
    } catch (error) {
        appendFailure = error;
    }
    if (appendCommitted || options.hasMatchingStartedEvent(startedArtifactSha256)) {
        return {
            startedArtifactSha256,
            reusedExistingEvent: false
        };
    }

    const appendFailureSuffix = appendFailure
        ? ` Cause: ${getErrorMessage(appendFailure)}`
        : '';
    if (options.recoveringPersistedDelegationStart) {
        throw new Error(
            `Reviewer delegation start requires REVIEWER_DELEGATION_STARTED telemetry for '${options.reviewType}'. ` +
            'The recoverable delegation-started artifact was retained so the same start attempt can be retried.' +
            appendFailureSuffix
        );
    }
    try {
        writeFileAtomically(options.artifactPath, options.originalArtifactText, { encoding: 'utf8' });
    } catch (rollbackError) {
        throw new Error(
            `Reviewer delegation start requires REVIEWER_DELEGATION_STARTED telemetry for '${options.reviewType}'. ` +
            `Telemetry persistence failed and the prepared artifact rollback also failed: ` +
            `${getErrorMessage(rollbackError)}.` +
            appendFailureSuffix
        );
    }
    throw new Error(
        `Reviewer delegation start requires REVIEWER_DELEGATION_STARTED telemetry for '${options.reviewType}'. ` +
        'The original prepared artifact was restored because telemetry could not be persisted.' +
        appendFailureSuffix
    );
}

export interface ReviewerDelegationStartedHandlerDependencies {
    assertPreparedReviewerLaunchArtifact: typeof import('../index').assertPreparedReviewerLaunchArtifact;
    buildRecordReviewInvocationCommand: typeof import('../index').buildRecordReviewInvocationCommand;
    findMatchingRoutingEvent: typeof import('../index').findMatchingRoutingEvent;
    getReviewTreeStateSha256: typeof import('../index').getReviewTreeStateSha256;
    getStringField: typeof import('../index').getStringField;
    isForbiddenReviewerLaunchAttestationSource: typeof import('../index').isForbiddenReviewerLaunchAttestationSource;
    normalizeReviewerLaunchAttestationSource: typeof import('../index').normalizeReviewerLaunchAttestationSource;
    parseReviewerIdentity: typeof import('../index').parseReviewerIdentity;
    readJsonFile: typeof import('../index').readJsonFile;
    resolveCanonicalPreflightArtifactPath: typeof import('../index').resolveCanonicalPreflightArtifactPath;
    resolveReviewerHandoffBindings: typeof import('../index').resolveReviewerHandoffBindings;
    resolveReviewerLaunchArtifactPathForWrite: typeof import('../index').resolveReviewerLaunchArtifactPathForWrite;
    resolveReviewerLaunchInputArtifactPath: typeof import('../index').resolveReviewerLaunchInputArtifactPath;
    resolveReviewerLaunchInputAttestation: typeof import('../index').resolveReviewerLaunchInputAttestation;
}

export function createReviewerDelegationStartedHandler(deps: ReviewerDelegationStartedHandlerDependencies) {
    const {
        assertPreparedReviewerLaunchArtifact,
        buildRecordReviewInvocationCommand,
        findMatchingRoutingEvent,
        getReviewTreeStateSha256,
        getStringField,
        isForbiddenReviewerLaunchAttestationSource,
        normalizeReviewerLaunchAttestationSource,
        parseReviewerIdentity,
        readJsonFile,
        resolveCanonicalPreflightArtifactPath,
        resolveReviewerHandoffBindings,
        resolveReviewerLaunchArtifactPathForWrite,
        resolveReviewerLaunchInputArtifactPath,
        resolveReviewerLaunchInputAttestation
    } = deps;

return async function handleRecordReviewerDelegationStarted(gateArgv: string[]): Promise<void> {
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
        '--delegation-started-at-utc': { key: 'delegationStartedAtUtc', type: 'string' },
        '--attestation-source': { key: 'attestationSource', type: 'string' },
        '--launch-input-mode': { key: 'launchInputMode', type: 'string' },
        '--launch-input-sha256': { key: 'launchInputSha256', type: 'string' },
        '--launch-input-artifact-path': { key: 'launchInputArtifactPath', type: 'string' },
        '--fresh-context': { key: 'freshContext', type: 'boolean' },
        '--isolated-context': { key: 'isolatedContext', type: 'boolean' },
        '--fork-context': { key: 'forkContext', type: 'boolean' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-reviewer-delegation-started', 'review_phase');
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
    const runtimeIdentity = resolveRuntimeReviewerIdentity({
        repoRoot,
        taskId,
        taskModePath: String(options.taskModePath || '').trim(),
        allowLegacyFallback: true
    });
    if (runtimeIdentity.identity_status !== 'resolved') {
        throw new Error(
            `Reviewer delegation start requires resolved runtime reviewer identity, got '${runtimeIdentity.identity_status}'.`
        );
    }
    if (runtimeIdentity.violations.length > 0) {
        throw new Error(runtimeIdentity.violations.join(' '));
    }
    if (runtimeIdentity.reviewer_subagent_launch_status !== 'launchable') {
        const launchReason = runtimeIdentity.reviewer_subagent_launch_reason
            || 'Reviewer subagent launch is not currently attested.';
        const launchRemediation = runtimeIdentity.reviewer_subagent_launch_remediation
            ? ` ${runtimeIdentity.reviewer_subagent_launch_remediation}`
            : '';
        throw new Error(
            `Reviewer delegation start for review '${reviewType}' is blocked because reviewer subagent launch is ` +
            `'${runtimeIdentity.reviewer_subagent_launch_status}'. ${launchReason}${launchRemediation}`
        );
    }
    const { reviewerExecutionMode, reviewerIdentity } = parseReviewerIdentity(
        options,
        "ReviewerExecutionMode is required. Expected 'delegated_subagent'.",
        { requireResolvedIdentity: true }
    );

    const providerInvocationId = String(options.providerInvocationId || '').trim();
    const controllerInvocationId = String(options.controllerInvocationId || '').trim();
    if (!providerInvocationId && !controllerInvocationId) {
        throw new Error('ProviderInvocationId or ControllerInvocationId is required (the actual delegated reviewer invocation id).');
    }
    if (providerInvocationId && controllerInvocationId) {
        throw new Error('Provide either --provider-invocation-id or --controller-invocation-id, not both.');
    }
    if (Object.prototype.hasOwnProperty.call(options, 'delegationStartedAtUtc')) {
        throw new Error(
            'Caller-supplied --delegation-started-at-utc is not accepted. ' +
            'Omit the flag so the gate records its own UTC timestamp immediately after provider launch.'
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
        throw new Error(`Reviewer delegation start requires a hashable review-context artifact: ${normalizePath(contextPath)}.`);
    }
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    assertReviewTreeStateFresh({
        repoRoot,
        reviewContext: parsedReviewContext,
        contextPath,
        gateName: 'record-reviewer-delegation-started'
    });
    const promptBinding = resolveReviewerPromptArtifactBinding({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-reviewer-delegation-started'
    });
    const handoffBindings = resolveReviewerHandoffBindings({
        repoRoot,
        contextPath,
        reviewContext: parsedReviewContext,
        gateName: 'record-reviewer-delegation-started'
    });
    const reviewTreeStateSha256 = getReviewTreeStateSha256(parsedReviewContext);
    const originalArtifactText = fs.readFileSync(launchArtifactPath, 'utf8');
    const preparedArtifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
    const recoveringPersistedDelegationStart =
        getStringField(preparedArtifact, 'evidence_type', 'evidenceType', 'artifact_type', 'artifactType')
            === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
        && getStringField(preparedArtifact, 'attestation_state', 'attestationState')
            === 'delegation_started';
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
    if (!isPlannedReviewerIdentity(plannedReviewerIdentity) && plannedReviewerIdentity !== reviewerIdentity) {
        throw new Error(
            `Reviewer delegation start requires the prepared launch artifact reviewer identity to match '${reviewerIdentity}'.`
        );
    }
    if (isPlannedReviewerIdentity(plannedReviewerIdentity) && reviewerIdentity === plannedReviewerIdentity) {
        throw new Error(
            'Reviewer delegation start requires a resolved agent-scoped reviewer identity from the provider launch result; ' +
            'planned pending identities are not valid here.'
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const timelineEvents = readDependencyTimelineEvents(timelinePath);
    const routingReviewerIdentity = isPlannedReviewerIdentity(plannedReviewerIdentity)
        ? plannedReviewerIdentity
        : reviewerIdentity;
    const routingEvent = findMatchingRoutingEvent(
        timelineEvents,
        reviewType,
        reviewerExecutionMode,
        routingReviewerIdentity,
        null
    );
    if (!routingEvent) {
        throw new Error(
            `Reviewer delegation start requires current-cycle REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `and reviewer '${routingReviewerIdentity}'.`
        );
    }
    const routingEventProvenance = buildReviewReceiptReviewerProvenance(routingEvent.event_type, routingEvent.integrity);
    if (!routingEventProvenance) {
        throw new Error(
            `Reviewer delegation start requires integrity-backed REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}'.`
        );
    }
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
        allowedAttestationStates: recoveringPersistedDelegationStart
            ? ['delegation_started']
            : ['prepared'],
        timelineEvents
    });
    const preparedLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const artifactProviderInvocationId = getStringField(
        preparedArtifact,
        'provider_invocation_id',
        'providerInvocationId'
    );
    const artifactControllerInvocationId = getStringField(
        preparedArtifact,
        'controller_invocation_id',
        'controllerInvocationId'
    );
    if (
        recoveringPersistedDelegationStart
        && (
            providerInvocationId !== artifactProviderInvocationId
            || controllerInvocationId !== artifactControllerInvocationId
        )
    ) {
        throw new Error(
            'Delegation start recovery invocation identity must exactly match the persisted attempt.'
        );
    }
    if (
        recoveringPersistedDelegationStart
        && getStringField(preparedArtifact, 'attestation_source', 'attestationSource') !== attestationSource
    ) {
        throw new Error(
            'Delegation start recovery attestation source must match the persisted attempt.'
        );
    }
    const persistedFreshContext = preparedArtifact.fresh_context === true
        || preparedArtifact.freshContext === true
        || preparedArtifact.isolated_context === true
        || preparedArtifact.isolatedContext === true
        || preparedArtifact.fork_context === false
        || preparedArtifact.forkContext === false;
    if (recoveringPersistedDelegationStart && !persistedFreshContext) {
        throw new Error(
            'Delegation start recovery requires persisted clean-context attestation.'
        );
    }
    const launchInputAttestation = resolveReviewerLaunchInputAttestation({
        repoRoot,
        launchArtifactPath,
        preparedArtifact,
        preparedLaunchArtifactSha256,
        rawMode: options.launchInputMode || preparedArtifact.launch_input_mode,
        rawSha256: options.launchInputSha256 || preparedArtifact.launch_input_sha256,
        rawArtifactPath: options.launchInputArtifactPath || preparedArtifact.launch_input_artifact_path
    });
    const delegationStartedAtUtc = recoveringPersistedDelegationStart
        ? getStringField(
            preparedArtifact,
            'delegation_started_at_utc',
            'delegationStartedAtUtc'
        )
        : new Date().toISOString();
    if (
        !delegationStartedAtUtc
        || !isValidUtcIso8601Timestamp(delegationStartedAtUtc)
    ) {
        throw new Error(
            'Delegation start recovery requires a valid persisted delegation_started_at_utc timestamp.'
        );
    }
    const isPlannedIdentityRebind = isPlannedReviewerIdentity(plannedReviewerIdentity)
        && reviewerIdentity !== plannedReviewerIdentity;
    const startedArtifact: Record<string, unknown> = recoveringPersistedDelegationStart
        ? preparedArtifact
        : {
            ...preparedArtifact,
            reviewer_identity: reviewerIdentity,
            attestation_state: 'delegation_started',
            attestation_source: attestationSource,
            launch_input_mode: launchInputAttestation.mode,
            launch_input_sha256: launchInputAttestation.sha256,
            launch_input_attestation_source: 'record-reviewer-delegation-started',
            launch_input_verified_at_utc: delegationStartedAtUtc,
            launch_input_copy_paste_reviewer_launch_prompt_sha256: launchInputAttestation.copyPasteReviewerLaunchPromptSha256,
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: delegationStartedAtUtc
        };
    if (!recoveringPersistedDelegationStart) {
        if (isPlannedIdentityRebind) {
            startedArtifact.planned_reviewer_identity = plannedReviewerIdentity;
            startedArtifact.reviewer_identity_resolved_at_utc = delegationStartedAtUtc;
        }
        if (launchInputAttestation.artifactPath) {
            startedArtifact.launch_input_artifact_path = normalizePath(launchInputAttestation.artifactPath);
        }
        if (launchInputAttestation.artifactSha256) {
            startedArtifact.launch_input_artifact_sha256 = launchInputAttestation.artifactSha256;
            startedArtifact.prepared_reviewer_launch_artifact_sha256 = launchInputAttestation.artifactSha256;
        }
        if (providerInvocationId) {
            startedArtifact.provider_invocation_id = providerInvocationId;
        } else {
            startedArtifact.controller_invocation_id = controllerInvocationId;
        }
        if (options.freshContext === true) {
            startedArtifact.fresh_context = true;
        }
        if (options.isolatedContext === true) {
            startedArtifact.isolated_context = true;
        }
        if (options.forkContext !== undefined) {
            startedArtifact.fork_context = options.forkContext;
        }
        startedArtifact.record_invocation_command = buildRecordReviewInvocationCommand({
            repoRoot,
            taskId,
            reviewType,
            reviewerExecutionMode: 'delegated_subagent',
            reviewerIdentity,
            reviewContextPath: contextPath,
            reviewerLaunchArtifactPath: launchArtifactPath
        });
    }
    const invocationId = providerInvocationId || controllerInvocationId;
    const invocationIdLabel = providerInvocationId ? 'ProviderInvocationId' : 'ControllerInvocationId';
    const completeReviewerLaunchCommand = buildCompleteReviewerLaunchCommand({
        repoRoot,
        taskId,
        reviewType,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity,
        reviewContextPath: contextPath,
        reviewerLaunchArtifactPath: launchArtifactPath,
        providerInvocationId: providerInvocationId || null,
        controllerInvocationId: controllerInvocationId || null,
        attestationSource,
        launchInputMode: launchInputAttestation.mode,
        launchInputArtifactPath: launchInputAttestation.artifactPath,
        launchInputSha256: launchInputAttestation.sha256,
        forkContext: options.forkContext === true,
        recordInvocation: true
    });
    const recordReviewerLaunchFailedCommand = buildRecordReviewerLaunchFailedCommand({
        repoRoot,
        taskId,
        reviewType,
        reviewerExecutionMode: 'delegated_subagent',
        reviewerIdentity,
        reviewContextPath: contextPath,
        reviewerLaunchArtifactPath: launchArtifactPath,
        providerInvocationId: providerInvocationId || null,
        controllerInvocationId: controllerInvocationId || null,
        failureReason: '<replace with provider/controller failure reason>'
    });
    startedArtifact.complete_reviewer_launch_command = completeReviewerLaunchCommand;
    const effectiveInvocationId = providerInvocationId || controllerInvocationId;
    const findPersistedStartedEvent = (startedArtifactSha256?: string) => findMatchingReviewerDelegationStartedEvent(
        readDependencyTimelineEvents(timelinePath),
        {
            taskId,
            reviewType,
            reviewerExecutionMode,
            reviewerIdentity: routingReviewerIdentity,
            reviewContextSha256: contextSha256,
            routingEventSha256: routingEventProvenance.event_sha256,
            reviewerLaunchAttemptId,
            launchBindingSha256: getStringField(
                startedArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ),
            preparedLaunchEventSha256: getStringField(
                startedArtifact,
                'prepared_launch_event_sha256',
                'preparedLaunchEventSha256'
            ),
            reviewerLaunchArtifactSha256: startedArtifactSha256 || null,
            providerInvocationId: effectiveInvocationId,
            delegationStartedAtUtc,
            minSequenceExclusive: routingEvent.sequence
        }
    );
    const existingStartedEventForAttempt = timelineEvents.find((event) => (
        event.event_type === 'REVIEWER_DELEGATION_STARTED'
        && event.sequence > routingEvent.sequence
        && getStringField(
            event.details || {},
            'reviewer_launch_attempt_id',
            'reviewerLaunchAttemptId'
        ).toLowerCase() === reviewerLaunchAttemptId.toLowerCase()
    ));
    if (
        existingStartedEventForAttempt
        && !findPersistedStartedEvent(preparedLaunchArtifactSha256)
    ) {
        throw new Error(
            'Delegation start recovery found conflicting REVIEWER_DELEGATION_STARTED telemetry for the same immutable launch attempt.'
        );
    }
    const { startedArtifactSha256: startedLaunchArtifactSha256 } =
        await persistReviewerDelegationStartedTransition({
            artifactPath: launchArtifactPath,
            originalArtifactText,
            startedArtifact,
            recoveringPersistedDelegationStart,
            reviewType,
            hasMatchingStartedEvent: (startedArtifactSha256) =>
                Boolean(findPersistedStartedEvent(startedArtifactSha256)),
            emitStartedEvent: async (startedArtifactSha256) => {
                const startedEvent = await emitReviewerDelegationStartedEventAsync(
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
                            reviewer_launch_artifact_sha256: startedArtifactSha256,
                            reviewer_launch_input_artifact_path: normalizePath(launchInputArtifactPath),
                            reviewer_launch_attestation_source: attestationSource,
                            launch_tool: getStringField(startedArtifact, 'launch_tool', 'launchTool'),
                            provider_invocation_id: providerInvocationId || null,
                            controller_invocation_id: controllerInvocationId || null,
                            launch_input_mode: launchInputAttestation.mode,
                            launch_input_sha256: launchInputAttestation.sha256,
                            launch_input_artifact_path: launchInputAttestation.artifactPath
                                ? normalizePath(launchInputAttestation.artifactPath)
                                : null,
                            launch_input_artifact_sha256: launchInputAttestation.artifactSha256,
                            copy_paste_reviewer_launch_prompt_sha256: launchInputAttestation.copyPasteReviewerLaunchPromptSha256,
                            launch_prepared_at_utc: getStringField(startedArtifact, 'launch_prepared_at_utc', 'launchPreparedAtUtc'),
                            delegation_started_at_utc: delegationStartedAtUtc,
                            launched_at_utc: delegationStartedAtUtc,
                            review_tree_state_sha256: reviewTreeStateSha256 || null
                        }
                    }
                );
                return Boolean(
                    startedEvent
                    && !taskEventAppendHasBlockingFailure(startedEvent, false)
                );
            }
        });
    console.log(buildOperatorNextActionBlock({
        status: 'PASSED',
        gate: 'record-reviewer-delegation-started',
        action: 'Wait for delegated reviewer completion',
        reason: `Delegated reviewer start recorded for '${reviewType}'.`,
        command: completeReviewerLaunchCommand,
        detailsPath: launchArtifactPath,
        detailsHint: 'Delegation identity, invocation id, and launch-input evidence are listed below.'
    }).join('\n'));
    console.log('');
    console.log(`REVIEWER_DELEGATION_STARTED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`ReviewerLaunchAttemptId: ${reviewerLaunchAttemptId}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`LaunchArtifactSha256: ${startedLaunchArtifactSha256}`);
    console.log(`${invocationIdLabel}: ${invocationId}`);
    console.log(`DelegationStartedAtUtc: ${delegationStartedAtUtc}`);
    console.log(`LaunchInputMode: ${launchInputAttestation.mode}`);
    console.log(`LaunchInputSha256: ${launchInputAttestation.sha256}`);
    if (launchInputAttestation.artifactPath) {
        console.log(`LaunchInputArtifactPath: ${normalizePath(launchInputAttestation.artifactPath)}`);
    }
    console.log(`CompleteReviewerLaunchCommand: ${completeReviewerLaunchCommand}`);
    console.log(`RecordReviewerLaunchFailedCommand: ${recordReviewerLaunchFailedCommand}`);
    console.log('NextStep: if the reviewer returns valid review output, ensure it is available at ReviewOutputPath and run complete-reviewer-launch. If the reviewer returns a transport or runtime error without valid review output, run record-reviewer-launch-failed and do not run complete-reviewer-launch.');
    });
};
}
