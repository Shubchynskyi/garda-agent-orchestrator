import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    buildReviewReceiptReviewerProvenance,
    assertReviewLifecycleGuard,
    assertReviewTreeStateFresh,
    assertValidTaskId,
    emitReviewerLaunchPreparedEventAsync,
    fileSha256,
    gateHelpers,
    normalizeCompatibilityReviewerExecutionMode,
    normalizePath,
    resolveCanonicalReviewContextPath,
    resolveReviewerPromptArtifactBinding,
    taskEventAppendHasBlockingFailure,
    writeReviewArtifactJson
} from './review-launch-entrypoints';
import {
    REVIEW_CONTEXT_OPAQUE_HANDOFF_INSTRUCTION,
    REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION,
    REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION
} from '../../../../gate-runtime/reviewer-session-contract';
import { parseOptions, normalizePathValue } from '../../cli-helpers';
import { resolveReviewerIdentityOption } from './reviewer-identity-options';
import {
    type ParsedOptionsRecord,
    removeArtifactIfExists
} from '../../shared-command-utils';
import { readDependencyTimelineEvents } from '../result/review-dependency-timeline';
type SupersededReviewerLaunchArtifactSnapshot = import('../index').SupersededReviewerLaunchArtifactSnapshot;

function printReviewerLaunchHandoffLines(): void {
    console.log('OneShotLaunchState: default_handoff_ready_not_review_evidence');
    console.log(`OneShotLaunchInstruction: ${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION}`);
}

function buildReviewerLaunchNextAction(): string {
    return (
        `${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION} ` +
        'Do not reconstruct reviewer prompts from memory. ' +
        `${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ` +
        'Immediately run record-reviewer-delegation-started with the resolved provider reviewer identity and launch_input evidence, then run complete-reviewer-launch after reviewer completion.'
    );
}

export interface PrepareReviewerLaunchHandlerDependencies {
    assertExplicitReviewContextRuntimeIdentity: typeof import('../index').assertExplicitReviewContextRuntimeIdentity;
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

export function createPrepareReviewerLaunchHandler(deps: PrepareReviewerLaunchHandlerDependencies) {
    const {
        assertExplicitReviewContextRuntimeIdentity,
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
    const reviewOutputAttemptSha256 = stringSha256(JSON.stringify({
        task_id: taskId,
        review_type: reviewType,
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
        const existingAttestationState = getStringField(existingArtifact, 'attestation_state', 'attestationState');
        const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath, reviewOutputAttemptSha256);
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
            printReviewerLaunchHandoffLines();
            console.log(`CopyPasteReviewerLaunchPromptSha256: ${stringSha256(copyPasteReviewerLaunchPrompt)}`);
            console.log('LaunchInputCliFlagHelp: for launch_artifact_path mode, pass ReviewerLaunchInputArtifactSha256 to --launch-input-sha256; launch_input_sha256 and launch_input_artifact_sha256 are artifact JSON fields, not CLI flags.');
            console.log('AttestationState: prepared');
            console.log('SupersededLaunchArtifact: none');
            printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
            console.log(`NextAction: existing reviewer launch metadata is current; ${buildReviewerLaunchNextAction()}`);
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
    const reviewOutputPath = resolveReviewerDraftOutputPath(launchArtifactPath, reviewOutputAttemptSha256);
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
        'review_output_attempt_sha256',
        'review_tree_state_sha256',
        'launch_binding_sha256',
        'prepared_launch_event_sha256',
        'prepared_launch_event_task_sequence',
        'reviewer_launch_input_artifact_sha256'
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
        next_action: (
            `Launch a fresh delegated reviewer once with ${handoffArtifactNames} as opaque handoff artifacts using the exact CopyPasteReviewerLaunchPrompt or ReviewerLaunchInputArtifactPath. ` +
            `${REVIEWER_ONE_SHOT_LAUNCH_DEFAULT_INSTRUCTION} ` +
            `${REVIEWER_REAL_SUBAGENT_OR_STOP_INSTRUCTION} ` +
            'Do not open or summarize the generated review context in the main agent. Then update only the ' +
            'after_launch_required_updates fields while preserving the prepared hashes. ' +
            'Run record-reviewer-delegation-started immediately after provider launch, then complete-reviewer-launch after the reviewer returns.'
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
    const pinnedReviewerLaunchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
    if (!pinnedReviewerLaunchInputArtifactSha256) {
        throw new Error('Reviewer launch input artifact must be hashable immediately after prepare-reviewer-launch.');
    }
    const preparedArtifactWithPinnedInput = {
        ...preparedArtifactWithEvent,
        reviewer_launch_input_artifact_sha256: pinnedReviewerLaunchInputArtifactSha256
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
        reviewTreeStateSha256
    });
    const launchArtifactSha256 = fileSha256(launchArtifactPath) || '';
    const launchInputArtifactSha256 = fileSha256(launchInputArtifactPath) || '';
    if (launchInputArtifactSha256 !== pinnedReviewerLaunchInputArtifactSha256) {
        throw new Error(
            'Reviewer launch input artifact must remain byte-for-byte identical to the immutable prepare-time handoff copy.'
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
    console.log(`RecordInvocationCommand: ${recordInvocationCommand}`);
    printCopyPasteReviewerLaunchPrompt(copyPasteReviewerLaunchPrompt);
    console.log(`NextAction: ${buildReviewerLaunchNextAction()}`);
}

;
}
