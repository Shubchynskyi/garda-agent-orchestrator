import * as fs from 'node:fs';
import {
    fileSha256,
    normalizePath,
    type ReviewDependencyTimelineEvent
} from './review-launch-entrypoints';
import {
    buildReviewerLaunchBindingSha256,
    resolveReviewerLaunchInputArtifactPath,
    stringSha256
} from './review-launch-input-attestation';
import {
    isPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    resolveLaunchBindingReviewerIdentity
} from '../../../../gate-runtime/review/reviewer-identity-contract';
import {
    PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    findMatchingReviewerLaunchPreparedEvent,
    getReviewerLaunchArtifactMismatchReasons,
    getStringField,
    readJsonFile
} from './review-launch-artifact-fields';

export interface ReviewerLaunchInputPinnedEventEvidence {
    eventSha256: string;
    eventTaskSequence: number;
    inputArtifactSha256: string;
}

export function findRecoverableReviewerLaunchPreparedEvent(
    timelineEvents: readonly ReviewDependencyTimelineEvent[],
    options: {
        artifactPath: string;
        reviewerLaunchInputArtifactPath: string;
        taskId: string;
        reviewType: string;
        reviewerExecutionMode: 'delegated_subagent';
        reviewerIdentity: string;
        reviewContextSha256: string;
        routingEventSha256: string;
        reviewerLaunchAttemptId: string;
        launchBindingSha256: string;
        reviewerPromptSha256: string;
        launchPreparedAtUtc: string;
        minSequenceExclusive: number;
    }
): ReviewDependencyTimelineEvent | null {
    for (let index = timelineEvents.length - 1; index >= 0; index -= 1) {
        const event = timelineEvents[index];
        const eventSha256 = String(event.integrity?.event_sha256 || '').trim().toLowerCase();
        const details = event.details || {};
        if (
            event.event_type !== 'REVIEWER_LAUNCH_PREPARED'
            || !/^[0-9a-f]{64}$/.test(eventSha256)
            || getStringField(details, 'task_id', 'taskId') !== options.taskId
            || getStringField(details, 'reviewer_launch_artifact_path', 'reviewerLaunchArtifactPath')
                !== normalizePath(options.artifactPath)
            || getStringField(
                details,
                'reviewer_launch_input_artifact_path',
                'reviewerLaunchInputArtifactPath'
            ) !== normalizePath(options.reviewerLaunchInputArtifactPath)
            || getStringField(details, 'reviewer_prompt_sha256', 'reviewerPromptSha256').toLowerCase()
                !== options.reviewerPromptSha256
            || getStringField(details, 'launch_prepared_at_utc', 'launchPreparedAtUtc')
                !== options.launchPreparedAtUtc
            || getStringField(details, 'attestation_source', 'attestationSource')
                !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE
        ) {
            continue;
        }
        const matchingEvent = findMatchingReviewerLaunchPreparedEvent(timelineEvents, {
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerLaunchAttemptId: options.reviewerLaunchAttemptId,
            launchBindingSha256: options.launchBindingSha256,
            preparedLaunchEventSha256: eventSha256,
            minSequenceExclusive: options.minSequenceExclusive
        });
        if (matchingEvent === event) {
            return event;
        }
    }
    return null;
}

