import { getTaskModeEvidence } from '../task-mode/task-mode';
import {
    isAttestedReviewerSubagentExecutionSource,
    normalizeRoutePath
} from './handshake-diagnostics-routing';

export function resolveCompatibilityReviewerSubagentLaunchStatus(
    repoRoot: string,
    taskId: string,
    taskModePath: string,
    artifactProvider: string | null,
    routedTo: string | null,
    executionProviderSource: string | null,
    runtimeIdentityStatus: string | null,
    recordedStatus: string | null
): string | null {
    const normalizedRecordedStatus = String(recordedStatus || '').trim().toLowerCase() || null;
    if (normalizedRecordedStatus) {
        return normalizedRecordedStatus;
    }
    if (runtimeIdentityStatus !== 'resolved' || !isAttestedReviewerSubagentExecutionSource(executionProviderSource)) {
        return null;
    }

    // Legacy handshake fixtures may omit launchability metadata, but only task-mode
    // evidence from the same task may corroborate a delegated reviewer launch path.
    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, taskModePath);
    const normalizedTaskModeEvidencePath = String(taskModeEvidence.evidence_path || '').trim().toLowerCase() || null;
    const normalizedTaskModeTimelineArtifactPath = String(taskModeEvidence.timeline_artifact_path || '').trim().toLowerCase() || null;
    if (
        taskModeEvidence.evidence_status !== 'PASS'
        || taskModeEvidence.evidence_outcome !== 'PASS'
        || !taskModeEvidence.declares_runtime_identity_metadata
        || !taskModeEvidence.timeline_declares_runtime_identity_metadata
        || !normalizedTaskModeEvidencePath
        || !normalizedTaskModeTimelineArtifactPath
        || normalizedTaskModeEvidencePath !== normalizedTaskModeTimelineArtifactPath
        || taskModeEvidence.runtime_identity_status !== 'resolved'
        || taskModeEvidence.reviewer_subagent_launch_status !== 'launchable'
    ) {
        return null;
    }

    if (
        artifactProvider
        && taskModeEvidence.provider
        && taskModeEvidence.provider !== artifactProvider
    ) {
        return null;
    }

    const normalizedTaskModeRoute = normalizeRoutePath(taskModeEvidence.routed_to);
    if (routedTo && normalizedTaskModeRoute && routedTo !== normalizedTaskModeRoute) {
        return null;
    }

    return 'launchable';
}
