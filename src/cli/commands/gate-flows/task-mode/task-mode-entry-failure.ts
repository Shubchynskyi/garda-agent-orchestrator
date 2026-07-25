import * as fs from 'node:fs';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { validateFreshOperatorConfirmation, parseOperatorConfirmationYes } from '../../../../core/operator-confirmation';
import { appendMandatoryTaskEvent, assertValidTaskId, inspectTaskEventFile } from '../../../../gate-runtime/task-events';
import { fileSha256, getProtectedControlPlaneRoots, normalizePath, testPathPrefix } from '../../../../gates/shared/helpers';
import { computeProtectedSnapshotDigest, evaluateProtectedControlPlaneManifest, scanProtectedPathHashes } from '../../../../gates/protected-control-plane/protected-control-plane';
import { runRepairProtectedManifest } from '../../repair-command';
import { resolveOrchestratorRoot } from '../compile/gate-flow-helpers';
import { writeJsonArtifact } from '../../../gate-cli/gates-artifacts';
import { buildGateCommandPrefix, quotePowerShellCliValue } from './task-mode-command-format';
import { TaskModeProtectedManifestEntryError } from './task-mode-entry-protection';

const FAILURE_SUFFIX = '-task-mode-entry-failure.json';
const RECOVERY_SUFFIX = '-task-mode-entry-recovery.json';

function reviewsPath(repoRoot: string, taskId: string, suffix: string): string {
    return path.join(resolveOrchestratorRoot(repoRoot), 'runtime', 'reviews', `${taskId}${suffix}`);
}

function latestFailureEventDetails(repoRoot: string, taskId: string): Record<string, unknown> | null {
    const timelinePath = path.join(resolveOrchestratorRoot(repoRoot), 'runtime', 'task-events', `${taskId}.jsonl`);
    const inspection = inspectTaskEventFile(timelinePath, taskId);
    if (inspection.status !== 'PASS' && inspection.status !== 'PASS_WITH_LEGACY_PREFIX') return null;
    const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim());
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (event.event_type === 'TASK_MODE_ENTRY_FAILED' && event.outcome === 'FAIL') {
                return event.details && typeof event.details === 'object' && !Array.isArray(event.details)
                    ? event.details as Record<string, unknown> : null;
            }
        } catch { /* integrity inspection rejects malformed timeline content */ }
    }
    return null;
}

function assertTrustedFailureArtifact(repoRoot: string, taskId: string, failurePath: string, failure: Record<string, unknown>): void {
    const details = latestFailureEventDetails(repoRoot, taskId);
    const attemptPath = path.resolve(String(details?.artifact_path || ''));
    const expectedReviewsRoot = path.dirname(failurePath);
    const expectedAttemptName = new RegExp(`^${taskId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}-task-mode-entry-failure-[0-9a-f-]{36}\\.json$`, 'iu');
    const trusted = failure.schema_version === 1
        && failure.task_id === taskId && failure.status === 'BLOCKED'
        && /^[0-9a-f-]{36}$/iu.test(String(failure.attempt_id || ''))
        && details
        && path.dirname(attemptPath) === expectedReviewsRoot
        && expectedAttemptName.test(path.basename(attemptPath))
        && normalizePath(String(details.current_artifact_path || '')) === normalizePath(failurePath)
        && String(details.current_artifact_sha256 || '') === fileSha256(failurePath)
        && fs.existsSync(attemptPath)
        && normalizePath(attemptPath) === normalizePath(String(details.artifact_path || ''))
        && String(details.artifact_sha256 || '') === fileSha256(attemptPath)
        && fileSha256(attemptPath) === fileSha256(failurePath)
        && String(details.attempt_id || '') === String(failure.attempt_id || '')
        && String(details.timestamp_utc || '') === String(failure.timestamp_utc || '')
        && String(details.manifest_status || '') === String(failure.manifest_status || '')
        && normalizePath(String(details.manifest_path || '')) === normalizePath(String(failure.manifest_path || ''))
        && String(details.observed_protected_snapshot_sha256 || '') === String(failure.observed_protected_snapshot_sha256 || '')
        && JSON.stringify(details.requested_entry) === JSON.stringify(failure.requested_entry);
    if (!trusted) throw new Error('Task-mode protected-manifest failure evidence is missing, replaced, or not bound to an integrity-checked failure event.');
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((entry) => normalizePath(entry)).filter(Boolean) : [];
}

