import * as fs from 'node:fs';

import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import { resolveHandshakeArtifactPath } from './handshake-diagnostics-paths';
import { resolveCompatibilityReviewerSubagentLaunchStatus } from './handshake-diagnostics-provider-evidence';
import {
    isAttestedReviewerSubagentExecutionSource,
    normalizeRoutePath
} from './handshake-diagnostics-routing';
import { verifyHandshakeTimelineBinding } from './handshake-diagnostics-timeline';
import type {
    GetHandshakeEvidenceOptions,
    HandshakeEvidenceResult
} from './handshake-diagnostics-types';

export function getHandshakeEvidence(repoRoot: string, taskId: string | null, artifactPathOrOptions: string | GetHandshakeEvidenceOptions = ''): HandshakeEvidenceResult {
    const opts: GetHandshakeEvidenceOptions = typeof artifactPathOrOptions === 'string'
        ? { artifactPath: artifactPathOrOptions }
        : artifactPathOrOptions;
    const result: HandshakeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        provider: null,
        violations: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveHandshakeArtifactPath(repoRoot, resolvedTaskId, opts.artifactPath || '');
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        result.violations.push(
            `Handshake diagnostics evidence missing: file not found at '${result.evidence_path}'. ` +
            'Run handshake-diagnostics before implementation gates.'
        );
        return result;
    }

    let artifact: Record<string, unknown>;
    try {
        artifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        result.violations.push(`Handshake diagnostics evidence is invalid JSON at '${result.evidence_path}'.`);
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.provider = String(artifact.execution_provider || artifact.provider || '').trim() || null;

    const evidenceTaskId = String(artifact.task_id || '').trim();
    if (evidenceTaskId !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        result.violations.push(
            `Handshake diagnostics task mismatch. Expected '${resolvedTaskId}', got '${evidenceTaskId}'.`
        );
        return result;
    }

    const eventSource = String(artifact.event_source || '').trim();
    if (eventSource !== 'handshake-diagnostics') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence source is invalid. Expected 'handshake-diagnostics', got '${eventSource}'.`
        );
        return result;
    }

    const timelineViolations = verifyHandshakeTimelineBinding(resolvedTaskId, result.evidence_hash, opts.timelinePath);
    if (timelineViolations.length > 0) {
        result.evidence_status = 'EVIDENCE_TIMELINE_UNBOUND';
        result.violations.push(...timelineViolations);
        return result;
    }

    const status = String(artifact.status || '').trim().toUpperCase();
    const outcome = String(artifact.outcome || '').trim().toUpperCase();
    const artifactProvider = String(artifact.execution_provider || artifact.provider || '').trim() || null;
    const executionProviderSource = String(artifact.execution_provider_source || '').trim().toLowerCase() || null;
    const routedTo = normalizeRoutePath(artifact.routed_to);
    const runtimeIdentityStatus = String(artifact.runtime_identity_status || '').trim().toLowerCase() || null;
    const reviewerSubagentLaunchStatus = resolveCompatibilityReviewerSubagentLaunchStatus(
        repoRoot,
        resolvedTaskId,
        String(opts.taskModePath || '').trim(),
        artifactProvider,
        routedTo,
        executionProviderSource,
        runtimeIdentityStatus,
        String(artifact.reviewer_subagent_launch_status || '').trim()
    );
    if (!isAttestedReviewerSubagentExecutionSource(executionProviderSource)) {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            executionProviderSource
                ? `Handshake diagnostics evidence is not usable because execution_provider_source is '${executionProviderSource}', ` +
                    'which does not attest launchable reviewer subagents. Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics.'
                : 'Handshake diagnostics evidence is not usable because execution_provider_source is missing. ' +
                    'Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics.'
        );
        return result;
    }
    if (runtimeIdentityStatus !== 'resolved') {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence is not usable because runtime_identity_status is '${runtimeIdentityStatus || 'unknown'}'. ` +
            'Re-enter task mode through a launchable provider route and rerun handshake-diagnostics.'
        );
        return result;
    }
    if (reviewerSubagentLaunchStatus !== 'launchable') {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence is not usable because reviewer_subagent_launch_status is '${reviewerSubagentLaunchStatus || 'unknown'}'. ` +
            'Re-enter task mode through a launchable provider route and rerun handshake-diagnostics.'
        );
        return result;
    }
    if (status === 'PASSED' && outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    // Artifact exists but reported violations.
    result.evidence_status = 'PASS_WITH_VIOLATIONS';
    const artifactViolations = Array.isArray(artifact.violations) ? artifact.violations : [];
    for (const v of artifactViolations) {
        result.violations.push(`Handshake diagnostic violation: ${String(v)}`);
    }

    return result;
}

export function getHandshakeEvidenceViolations(result: HandshakeEvidenceResult): string[] {
    switch (result.evidence_status) {
        case 'PASS':
        case 'PASS_WITH_VIOLATIONS':
            return result.violations;
        case 'TASK_ID_MISSING':
            return ['Handshake diagnostics evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return result.violations;
        case 'EVIDENCE_INVALID_JSON':
            return result.violations;
        case 'EVIDENCE_TASK_MISMATCH':
            return result.violations;
        case 'EVIDENCE_SOURCE_INVALID':
            return result.violations;
        case 'EVIDENCE_TIMELINE_UNBOUND':
            return result.violations;
        case 'EVIDENCE_RUNTIME_SESSION_INVALID':
            return result.violations;
        default:
            return ['Handshake diagnostics evidence is missing or invalid. Run handshake-diagnostics gate.'];
    }
}