export function findMatchingReviewerLaunchInputPinnedEvent(options: {
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    reviewerLaunchAttemptId: string;
    preparedLaunchEventSha256: string;
    reviewerLaunchInputArtifactPath: string;
    reviewerLaunchInputArtifactSha256: string;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    pinnedEventSha256?: string | null;
    pinnedEventTaskSequence?: number | null;
}): ReviewerLaunchInputPinnedEventEvidence | null {
    const expectedInputArtifactPath = normalizePath(options.reviewerLaunchInputArtifactPath);
    const expectedInputArtifactSha256 = options.reviewerLaunchInputArtifactSha256.trim().toLowerCase();
    const expectedPinnedEventSha256 = String(options.pinnedEventSha256 || '').trim().toLowerCase();
    const expectedPinnedEventTaskSequence = Number(options.pinnedEventTaskSequence);
    if (
        !/^[0-9a-f]{64}$/.test(expectedInputArtifactSha256)
        || (expectedPinnedEventSha256 && !/^[0-9a-f]{64}$/.test(expectedPinnedEventSha256))
        || (
            options.pinnedEventTaskSequence != null
            && (!Number.isInteger(expectedPinnedEventTaskSequence) || expectedPinnedEventTaskSequence < 1)
        )
    ) {
        return null;
    }
    for (const event of options.timelineEvents) {
        if (event.event_type !== 'REVIEWER_LAUNCH_INPUT_PINNED' || !event.integrity) {
            continue;
        }
        const eventSha256 = String(event.integrity.event_sha256 || '').trim().toLowerCase();
        const eventTaskSequence = Number(event.integrity.task_sequence);
        if (
            (expectedPinnedEventSha256 && eventSha256 !== expectedPinnedEventSha256)
            || (
                options.pinnedEventTaskSequence != null
                && eventTaskSequence !== expectedPinnedEventTaskSequence
            )
        ) {
            continue;
        }
        const details = event.details || {};
        if (
            getStringField(details, 'task_id', 'taskId') !== options.taskId
            || getStringField(details, 'review_type', 'reviewType').toLowerCase() !== options.reviewType
            || getStringField(details, 'reviewer_execution_mode', 'reviewerExecutionMode')
                !== options.reviewerExecutionMode
            || getStringField(
                details,
                'reviewer_identity',
                'reviewerIdentity',
                'reviewer_session_id',
                'reviewerSessionId'
            ) !== options.reviewerIdentity
            || getStringField(details, 'review_context_sha256', 'reviewContextSha256').toLowerCase()
                !== options.reviewContextSha256
            || getStringField(details, 'routing_event_sha256', 'routingEventSha256').toLowerCase()
                !== options.routingEventSha256
            || getStringField(details, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase()
                !== options.launchBindingSha256
            || getStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
                !== options.reviewerLaunchAttemptId
            || getStringField(details, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase()
                !== options.preparedLaunchEventSha256
            || getStringField(details, 'reviewer_launch_artifact_path', 'reviewerLaunchArtifactPath')
                !== normalizePath(options.artifactPath)
            || getStringField(details, 'reviewer_launch_input_artifact_path', 'reviewerLaunchInputArtifactPath')
                !== expectedInputArtifactPath
            || getStringField(
                details,
                'reviewer_launch_input_artifact_sha256',
                'reviewerLaunchInputArtifactSha256'
            ).toLowerCase() !== expectedInputArtifactSha256
        ) {
            continue;
        }
        return {
            eventSha256,
            eventTaskSequence,
            inputArtifactSha256: expectedInputArtifactSha256
        };
    }
    return null;
}

function getReviewerLaunchInputPinMismatches(options: {
    artifactPath: string;
    artifact: Record<string, unknown>;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    reviewerLaunchAttemptId: string;
    preparedLaunchEventSha256: string;
    reviewerLaunchInputArtifactSha256?: string | null;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
}): string[] {
    const mismatches: string[] = [];
    const expectedLaunchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(options.artifactPath);
    const actualLaunchInputArtifactPath = getStringField(
        options.artifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    const pinnedInputArtifactSha256 = getStringField(
        options.artifact,
        'reviewer_launch_input_artifact_sha256',
        'reviewerLaunchInputArtifactSha256'
    ).toLowerCase();
    const expectedReviewerLaunchInputArtifactSha256 = String(options.reviewerLaunchInputArtifactSha256 || '')
        .trim()
        .toLowerCase();
    if (actualLaunchInputArtifactPath !== normalizePath(expectedLaunchInputArtifactPath)) {
        mismatches.push('reviewer_launch_input_artifact_path mismatch');
    } else if (!fs.existsSync(expectedLaunchInputArtifactPath) || !fs.statSync(expectedLaunchInputArtifactPath).isFile()) {
        mismatches.push('reviewer launch input artifact missing');
    } else {
        const launchInputArtifactSha256 = fileSha256(expectedLaunchInputArtifactPath) || '';
        if (!launchInputArtifactSha256) {
            mismatches.push('reviewer launch input artifact could not be hashed');
        } else if (!/^[0-9a-f]{64}$/.test(pinnedInputArtifactSha256)) {
            mismatches.push('reviewer_launch_input_artifact_sha256 missing');
        } else if (launchInputArtifactSha256 !== pinnedInputArtifactSha256) {
            mismatches.push('reviewer launch input artifact sha256 mismatch');
        } else if (
            expectedReviewerLaunchInputArtifactSha256
            && pinnedInputArtifactSha256 !== expectedReviewerLaunchInputArtifactSha256
        ) {
            mismatches.push('reviewer_launch_input_artifact_sha256 does not match current reviewer-facing handoff content');
        }
    }
    const pinnedInputEventSha256 = getStringField(
        options.artifact,
        'reviewer_launch_input_pinned_event_sha256',
        'reviewerLaunchInputPinnedEventSha256'
    ).toLowerCase();
    const pinnedInputEventTaskSequence = Number(
        options.artifact.reviewer_launch_input_pinned_event_task_sequence
        ?? options.artifact.reviewerLaunchInputPinnedEventTaskSequence
    );
    if (!/^[0-9a-f]{64}$/.test(pinnedInputEventSha256)) {
        mismatches.push('reviewer_launch_input_pinned_event_sha256 missing');
    } else if (!Number.isInteger(pinnedInputEventTaskSequence) || pinnedInputEventTaskSequence < 1) {
        mismatches.push('reviewer_launch_input_pinned_event_task_sequence missing');
    } else if (!findMatchingReviewerLaunchInputPinnedEvent({
        artifactPath: options.artifactPath,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        launchBindingSha256: options.launchBindingSha256,
        reviewerLaunchAttemptId: options.reviewerLaunchAttemptId,
        preparedLaunchEventSha256: options.preparedLaunchEventSha256,
        reviewerLaunchInputArtifactPath: expectedLaunchInputArtifactPath,
        reviewerLaunchInputArtifactSha256: pinnedInputArtifactSha256,
        timelineEvents: options.timelineEvents,
        pinnedEventSha256: pinnedInputEventSha256,
        pinnedEventTaskSequence: pinnedInputEventTaskSequence
    })) {
        mismatches.push('reviewer launch input pin telemetry mismatch');
    }
    return mismatches;
}

export function getCurrentPreparedReviewerLaunchMismatches(options: {
    artifactPath: string;
    artifact: Record<string, unknown>;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewOutputPath?: string | null;
    copyPasteReviewerLaunchPrompt?: string | null;
    copyPasteReviewerLaunchPromptSha256?: string | null;
    reviewTreeStateSha256: string | null;
    launchBindingSha256: string;
    reviewerLaunchInputArtifactSha256?: string | null;
    reviewerLaunchAttemptId: string;
    recordReviewerDelegationStartedLaunchArtifactPathCommand?: string | null;
    recordReviewerDelegationStartedCopyPastePromptCommand?: string | null;
    completeReviewerLaunchLaunchArtifactPathCommand?: string | null;
    completeReviewerLaunchCopyPastePromptCommand?: string | null;
    recordReviewerLaunchFailedCommand?: string | null;
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
    deferPreparedLaunchEventValidationForRecovery?: boolean;
    deferReviewerLaunchInputPinValidationForRecovery?: boolean;
}): string[] {
    const evidenceType = getStringField(options.artifact, 'evidence_type', 'artifact_type');
    const attestationState = getStringField(options.artifact, 'attestation_state', 'attestationState');
    const preparedLaunchEventSha256 = getStringField(
        options.artifact,
        'prepared_launch_event_sha256',
        'preparedLaunchEventSha256'
    ).toLowerCase();
    const mismatches = getReviewerLaunchArtifactMismatchReasons(options.artifact, {
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        reviewerPromptSha256: options.reviewerPromptSha256,
        rolePromptSha256: options.rolePromptSha256,
        promptTemplateSha256: options.promptTemplateSha256,
        outputTemplateSha256: options.outputTemplateSha256,
        evidenceManifestSha256: options.evidenceManifestSha256,
        reviewOutputPath: options.reviewOutputPath,
        copyPasteReviewerLaunchPrompt: options.copyPasteReviewerLaunchPrompt,
        copyPasteReviewerLaunchPromptSha256: options.copyPasteReviewerLaunchPromptSha256,
        reviewTreeStateSha256: options.reviewTreeStateSha256,
        reviewerLaunchAttemptId: options.reviewerLaunchAttemptId,
        launchBindingSha256: options.launchBindingSha256,
        preparedLaunchEventSha256,
        routingEventSequence: options.routingEventSequence,
        timelineEvents: options.timelineEvents,
        deferPreparedLaunchEventValidationForRecovery:
            options.deferPreparedLaunchEventValidationForRecovery
    });
    if (Number(options.artifact.schema_version) !== 1) {
        mismatches.push('schema_version mismatch');
    }
    if (evidenceType !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        mismatches.push('evidence_type mismatch');
    }
    if (attestationState !== 'prepared') {
        mismatches.push('attestation_state mismatch');
    }
    const reviewerLaunchAttemptId = getStringField(
        options.artifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    );
    if (reviewerLaunchAttemptId !== options.reviewerLaunchAttemptId) {
        mismatches.push('reviewer_launch_attempt_id mismatch');
    }
    if (getStringField(options.artifact, 'attestation_source', 'attestationSource', 'source') !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        mismatches.push('attestation_source mismatch');
    }
    if (
        options.recordReviewerDelegationStartedLaunchArtifactPathCommand
        && getStringField(
            options.artifact,
            'record_reviewer_delegation_started_launch_artifact_path_command',
            'recordReviewerDelegationStartedLaunchArtifactPathCommand'
        ) !== options.recordReviewerDelegationStartedLaunchArtifactPathCommand
    ) {
        mismatches.push('record_reviewer_delegation_started_launch_artifact_path_command mismatch');
    }
    if (
        options.recordReviewerDelegationStartedCopyPastePromptCommand
        && getStringField(
            options.artifact,
            'record_reviewer_delegation_started_copy_paste_prompt_command',
            'recordReviewerDelegationStartedCopyPastePromptCommand'
        ) !== options.recordReviewerDelegationStartedCopyPastePromptCommand
    ) {
        mismatches.push('record_reviewer_delegation_started_copy_paste_prompt_command mismatch');
    }
    if (
        options.completeReviewerLaunchLaunchArtifactPathCommand
        && getStringField(
            options.artifact,
            'complete_reviewer_launch_launch_artifact_path_command',
            'completeReviewerLaunchLaunchArtifactPathCommand'
        ) !== options.completeReviewerLaunchLaunchArtifactPathCommand
    ) {
        mismatches.push('complete_reviewer_launch_launch_artifact_path_command mismatch');
    }
    if (
        options.completeReviewerLaunchCopyPastePromptCommand
        && getStringField(
            options.artifact,
            'complete_reviewer_launch_copy_paste_prompt_command',
            'completeReviewerLaunchCopyPastePromptCommand'
        ) !== options.completeReviewerLaunchCopyPastePromptCommand
    ) {
        mismatches.push('complete_reviewer_launch_copy_paste_prompt_command mismatch');
    }
    if (
        options.recordReviewerLaunchFailedCommand
        && getStringField(options.artifact, 'record_reviewer_launch_failed_command', 'recordReviewerLaunchFailedCommand')
            !== options.recordReviewerLaunchFailedCommand
    ) {
        mismatches.push('record_reviewer_launch_failed_command mismatch');
    }
    if (!preparedLaunchEventSha256 && !options.deferPreparedLaunchEventValidationForRecovery) {
        mismatches.push('prepared_launch_event_sha256 missing');
    }
    if (!options.deferReviewerLaunchInputPinValidationForRecovery) {
        mismatches.push(...getReviewerLaunchInputPinMismatches({
            artifactPath: options.artifactPath,
            artifact: options.artifact,
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: options.reviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            launchBindingSha256: options.launchBindingSha256,
            reviewerLaunchAttemptId: options.reviewerLaunchAttemptId,
            preparedLaunchEventSha256,
            reviewerLaunchInputArtifactSha256: options.reviewerLaunchInputArtifactSha256,
            timelineEvents: options.timelineEvents
        }));
    }
    return mismatches;
}


export function assertPreparedReviewerLaunchArtifact(options: {
    artifactPath: string;
    taskId: string;
    reviewType: string;
    reviewerExecutionMode: 'delegated_subagent';
    reviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    reviewerPromptSha256?: string | null;
    rolePromptSha256?: string | null;
    promptTemplateSha256?: string | null;
    outputTemplateSha256?: string | null;
    evidenceManifestSha256?: string | null;
    reviewOutputPath?: string | null;
    reviewerLaunchInputArtifactPath?: string | null;
    reviewerLaunchInputArtifactSha256?: string | null;
    copyPasteReviewerLaunchPrompt?: string | null;
    copyPasteReviewerLaunchPromptSha256?: string | null;
    reviewTreeStateSha256?: string | null;
    allowedAttestationStates?: readonly string[];
    resolvedReviewerIdentity?: string | null;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
}): void {
    const artifact = readJsonFile(options.artifactPath, 'Prepared reviewer launch artifact');
    const artifactReviewerIdentity = getStringField(
        artifact,
        'reviewer_identity',
        'reviewerIdentity',
        'reviewer_session_id',
        'reviewerSessionId'
    );
    const plannedReviewerIdentity = getStringField(
        artifact,
        'planned_reviewer_identity',
        'plannedReviewerIdentity'
    ) || artifactReviewerIdentity;
    const launchBindingSha256 = getStringField(artifact, 'launch_binding_sha256', 'launchBindingSha256').toLowerCase();
    const launchBindingReviewerIdentity = resolveLaunchBindingReviewerIdentity({
        taskId: options.taskId,
        reviewType: options.reviewType,
        artifactReviewerIdentity,
        plannedReviewerIdentity
    });
    const expectedLaunchBindingSha256 = options.reviewerPromptSha256
        ? buildReviewerLaunchBindingSha256({
            taskId: options.taskId,
            reviewType: options.reviewType,
            reviewerExecutionMode: options.reviewerExecutionMode,
            reviewerIdentity: launchBindingReviewerIdentity,
            reviewContextSha256: options.reviewContextSha256,
            routingEventSha256: options.routingEventSha256,
            reviewerPromptSha256: options.reviewerPromptSha256
        })
        : '';
    const violations: string[] = [];
    const reviewerLaunchAttemptId = getStringField(
        artifact,
        'reviewer_launch_attempt_id',
        'reviewerLaunchAttemptId'
    );
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(reviewerLaunchAttemptId)) {
        violations.push('reviewer_launch_attempt_id must be an immutable UUID v4');
    }
    if (Number(artifact.schema_version) !== 1) {
        violations.push('schema_version must be 1');
    }
    if (getStringField(artifact, 'evidence_type', 'artifact_type') !== PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE) {
        violations.push(`evidence_type must be '${PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE}'`);
    }
    const allowedAttestationStates = options.allowedAttestationStates || ['prepared'];
    const attestationState = getStringField(artifact, 'attestation_state', 'attestationState');
    if (!allowedAttestationStates.includes(attestationState)) {
        violations.push(`attestation_state must be one of: ${allowedAttestationStates.join(', ')}`);
    }
    if (getStringField(artifact, 'task_id', 'taskId') !== options.taskId) {
        violations.push(`task_id must be '${options.taskId}'`);
    }
    if (getStringField(artifact, 'review_type', 'reviewType').toLowerCase() !== options.reviewType) {
        violations.push(`review_type must be '${options.reviewType}'`);
    }
    if (getStringField(artifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== options.reviewerExecutionMode) {
        violations.push(`reviewer_execution_mode must be '${options.reviewerExecutionMode}'`);
    }
    const resolvedReviewerIdentity = String(options.resolvedReviewerIdentity || '').trim();
    if (resolvedReviewerIdentity) {
        if (!isResolvedReviewerIdentity(resolvedReviewerIdentity)) {
            violations.push('resolved reviewer identity must be an agent-scoped identity from the provider launch result');
        } else if (!isPlannedReviewerIdentity(plannedReviewerIdentity)) {
            violations.push('planned reviewer identity must be present before resolving delegated reviewer identity');
        } else if (artifactReviewerIdentity !== plannedReviewerIdentity && artifactReviewerIdentity !== resolvedReviewerIdentity) {
            violations.push('reviewer_identity must match the planned or resolved delegated reviewer identity');
        } else if (resolvedReviewerIdentity === plannedReviewerIdentity) {
            violations.push('resolved reviewer identity must not reuse the planned pending identity');
        }
    } else if (artifactReviewerIdentity !== options.reviewerIdentity) {
        violations.push(`reviewer_identity must be '${options.reviewerIdentity}'`);
    }
    if (getStringField(artifact, 'review_context_sha256', 'reviewContextSha256').toLowerCase() !== options.reviewContextSha256) {
        violations.push('review_context_sha256 must match the current review context');
    }
    if (getStringField(artifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== options.routingEventSha256) {
        violations.push('routing_event_sha256 must match the current routing event');
    }
    if (options.reviewerPromptSha256) {
        const actualPromptSha256 = getStringField(
            artifact,
            'reviewer_prompt_sha256',
            'reviewerPromptSha256'
        ).toLowerCase();
        if (actualPromptSha256 !== options.reviewerPromptSha256) {
            violations.push('reviewer_prompt_sha256 must match the current review context prompt artifact');
        }
    }
    if (options.rolePromptSha256) {
        const actualRolePromptSha256 = getStringField(artifact, 'role_prompt_sha256', 'rolePromptSha256').toLowerCase();
        if (actualRolePromptSha256 !== options.rolePromptSha256) {
            violations.push('role_prompt_sha256 must match the current review context role prompt artifact');
        }
    }
    if (options.promptTemplateSha256) {
        const actualPromptTemplateSha256 = getStringField(artifact, 'prompt_template_sha256', 'promptTemplateSha256').toLowerCase();
        if (actualPromptTemplateSha256 !== options.promptTemplateSha256) {
            violations.push('prompt_template_sha256 must match the current review context prompt template artifact');
        }
    }
    if (options.outputTemplateSha256) {
        const actualOutputTemplateSha256 = getStringField(artifact, 'output_template_sha256', 'outputTemplateSha256').toLowerCase();
        if (actualOutputTemplateSha256 !== options.outputTemplateSha256) {
            violations.push('output_template_sha256 must match the current review context output template artifact');
        }
    }
    if (options.evidenceManifestSha256) {
        const actualEvidenceManifestSha256 = getStringField(artifact, 'evidence_manifest_sha256', 'evidenceManifestSha256').toLowerCase();
        if (actualEvidenceManifestSha256 !== options.evidenceManifestSha256) {
            violations.push('evidence_manifest_sha256 must match the current review context evidence manifest artifact');
        }
    }
    if (options.reviewOutputPath) {
        const actualReviewOutputPath = getStringField(artifact, 'review_output_path', 'reviewOutputPath');
        if (actualReviewOutputPath !== normalizePath(options.reviewOutputPath)) {
            violations.push('review_output_path must match the prepared reviewer output path');
        }
    }
    if (options.reviewerLaunchInputArtifactPath) {
        const actualInputArtifactPath = getStringField(
            artifact,
            'reviewer_launch_input_artifact_path',
            'reviewerLaunchInputArtifactPath'
        );
        if (actualInputArtifactPath !== normalizePath(options.reviewerLaunchInputArtifactPath)) {
            violations.push('reviewer_launch_input_artifact_path must match the immutable reviewer launch input artifact path');
        }
        if (options.reviewerLaunchInputArtifactSha256) {
            const actualInputArtifactSha256 = getStringField(
                artifact,
                'reviewer_launch_input_artifact_sha256',
                'reviewerLaunchInputArtifactSha256'
            ).toLowerCase();
            if (actualInputArtifactSha256 !== options.reviewerLaunchInputArtifactSha256.toLowerCase()) {
                violations.push('reviewer_launch_input_artifact_sha256 must match the immutable reviewer launch input artifact hash');
            }
        }
        if (fs.existsSync(options.reviewerLaunchInputArtifactPath)) {
            const launchInputArtifact = readJsonFile(
                options.reviewerLaunchInputArtifactPath,
                'Reviewer launch input artifact'
            );
            if (
                getStringField(launchInputArtifact, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
                !== reviewerLaunchAttemptId
            ) {
                violations.push('reviewer launch input artifact must bind the same reviewer_launch_attempt_id');
            }
        }
    }
    if (options.copyPasteReviewerLaunchPrompt) {
        const actualCopyPastePrompt = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt',
            'copyPasteReviewerLaunchPrompt'
        );
        if (actualCopyPastePrompt !== options.copyPasteReviewerLaunchPrompt) {
            violations.push('copy_paste_reviewer_launch_prompt must match the prepared reviewer launch prompt');
        }
        const actualCopyPastePromptSha256 = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase();
        const expectedCopyPastePromptSha256 = options.copyPasteReviewerLaunchPromptSha256
            || stringSha256(options.copyPasteReviewerLaunchPrompt);
        if (!actualCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required');
        } else if (actualCopyPastePromptSha256 !== expectedCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match the prepared reviewer launch prompt');
        }
    } else {
        const actualCopyPastePrompt = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt',
            'copyPasteReviewerLaunchPrompt'
        );
        const actualCopyPastePromptSha256 = getStringField(
            artifact,
            'copy_paste_reviewer_launch_prompt_sha256',
            'copyPasteReviewerLaunchPromptSha256'
        ).toLowerCase();
        if (actualCopyPastePrompt && !actualCopyPastePromptSha256) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 is required when copy_paste_reviewer_launch_prompt is present');
        } else if (
            actualCopyPastePrompt
            && actualCopyPastePromptSha256
            && actualCopyPastePromptSha256 !== stringSha256(actualCopyPastePrompt)
        ) {
            violations.push('copy_paste_reviewer_launch_prompt_sha256 must match copy_paste_reviewer_launch_prompt');
        }
    }
    if (options.reviewTreeStateSha256) {
        const actualTreeStateSha256 = getStringField(
            artifact,
            'review_tree_state_sha256',
            'reviewTreeStateSha256'
        ).toLowerCase();
        if (actualTreeStateSha256 !== options.reviewTreeStateSha256) {
            violations.push('review_tree_state_sha256 must match the current review context tree_state');
        }
    }
    const attestationSource = getStringField(artifact, 'attestation_source', 'attestationSource', 'source');
    if (attestationState === 'prepared' && attestationSource !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        violations.push(`attestation_source must be '${PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE}'`);
    } else if (attestationState === 'delegation_started' && !attestationSource) {
        violations.push('attestation_source is required for delegation_started launch artifact');
    }
    if (!launchBindingSha256) {
        violations.push('launch_binding_sha256 is required');
    } else if (expectedLaunchBindingSha256 && launchBindingSha256 !== expectedLaunchBindingSha256) {
        violations.push('launch_binding_sha256 must match the current prepared launch binding');
    }
    if (!getStringField(artifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256')) {
        violations.push('prepared_launch_event_sha256 is required');
    }
    violations.push(...getReviewerLaunchInputPinMismatches({
        artifactPath: options.artifactPath,
        artifact,
        taskId: options.taskId,
        reviewType: options.reviewType,
        reviewerExecutionMode: options.reviewerExecutionMode,
        reviewerIdentity: options.reviewerIdentity,
        reviewContextSha256: options.reviewContextSha256,
        routingEventSha256: options.routingEventSha256,
        launchBindingSha256,
        reviewerLaunchAttemptId,
        preparedLaunchEventSha256: getStringField(
            artifact,
            'prepared_launch_event_sha256',
            'preparedLaunchEventSha256'
        ).toLowerCase(),
        reviewerLaunchInputArtifactSha256: options.reviewerLaunchInputArtifactSha256,
        timelineEvents: options.timelineEvents
    }));
    if (violations.length > 0) {
        throw new Error(
            'Prepared reviewer launch artifact failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n')
        );
    }
}
