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
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import {
    type ParsedOptionsRecord
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';

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
    const preparedArtifact = readJsonFile(launchArtifactPath, 'Reviewer launch artifact');
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
        allowedAttestationStates: ['prepared']
    });
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
    const delegationStartedAtUtc = new Date().toISOString();
    const isPlannedIdentityRebind = isPlannedReviewerIdentity(plannedReviewerIdentity)
        && reviewerIdentity !== plannedReviewerIdentity;
    const startedArtifact: Record<string, unknown> = {
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
    writeReviewArtifactJson(launchArtifactPath, startedArtifact);
    const startedLaunchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const invocationId = providerInvocationId || controllerInvocationId;
    const invocationIdLabel = providerInvocationId ? 'ProviderInvocationId' : 'ControllerInvocationId';
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
                reviewer_launch_artifact_sha256: startedLaunchArtifactSha256,
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
    if (!startedEvent || taskEventAppendHasBlockingFailure(startedEvent, false)) {
        throw new Error(
            `Reviewer delegation start requires REVIEWER_DELEGATION_STARTED telemetry for '${reviewType}'. ` +
            'The lifecycle event could not be persisted.'
        );
    }
    console.log(`REVIEWER_DELEGATION_STARTED: ${reviewType}`);
    console.log(`ReviewerIdentity: ${reviewerIdentity}`);
    console.log(`LaunchArtifactPath: ${normalizePath(launchArtifactPath)}`);
    console.log(`LaunchArtifactSha256: ${startedLaunchArtifactSha256}`);
    console.log(`${invocationIdLabel}: ${invocationId}`);
    console.log(`DelegationStartedAtUtc: ${delegationStartedAtUtc}`);
    console.log(`LaunchInputMode: ${launchInputAttestation.mode}`);
    console.log(`LaunchInputSha256: ${launchInputAttestation.sha256}`);
    if (launchInputAttestation.artifactPath) {
        console.log(`LaunchInputArtifactPath: ${normalizePath(launchInputAttestation.artifactPath)}`);
    }
    console.log('NextAction: after the delegated reviewer returns, run complete-reviewer-launch to record completion attestation.');
};
}