function buildFreshEntryCommand(repoRoot: string, input: Record<string, unknown>): string {
    const parts = [
        `${buildGateCommandPrefix(repoRoot)} gate enter-task-mode`,
        `--task-id ${quotePowerShellCliValue(String(input.taskId || ''))}`,
        `--entry-mode ${quotePowerShellCliValue(String(input.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quotePowerShellCliValue(String(input.requestedDepth || '2'))}`,
        `--task-summary ${quotePowerShellCliValue(String(input.taskSummary || ''))}`,
        `--provider ${quotePowerShellCliValue(String(input.provider || ''))}`
    ];
    for (const [flag, key] of [
        ['--effective-depth', 'effectiveDepth'],
        ['--start-banner', 'startBanner'],
        ['--routed-to', 'routedTo'],
        ['--actor', 'actor'],
        ['--plan-path', 'planPath'],
        ['--artifact-path', 'artifactPath'],
        ['--metrics-path', 'metricsPath']
    ] as const) {
        const value = String(input[key] || '').trim();
        if (value) parts.push(`${flag} ${quotePowerShellCliValue(value)}`);
    }
    if (input.orchestratorWork === true) parts.push('--orchestrator-work');
    if (input.workflowConfigWork === true) parts.push('--workflow-config-work');
    if (input.orchestratorWork === true || input.workflowConfigWork === true) {
        parts.push('--operator-confirmed yes', '--operator-confirmed-at-utc "<ISO-8601 timestamp>"');
    }
    if (input.emitMetrics === false || String(input.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const file of stringList(input.plannedChangedFiles)) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(file)}`);
    }
    parts.push('--repo-root "."');
    return parts.join(' ');
}

export function recordTaskModeProtectedManifestFailure(
    options: Record<string, unknown>,
    error: unknown
): boolean {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    if (!(error instanceof TaskModeProtectedManifestEntryError)) return false;
    const reason = error.message;
    const evidence = evaluateProtectedControlPlaneManifest(repoRoot, null, true);
    if (evidence.status === 'MATCH') return false;
    const artifactPath = reviewsPath(repoRoot, taskId, FAILURE_SUFFIX);
    const observedProtectedSnapshotSha256 = computeProtectedSnapshotDigest(
        scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), true)
    );
    const attemptId = randomUUID();
    const attemptArtifactPath = reviewsPath(repoRoot, taskId, `-task-mode-entry-failure-${attemptId}.json`);
    const plannedChangedFiles = stringList(options.plannedChangedFiles);
    const affectedProtectedPaths = evidence.changed_files.length > 0
        ? evidence.changed_files.map(normalizePath).sort()
        : plannedChangedFiles.filter((entry) => testPathPrefix(entry, getProtectedControlPlaneRoots(repoRoot))).sort();
    const requestedEntry = {
        taskId,
        entryMode: options.entryMode,
        requestedDepth: options.requestedDepth,
        effectiveDepth: options.effectiveDepth,
        taskSummary: options.taskSummary,
        startBanner: options.startBanner,
        plannedChangedFiles,
        orchestratorWork: options.orchestratorWork === true,
        workflowConfigWork: options.workflowConfigWork === true,
        provider: options.provider,
        routedTo: options.routedTo,
        actor: options.actor,
        planPath: options.planPath,
        artifactPath: options.artifactPath,
        metricsPath: options.metricsPath,
        emitMetrics: options.emitMetrics
    };
    const artifact = {
        schema_version: 1,
        attempt_id: attemptId,
        timestamp_utc: new Date().toISOString(),
        task_id: taskId,
        status: 'BLOCKED',
        manifest_status: evidence.status,
        manifest_path: normalizePath(evidence.manifest_path),
        observed_protected_snapshot_sha256: observedProtectedSnapshotSha256,
        affected_protected_paths: affectedProtectedPaths,
        reason,
        inspection_command: `${buildGateCommandPrefix(repoRoot)} repair inspect --target-root "."`,
        requested_entry: requestedEntry
    };
    writeJsonArtifact(attemptArtifactPath, artifact);
    writeJsonArtifact(artifactPath, artifact);
    const artifactSha256 = fileSha256(artifactPath);
    appendMandatoryTaskEvent(resolveOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_ENTRY_FAILED', 'FAIL',
        'Task-mode entry blocked by untrusted protected-manifest state.', {
            artifact_path: normalizePath(attemptArtifactPath), artifact_sha256: fileSha256(attemptArtifactPath),
            current_artifact_path: normalizePath(artifactPath), current_artifact_sha256: artifactSha256,
            attempt_id: attemptId, timestamp_utc: artifact.timestamp_utc, manifest_status: evidence.status,
            manifest_path: artifact.manifest_path, affected_protected_paths: artifact.affected_protected_paths,
            observed_protected_snapshot_sha256: observedProtectedSnapshotSha256,
            requested_entry: requestedEntry, reason, inspection_command: artifact.inspection_command
        });
    return true;
}

export interface RecoverTaskModeProtectedManifestOptions {
    repoRoot?: unknown;
    taskId?: unknown;
    operatorConfirmed?: unknown;
    operatorConfirmedAtUtc?: unknown;
    inspectedProtectedSnapshotSha256?: unknown;
}

export function runRecoverTaskModeProtectedManifestCommand(options: RecoverTaskModeProtectedManifestOptions): { outputLines: string[]; exitCode: number } {
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const taskId = assertValidTaskId(String(options.taskId || '').trim());
    const failurePath = reviewsPath(repoRoot, taskId, FAILURE_SUFFIX);
    if (!fs.existsSync(failurePath)) throw new Error(`Task-mode protected-manifest failure artifact is missing: ${normalizePath(failurePath)}.`);
    const failure = JSON.parse(fs.readFileSync(failurePath, 'utf8')) as Record<string, unknown>;
    assertTrustedFailureArtifact(repoRoot, taskId, failurePath, failure);
    const confirmationTimestamp = String(options.operatorConfirmedAtUtc || '');
    const inspectedSnapshotSha256 = String(options.inspectedProtectedSnapshotSha256 || '').trim().toLowerCase();
    validateFreshOperatorConfirmation({
        actionLabel: 'recover task-mode protected manifest',
        confirmed: parseOperatorConfirmationYes(String(options.operatorConfirmed || '')),
        confirmedAtUtc: confirmationTimestamp,
        requireConfirmedAtUtc: true,
        instruction: 'Obtain explicit operator approval, then rerun with --operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>".'
    });
    if (Date.parse(confirmationTimestamp) < Date.parse(String(failure.timestamp_utc || ''))) {
        throw new Error('Operator confirmation must be recorded after the persisted task-mode protected-manifest failure.');
    }
    const expectedSnapshotSha256 = String(failure.observed_protected_snapshot_sha256 || '').trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/u.test(inspectedSnapshotSha256) || inspectedSnapshotSha256 !== expectedSnapshotSha256) {
        throw new Error('Inspected protected snapshot SHA-256 must exactly match the persisted task-mode failure.');
    }
    const currentSnapshotSha256 = computeProtectedSnapshotDigest(
        scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), true)
    );
    if (currentSnapshotSha256 !== expectedSnapshotSha256) {
        throw new Error('Protected control-plane state changed after inspection; inspect again and create a fresh operator confirmation.');
    }
    const before = evaluateProtectedControlPlaneManifest(repoRoot, null, true);
    const repair = runRepairProtectedManifest(repoRoot, true);
    const after = evaluateProtectedControlPlaneManifest(repoRoot, null, true);
    if (after.status !== 'MATCH') throw new Error(`Protected-manifest recovery did not produce MATCH state (status=${after.status}).`);
    const freshEntryCommand = buildFreshEntryCommand(repoRoot, failure.requested_entry as Record<string, unknown>);
    const artifactPath = reviewsPath(repoRoot, taskId, RECOVERY_SUFFIX);
    const artifact = {
        schema_version: 1, timestamp_utc: new Date().toISOString(), task_id: taskId, status: 'RECOVERED',
        failure_artifact_path: normalizePath(failurePath), failure_artifact_sha256: fileSha256(failurePath),
        manifest_path: normalizePath(after.manifest_path), status_before: before.status, status_after: after.status,
        operator_confirmed_at_utc: confirmationTimestamp,
        inspected_protected_snapshot_sha256: inspectedSnapshotSha256,
        affected_protected_paths_before: before.changed_files.map(normalizePath).sort(), repair,
        requested_entry: failure.requested_entry, fresh_entry_command: freshEntryCommand
    };
    writeJsonArtifact(artifactPath, artifact);
    appendMandatoryTaskEvent(resolveOrchestratorRoot(repoRoot), taskId, 'TASK_MODE_PROTECTED_MANIFEST_RECOVERED', 'PASS',
        'Protected manifest repaired after explicit operator confirmation.', {
            artifact_path: normalizePath(artifactPath), artifact_sha256: fileSha256(artifactPath),
            failure_artifact_sha256: artifact.failure_artifact_sha256,
            manifest_path: artifact.manifest_path, status_before: before.status, status_after: after.status,
            inspected_protected_snapshot_sha256: inspectedSnapshotSha256,
            operator_confirmed_at_utc: confirmationTimestamp,
            requested_entry: failure.requested_entry,
            affected_protected_paths_before: artifact.affected_protected_paths_before
        });
    return { outputLines: ['TASK_MODE_PROTECTED_MANIFEST_RECOVERED', `RecoveryArtifactPath: ${normalizePath(artifactPath)}`, `NextCommand: ${freshEntryCommand}`], exitCode: 0 };
}
