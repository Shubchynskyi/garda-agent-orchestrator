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
    getReviewerLaunchArtifactMismatchReasons,
    getStringField,
    readJsonFile
} from './review-launch-artifact-fields';

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
    routingEventSequence: number;
    timelineEvents: readonly ReviewDependencyTimelineEvent[];
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
        launchBindingSha256: options.launchBindingSha256,
        preparedLaunchEventSha256,
        routingEventSequence: options.routingEventSequence,
        timelineEvents: options.timelineEvents
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
    if (getStringField(options.artifact, 'attestation_source', 'attestationSource', 'source') !== PREPARED_REVIEWER_LAUNCH_ATTESTATION_SOURCE) {
        mismatches.push('attestation_source mismatch');
    }
    if (!preparedLaunchEventSha256) {
        mismatches.push('prepared_launch_event_sha256 missing');
    }
    const expectedLaunchInputArtifactPath = resolveReviewerLaunchInputArtifactPath(options.artifactPath);
    const actualLaunchInputArtifactPath = getStringField(
        options.artifact,
        'reviewer_launch_input_artifact_path',
        'reviewerLaunchInputArtifactPath'
    );
    if (actualLaunchInputArtifactPath !== normalizePath(expectedLaunchInputArtifactPath)) {
        mismatches.push('reviewer_launch_input_artifact_path mismatch');
    } else if (!fs.existsSync(expectedLaunchInputArtifactPath) || !fs.statSync(expectedLaunchInputArtifactPath).isFile()) {
        mismatches.push('reviewer launch input artifact missing');
    } else {
        const pinnedInputArtifactSha256 = getStringField(
            options.artifact,
            'reviewer_launch_input_artifact_sha256',
            'reviewerLaunchInputArtifactSha256'
        ).toLowerCase();
        const launchInputArtifactSha256 = fileSha256(expectedLaunchInputArtifactPath) || '';
        if (!launchInputArtifactSha256) {
            mismatches.push('reviewer launch input artifact could not be hashed');
        } else if (!/^[0-9a-f]{64}$/.test(pinnedInputArtifactSha256)) {
            mismatches.push('reviewer_launch_input_artifact_sha256 missing');
        } else if (launchInputArtifactSha256 !== pinnedInputArtifactSha256) {
            mismatches.push('reviewer launch input artifact sha256 mismatch');
        }
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
    if (violations.length > 0) {
        throw new Error(
            'Prepared reviewer launch artifact failed validation:\n' +
            violations.map((violation) => `- ${violation}`).join('\n')
        );
    }
}

