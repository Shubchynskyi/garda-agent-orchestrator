import { TASK_QUEUE_FILENAME } from '../../core/orchestration-constants';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { isPlainRecord } from '../../core/records';
import {
    withTaskQueueStatusSyncLock
} from '../../cli/commands/gate-flows/task/task-queue-sync';
import {
    formatActiveTaskQueueTable,
    parseCanonicalActiveTaskQueue,
    replaceTaskMdTableCell
} from '../../core/task-md-table';
import {
    readTaskQueueStatusToken
} from '../../core/task-queue/active-task-state';
import {
    appendMandatoryTaskEvent
} from '../../gate-runtime/task-events';
import {
    withFilesystemLock
} from '../../gate-runtime/timeline/task-events-locking';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import {
    materializeSplitRequiredLatch
} from '../next-step/next-step-split-required-latch';
import {
    fileSha256,
    joinOrchestratorPath,
    normalizePath
} from '../shared/helpers';
import {
    REPAIR_ARTIFACT_SCHEMA_VERSION,
    buildNextStepCommand,
    formatFullSuiteRepairOutput,
    nowIso,
    sha256Text,
    stableTimestampSlug,
    validateRepairChildTaskId,
    validateTaskTableTextField,
    writeJson
} from './full-suite-repair-contracts';
import type {
    FullSuiteRepairTaskMaterializationResult,
    FullSuiteRepairTaskProposal,
    MaterializeFullSuiteRepairTaskParams,
    RepairTaskProposalReadResult,
    TaskQueueRowsMaterializationResult
} from './full-suite-repair-contracts';
import {
    collectCapturedUntrackedFiles,
    collectTrackedChangeFiles,
    collectVisibleUntrackedFiles,
    ensureContainedDirectoryPath,
    findOutOfScopeTrackedChanges,
    isTaskOwnedUntrackedPath,
    planWipCaptureLocation,
    prepareWipCapture,
    readImmutableRegularFileSnapshot,
    readPreflightChangedFileScope,
    removePreparedWipCapture,
    rollbackPreparedWipSuspension,
    suspendPreparedWip,
    validatePreparedWipSuspended,
    validateUntrackedCaptureSource,
    validateWorkspaceMatchesPreparedCapture,
    verifyPreparedWipCapture,
    writeExclusiveCaptureFile
} from './full-suite-repair-capture';
import type {
    CaptureFileSnapshot,
    PreparedWipCapture
} from './full-suite-repair-capture';
import {
    assertSingleLinkIdentity,
    isSha256,
    parseRepairWipManifest,
    resolveInputPathInsideRepo,
    sameFileIdentity,
    sameFileSnapshot,
    validatePhysicalRepoContainment
} from './full-suite-repair-manifest';

function readRepairTaskProposal(fullSuiteArtifactPath: string, parentTaskId: string): RepairTaskProposalReadResult {
    const artifact = safeReadJson(fullSuiteArtifactPath);
    const timeoutPolicy = isPlainRecord(artifact?.timeout_policy) ? artifact.timeout_policy : null;
    const proposal = isPlainRecord(timeoutPolicy?.repair_task_proposal)
        ? timeoutPolicy.repair_task_proposal
        : null;
    if (!proposal) {
        return {
            proposal: null,
            violations: ['Current full-suite artifact has no structured timeout repair_task_proposal.']
        };
    }
    const childTaskId = validateRepairChildTaskId(proposal.suggested_task_id, parentTaskId);
    const title = validateTaskTableTextField(proposal.title, 'title');
    const area = validateTaskTableTextField(proposal.area, 'area');
    const rationale = validateTaskTableTextField(proposal.rationale, 'rationale');
    const violations = [
        ...childTaskId.violations,
        ...title.violations,
        ...area.violations,
        ...rationale.violations
    ];
    if (violations.length > 0 || !childTaskId.value || !title.value || !area.value || !rationale.value) {
        return { proposal: null, violations };
    }
    return {
        proposal: {
            suggested_task_id: childTaskId.value,
            title: title.value,
            area: area.value,
            rationale: rationale.value
        },
        violations: []
    };
}

export function resolveFullSuiteRepairTaskArtifactPath(reviewsRoot: string, taskId: string): string {
    return path.join(reviewsRoot, `${taskId}-full-suite-repair-task.json`);
}

export function readFullSuiteRepairTaskMaterializationEvidence(params: {
    repoRoot: string;
    reviewsRoot: string;
    taskId: string;
    fullSuiteArtifactPath: string;
    childTaskId: string | null;
}): {
    materialized: boolean;
    reason: string;
    artifact_path: string;
    child_task_id?: string | null;
    wip_manifest_path?: string | null;
    wip_manifest_sha256?: string | null;
    split_required_artifact_path?: string | null;
} {
    let artifactPath = resolveFullSuiteRepairTaskArtifactPath(params.reviewsRoot, params.taskId);
    let artifact: unknown = null;
    try {
        const reviewsRoot = resolveInputPathInsideRepo(params.repoRoot, params.reviewsRoot, 'ReviewsRoot');
        artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
        const containmentViolations = validatePhysicalRepoContainment(
            params.repoRoot,
            artifactPath,
            'full-suite repair materialization artifact'
        );
        if (containmentViolations.length > 0) {
            return {
                materialized: false,
                reason: `full-suite repair materialization artifact is outside its physical repository boundary: ${containmentViolations.join(' ')}`,
                artifact_path: normalizePath(artifactPath)
            };
        }
        if (!fs.existsSync(artifactPath)) {
            return {
                materialized: false,
                reason: `full-suite repair materialization artifact is missing at ${normalizePath(artifactPath)}`,
                artifact_path: normalizePath(artifactPath)
            };
        }
        const artifactSnapshot = readImmutableRegularFileSnapshot({
            repoRoot: params.repoRoot,
            filePath: artifactPath,
            label: 'full-suite repair materialization artifact'
        });
        artifact = JSON.parse(artifactSnapshot.content.toString('utf8')) as unknown;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            materialized: false,
            reason: `full-suite repair materialization artifact cannot be read safely: ${message}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    if (!isPlainRecord(artifact)) {
        return {
            materialized: false,
            reason: `full-suite repair materialization artifact is invalid at ${normalizePath(artifactPath)}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    if (artifact.task_id !== params.taskId) {
        return { materialized: false, reason: 'full-suite repair artifact task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (params.childTaskId && artifact.child_task_id !== params.childTaskId) {
        return { materialized: false, reason: 'full-suite repair artifact child_task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (artifact.status !== 'MATERIALIZED') {
        return { materialized: false, reason: 'full-suite repair artifact status is not MATERIALIZED', artifact_path: normalizePath(artifactPath) };
    }
    const expectedFullSuiteSha = fileSha256(params.fullSuiteArtifactPath);
    if (!expectedFullSuiteSha || artifact.full_suite_artifact_sha256 !== expectedFullSuiteSha) {
        return { materialized: false, reason: 'full-suite repair artifact is not bound to the current full-suite artifact', artifact_path: normalizePath(artifactPath) };
    }
    let manifestPath = String(artifact.wip_manifest_path || '');
    try {
        manifestPath = resolveInputPathInsideRepo(params.repoRoot, manifestPath, 'WipManifestPath');
    } catch {
        return { materialized: false, reason: 'full-suite repair WIP manifest path escapes repo root', artifact_path: normalizePath(artifactPath) };
    }
    const expectedManifestSha = String(artifact.wip_manifest_sha256 || '').trim();
    let manifestSnapshot: CaptureFileSnapshot;
    try {
        manifestSnapshot = readImmutableRegularFileSnapshot({
            repoRoot: params.repoRoot,
            filePath: manifestPath,
            label: 'full-suite repair WIP manifest'
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return {
            materialized: false,
            reason: `full-suite repair WIP manifest cannot be read safely: ${message}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    const manifestBytes = manifestSnapshot.content;
    const actualManifestSha = createHash('sha256').update(manifestBytes).digest('hex');
    if (!isSha256(expectedManifestSha) || actualManifestSha !== expectedManifestSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest sha256 mismatch', artifact_path: normalizePath(artifactPath) };
    }
    let manifest: unknown = null;
    try {
        manifest = JSON.parse(manifestBytes.toString('utf8')) as unknown;
    } catch {
        manifest = null;
    }
    const parsedManifest = parseRepairWipManifest(params.repoRoot, manifestPath, manifest);
    if (!parsedManifest.manifest) {
        return {
            materialized: false,
            reason: `full-suite repair WIP manifest schema is invalid: ${parsedManifest.violations.join(' ')}`,
            artifact_path: normalizePath(artifactPath)
        };
    }
    const parsedValue = parsedManifest.manifest;
    if (parsedValue.task_id !== params.taskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (params.childTaskId && parsedValue.child_task_id !== params.childTaskId) {
        return { materialized: false, reason: 'full-suite repair WIP manifest child_task_id mismatch', artifact_path: normalizePath(artifactPath) };
    }
    if (parsedValue.full_suite_artifact_sha256 !== expectedFullSuiteSha) {
        return { materialized: false, reason: 'full-suite repair WIP manifest is not bound to the current full-suite artifact', artifact_path: normalizePath(artifactPath) };
    }
    return {
        materialized: true,
        reason: 'full-suite repair task and WIP manifest are materialized',
        artifact_path: normalizePath(artifactPath),
        child_task_id: String(artifact.child_task_id || ''),
        wip_manifest_path: normalizePath(manifestPath),
        wip_manifest_sha256: expectedManifestSha,
        split_required_artifact_path: typeof artifact.split_required_artifact_path === 'string'
            ? normalizePath(artifact.split_required_artifact_path)
            : null
    };
}

function appendChildLinkNote(existingNotes: string, childTaskId: string, manifestPath: string): string {
    if (existingNotes.includes(childTaskId)) {
        return existingNotes;
    }
    const suffix = `Created child tasks: \`${childTaskId}\`; parent WIP suspended at \`${normalizePath(manifestPath)}\`.`;
    return existingNotes.trim() ? `${existingNotes.trim()} ${suffix}` : suffix;
}

function materializeTaskQueueRows(params: {
    repoRoot: string;
    parentTaskId: string;
    proposal: FullSuiteRepairTaskProposal;
    manifestPath: string;
}): TaskQueueRowsMaterializationResult {
    const taskPath = path.join(params.repoRoot, TASK_QUEUE_FILENAME);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            parent_linked: false,
            child_created: false,
            error_message: null
        };
    }
    return withTaskQueueStatusSyncLock<TaskQueueRowsMaterializationResult>(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            parent_linked: false,
            child_created: false,
            error_message: message
        }),
        () => {
            const original = fs.readFileSync(taskPath, 'utf8');
            const newline = original.includes('\r\n') ? '\r\n' : '\n';
            const lines = original.split(/\r?\n/);
            const parsed = parseCanonicalActiveTaskQueue(original);
            const parentRow = parsed.rows.find((row) => row.taskId === params.parentTaskId);
            if (!parentRow) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    parent_linked: false,
                    child_created: false,
                    error_message: null
                };
            }
            const childExists = parsed.rows.some((row) => row.taskId === params.proposal.suggested_task_id);
            const nextNotes = appendChildLinkNote(parentRow.notes, params.proposal.suggested_task_id, params.manifestPath);
            let parentLinked = false;
            const updatedParentLine = replaceTaskMdTableCell(parentRow.rawLine, 8, ` ${nextNotes} `);
            if (updatedParentLine && updatedParentLine !== parentRow.rawLine) {
                lines[parentRow.lineIndex] = updatedParentLine;
                parentLinked = true;
            }

            let childCreated = false;
            if (!childExists) {
                const today = nowIso().slice(0, 10);
                const childNotes = `Child of \`${params.parentTaskId}\`. Repair full-suite timeout blocker. Restore parent WIP from \`${normalizePath(params.manifestPath)}\` after child completion.`;
                const row = [
                    params.proposal.suggested_task_id,
                    'TODO',
                    parentRow.priority || 'P1',
                    params.proposal.area,
                    params.proposal.title,
                    parentRow.owner || 'gpt-5.5',
                    today,
                    'strict',
                    childNotes
                ];
                const childLine = `| ${row.join(' | ')} |`;
                lines.splice(parentRow.lineIndex + 1, 0, childLine);
                childCreated = true;
            }

            const nextContent = formatActiveTaskQueueTable(lines.join(newline));
            if (nextContent !== original) {
                fs.writeFileSync(taskPath, nextContent, 'utf8');
            }
            return {
                outcome: childCreated || parentLinked ? 'updated' : 'already_synced',
                task_path: normalizePath(taskPath),
                parent_linked: parentLinked,
                child_created: childCreated,
                error_message: null
            };
        }
    );
}

interface OptionalControlPlaneFileSnapshot {
    path: string;
    existed: boolean;
    content: Buffer | null;
    mode: number | null;
}

function snapshotOptionalControlPlaneFile(
    repoRoot: string,
    filePath: string,
    label: string
): OptionalControlPlaneFileSnapshot {
    const resolvedPath = resolveInputPathInsideRepo(repoRoot, filePath, label);
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, resolvedPath, label);
    if (containmentViolations.length > 0) {
        throw new Error(containmentViolations.join(' '));
    }
    if (!fs.existsSync(resolvedPath)) {
        return {
            path: resolvedPath,
            existed: false,
            content: null,
            mode: null
        };
    }
    const identityBeforeRead = fs.lstatSync(resolvedPath);
    assertSingleLinkIdentity(identityBeforeRead, label);
    const content = fs.readFileSync(resolvedPath);
    const identityAfterRead = fs.lstatSync(resolvedPath);
    assertSingleLinkIdentity(identityAfterRead, label);
    if (!sameFileSnapshot(identityBeforeRead, identityAfterRead)) {
        throw new Error(`${label} changed while taking the transaction snapshot.`);
    }
    return {
        path: resolvedPath,
        existed: true,
        content,
        mode: identityAfterRead.mode & 0o777
    };
}

function restoreOptionalControlPlaneFile(
    repoRoot: string,
    snapshot: OptionalControlPlaneFileSnapshot,
    label: string
): string[] {
    const containmentViolations = validatePhysicalRepoContainment(repoRoot, snapshot.path, label);
    if (containmentViolations.length > 0) {
        return containmentViolations;
    }
    try {
        if (!snapshot.existed) {
            if (!fs.existsSync(snapshot.path)) {
                return [];
            }
            const identity = fs.lstatSync(snapshot.path);
            assertSingleLinkIdentity(identity, label);
            fs.unlinkSync(snapshot.path);
            return [];
        }
        if (!snapshot.content) {
            return [`${label} snapshot content is missing.`];
        }
        ensureContainedDirectoryPath(repoRoot, path.dirname(snapshot.path), `${label} parent`);
        if (fs.existsSync(snapshot.path)) {
            const currentIdentity = fs.lstatSync(snapshot.path);
            assertSingleLinkIdentity(currentIdentity, label);
        }
        const noFollowFlag = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
        const descriptor = fs.openSync(
            snapshot.path,
            fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_WRONLY | noFollowFlag,
            0o600
        );
        try {
            const openedIdentity = fs.fstatSync(descriptor);
            assertSingleLinkIdentity(openedIdentity, label);
            fs.writeFileSync(descriptor, snapshot.content);
            if (snapshot.mode !== null) {
                fs.fchmodSync(descriptor, snapshot.mode);
            }
            fs.fsyncSync(descriptor);
            const pathIdentity = fs.lstatSync(snapshot.path);
            if (!sameFileIdentity(openedIdentity, pathIdentity)) {
                throw new Error(`${label} identity changed while restoring the transaction snapshot.`);
            }
        } finally {
            fs.closeSync(descriptor);
        }
        const restoredContent = fs.readFileSync(snapshot.path);
        return restoredContent.equals(snapshot.content)
            ? []
            : [`${label} content does not match its transaction snapshot after rollback.`];
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`${label} rollback failed: ${message}`];
    }
}

function readTaskStatusFromControlPlaneSnapshot(
    snapshot: OptionalControlPlaneFileSnapshot,
    taskId: string
): string | null {
    if (!snapshot.existed || !snapshot.content) {
        return null;
    }
    const row = parseCanonicalActiveTaskQueue(snapshot.content.toString('utf8'))
        .rows
        .find((candidate) => candidate.taskId === taskId);
    return row ? readTaskQueueStatusToken(row.status) : null;
}

function restoreTaskQueueTransactionSnapshot(
    repoRoot: string,
    snapshot: OptionalControlPlaneFileSnapshot
): string[] {
    try {
        return withTaskQueueStatusSyncLock<string[]>(
            snapshot.path,
            (message) => [`TASK.md transaction rollback failed: ${message}`],
            () => restoreOptionalControlPlaneFile(repoRoot, snapshot, 'TASK.md transaction snapshot')
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        return [`TASK.md transaction rollback failed: ${message}`];
    }
}

function buildBlockedMaterializationResult(params: {
    repoRoot: string;
    taskId: string;
    proposal: FullSuiteRepairTaskProposal;
    artifactPath: string;
    preflightPath: string;
    fullSuiteArtifactPath: string;
    timestampUtc: string;
    queueResult: TaskQueueRowsMaterializationResult | null;
    splitRequiredArtifactPath: string | null;
    splitRequiredArtifactSha256: string | null;
    retainedManifestPath: string | null;
    priorMaterializationArtifactSnapshot: OptionalControlPlaneFileSnapshot | null;
    violations: string[];
}): FullSuiteRepairTaskMaterializationResult {
    let blockedArtifactPath = params.artifactPath;
    if (params.priorMaterializationArtifactSnapshot?.existed) {
        const timestampSlug = stableTimestampSlug(params.timestampUtc);
        const failureStem = `${params.artifactPath}.failure-${timestampSlug}`;
        let suffix = 0;
        do {
            blockedArtifactPath = `${failureStem}${suffix === 0 ? '' : `-${suffix}`}.json`;
            suffix += 1;
        } while (fs.existsSync(blockedArtifactPath));
    }
    const blockedArtifact = {
        schema_version: REPAIR_ARTIFACT_SCHEMA_VERSION,
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: params.proposal.suggested_task_id,
        created_at_utc: params.timestampUtc,
        proposal: params.proposal,
        preflight_path: normalizePath(params.preflightPath),
        preflight_sha256: fileSha256(params.preflightPath),
        full_suite_artifact_path: normalizePath(params.fullSuiteArtifactPath),
        full_suite_artifact_sha256: fileSha256(params.fullSuiteArtifactPath),
        wip_manifest_path: params.retainedManifestPath
            ? normalizePath(params.retainedManifestPath)
            : null,
        wip_manifest_sha256: params.retainedManifestPath && fs.existsSync(params.retainedManifestPath)
            ? fileSha256(params.retainedManifestPath)
            : null,
        split_required_artifact_path: params.splitRequiredArtifactPath,
        split_required_artifact_sha256: params.splitRequiredArtifactSha256,
        task_queue: params.queueResult,
        violations: params.violations
    };
    try {
        if (params.priorMaterializationArtifactSnapshot?.existed) {
            writeExclusiveCaptureFile(
                params.repoRoot,
                blockedArtifactPath,
                Buffer.from(`${JSON.stringify(blockedArtifact, null, 2)}\n`, 'utf8'),
                'blocked repair materialization failure artifact'
            );
        } else {
            writeJson(blockedArtifactPath, blockedArtifact);
        }
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        params.violations.push(`failed to persist blocked repair materialization artifact: ${message}`);
    }
    try {
        appendMandatoryTaskEvent(
            joinOrchestratorPath(params.repoRoot, ''),
            params.taskId,
            'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
            'FAIL',
            'Full-suite timeout repair task materialization failed and transactional rollback was attempted.',
            {
                artifact_path: normalizePath(blockedArtifactPath),
                artifact_sha256: fs.existsSync(blockedArtifactPath) ? fileSha256(blockedArtifactPath) : null,
                child_task_id: params.proposal.suggested_task_id,
                wip_manifest_path: params.retainedManifestPath
                    ? normalizePath(params.retainedManifestPath)
                    : null,
                split_required_artifact_path: params.splitRequiredArtifactPath,
                violations: params.violations
            },
            { actor: 'orchestrator' }
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        params.violations.push(`failed to record blocked repair materialization event: ${message}`);
        if (!params.priorMaterializationArtifactSnapshot?.existed) {
            try {
                writeJson(blockedArtifactPath, {
                    ...blockedArtifact,
                    violations: params.violations
                });
            } catch {
                // The primary violation already records that durable failure evidence could not be committed.
            }
        }
    }
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: params.proposal.suggested_task_id,
        artifact_path: normalizePath(blockedArtifactPath),
        wip_manifest_path: params.retainedManifestPath
            ? normalizePath(params.retainedManifestPath)
            : null,
        split_required_artifact_path: params.splitRequiredArtifactPath,
        violations: params.violations,
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            action: 'Resolve repair task materialization failures before retrying.',
            reason: params.violations.join(' '),
            detailsPath: blockedArtifactPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ChildTaskId: ${params.proposal.suggested_task_id}`,
                `ArtifactPath: ${normalizePath(blockedArtifactPath)}`,
                ...params.violations.map((violation) => `Violation: ${violation}`)
            ]
        })
    };
}

function materializeFullSuiteRepairTaskUnlocked(
    params: MaterializeFullSuiteRepairTaskParams
): FullSuiteRepairTaskMaterializationResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    const reviewsRoot = params.reviewsRoot
        ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
        : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const fullSuiteArtifactPath = params.fullSuiteArtifactPath
        ? resolveInputPathInsideRepo(repoRoot, params.fullSuiteArtifactPath, 'FullSuiteArtifactPath')
        : path.join(reviewsRoot, `${params.taskId}-full-suite-validation.json`);
    const preflightPath = resolveInputPathInsideRepo(repoRoot, params.preflightPath, 'PreflightPath');
    const artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
    const proposalResult = readRepairTaskProposal(fullSuiteArtifactPath, params.taskId);
    const violations: string[] = [...proposalResult.violations];
    const proposal = proposalResult.proposal;
    if (!proposal) {
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: null,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Fix full-suite repair proposal evidence before retrying materialization.',
                reason: violations.join(' '),
                detailsPath: fullSuiteArtifactPath,
                legacyLines: ['FULL_SUITE_REPAIR_TASK_BLOCKED', ...violations.map((violation) => `Violation: ${violation}`)]
            })
        };
    }
    const currentEvidence = readFullSuiteRepairTaskMaterializationEvidence({
        repoRoot,
        reviewsRoot,
        taskId: params.taskId,
        fullSuiteArtifactPath,
        childTaskId: proposal.suggested_task_id
    });
    if (currentEvidence.materialized) {
        return {
            status: 'ALREADY_MATERIALIZED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: currentEvidence.wip_manifest_path || null,
            split_required_artifact_path: currentEvidence.split_required_artifact_path || null,
            violations: [],
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'ALREADY_MATERIALIZED',
                action: 'Continue parent routing through the existing repair child.',
                reason: currentEvidence.reason,
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_ALREADY_MATERIALIZED',
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    `Reason: ${currentEvidence.reason}`
                ]
            })
        };
    }
    const preflightScope = readPreflightChangedFileScope(repoRoot, preflightPath, params.taskId);
    const trackedChanges = collectTrackedChangeFiles(repoRoot);
    const outOfScopeTrackedChanges = findOutOfScopeTrackedChanges(trackedChanges, preflightScope.allowed);
    const unrelatedVisibleUntrackedFiles = collectVisibleUntrackedFiles(repoRoot)
        .filter((relativePath) => (
            !isTaskOwnedUntrackedPath(relativePath, params.taskId)
            && !preflightScope.allowed.has(relativePath)
        ));
    const scopeViolations = [...preflightScope.violations];
    if (outOfScopeTrackedChanges.length > 0) {
        scopeViolations.push(`tracked changes outside current preflight scope: ${outOfScopeTrackedChanges.join(', ')}`);
    }
    if (unrelatedVisibleUntrackedFiles.length > 0) {
        scopeViolations.push(`unrelated untracked files would keep repair scope dirty: ${unrelatedVisibleUntrackedFiles.join(', ')}`);
    }
    for (const relativePath of collectCapturedUntrackedFiles(repoRoot, params.taskId, preflightScope.allowed)) {
        scopeViolations.push(...validateUntrackedCaptureSource(repoRoot, relativePath));
    }
    const wipCapture = planWipCaptureLocation(repoRoot, params.taskId);
    let preparedCapture: PreparedWipCapture | null = null;
    if (scopeViolations.length === 0) {
        try {
            preparedCapture = prepareWipCapture({
                repoRoot,
                taskId: params.taskId,
                childTaskId: proposal.suggested_task_id,
                captureRoot: wipCapture.captureRoot,
                timestampUtc: wipCapture.timestampUtc,
                preflightPath,
                fullSuiteArtifactPath,
                trackedChanges,
                allowedUntrackedFiles: preflightScope.allowed,
                unrelatedVisibleUntrackedFiles
            });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            scopeViolations.push(`WIP capture preparation failed before durable task mutation: ${message}`);
        }
    }
    if (preparedCapture && scopeViolations.length === 0) {
        try {
            preparedCapture = verifyPreparedWipCapture(repoRoot, preparedCapture);
            scopeViolations.push(
                ...validateWorkspaceMatchesPreparedCapture(repoRoot, trackedChanges, preparedCapture)
            );
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);
            scopeViolations.push(`WIP capture verification failed before durable task mutation: ${message}`);
        }
        if (scopeViolations.length > 0) {
            scopeViolations.push(...removePreparedWipCapture(repoRoot, wipCapture.captureRoot));
        }
    }
    if (scopeViolations.length > 0) {
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations: scopeViolations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Resolve repair materialization scope blockers before retrying.',
                reason: scopeViolations.join(' '),
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_BLOCKED',
                    `TaskId: ${params.taskId}`,
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    ...scopeViolations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }

    if (!preparedCapture) {
        throw new Error('prepared WIP capture missing after successful capture preconditions');
    }
    const taskPath = path.join(repoRoot, TASK_QUEUE_FILENAME);
    const splitRequiredArtifactPath = path.join(reviewsRoot, `${params.taskId}-split-required.json`);
    let taskSnapshot: OptionalControlPlaneFileSnapshot;
    let splitRequiredSnapshot: OptionalControlPlaneFileSnapshot;
    let materializationArtifactSnapshot: OptionalControlPlaneFileSnapshot;
    try {
        taskSnapshot = snapshotOptionalControlPlaneFile(repoRoot, taskPath, 'TASK.md transaction snapshot');
        splitRequiredSnapshot = snapshotOptionalControlPlaneFile(
            repoRoot,
            splitRequiredArtifactPath,
            'split-required transaction snapshot'
        );
        materializationArtifactSnapshot = snapshotOptionalControlPlaneFile(
            repoRoot,
            artifactPath,
            'repair materialization artifact transaction snapshot'
        );
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const snapshotViolations = [
            `repair materialization transaction snapshot failed: ${message}`,
            ...removePreparedWipCapture(repoRoot, wipCapture.captureRoot)
        ];
        return {
            status: 'BLOCKED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: null,
            split_required_artifact_path: null,
            violations: snapshotViolations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'BLOCKED',
                action: 'Resolve repair materialization snapshot blockers before retrying.',
                reason: snapshotViolations.join(' '),
                detailsPath: artifactPath,
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_BLOCKED',
                    ...snapshotViolations.map((violation) => `Violation: ${violation}`)
                ]
            })
        };
    }

    let queueResult: TaskQueueRowsMaterializationResult | null = null;
    let latchResult: ReturnType<typeof materializeSplitRequiredLatch> | null = null;
    let suspensionStarted = false;
    try {
        queueResult = materializeTaskQueueRows({
            repoRoot,
            parentTaskId: params.taskId,
            proposal,
            manifestPath: wipCapture.manifestPath
        });
        if (queueResult.outcome === 'task_file_missing'
            || queueResult.outcome === 'task_not_found'
            || queueResult.outcome === 'write_failed') {
            throw new Error(
                `TASK.md repair child materialization failed: ${queueResult.outcome}`
                + `${queueResult.error_message ? ` (${queueResult.error_message})` : ''}.`
            );
        }

        latchResult = materializeSplitRequiredLatch({
            repoRoot,
            eventsRoot: joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events')),
            reviewsRoot,
            taskId: params.taskId,
            guardKind: 'full_suite_repair',
            guardReason: 'Full-suite timeout blocker exhausted retry policy and requires repair child scope.',
            rawGuardSummary: proposal.rationale,
            preflightPath,
            guardDetails: {
                repair_child_task_id: proposal.suggested_task_id,
                full_suite_artifact_path: normalizePath(fullSuiteArtifactPath),
                wip_manifest_path: normalizePath(wipCapture.manifestPath)
            }
        });
        if (latchResult.status_sync.outcome === 'task_file_missing'
            || latchResult.status_sync.outcome === 'task_not_found'
            || latchResult.status_sync.outcome === 'write_failed') {
            throw new Error(
                `Split-required latch failed: ${latchResult.status_sync.outcome}`
                + `${latchResult.status_sync.error_message ? ` (${latchResult.status_sync.error_message})` : ''}.`
            );
        }
        preparedCapture = verifyPreparedWipCapture(repoRoot, preparedCapture);
        const finalWorkspaceViolations = validateWorkspaceMatchesPreparedCapture(
            repoRoot,
            trackedChanges,
            preparedCapture
        );
        if (finalWorkspaceViolations.length > 0) {
            throw new Error(`WIP changed before suspension: ${finalWorkspaceViolations.join(' ')}`);
        }

        suspensionStarted = true;
        suspendPreparedWip(repoRoot, trackedChanges, preparedCapture);
        const suspensionViolations = validatePreparedWipSuspended(repoRoot, preparedCapture);
        if (suspensionViolations.length > 0) {
            throw new Error(suspensionViolations.join(' '));
        }
        const manifestPath = wipCapture.manifestPath;
        const materializationArtifact = {
            schema_version: REPAIR_ARTIFACT_SCHEMA_VERSION,
            status: 'MATERIALIZED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            created_at_utc: nowIso(),
            proposal,
            preflight_path: normalizePath(preflightPath),
            preflight_sha256: fileSha256(preflightPath),
            full_suite_artifact_path: normalizePath(fullSuiteArtifactPath),
            full_suite_artifact_sha256: fileSha256(fullSuiteArtifactPath),
            wip_manifest_path: normalizePath(manifestPath),
            wip_manifest_sha256: createHash('sha256').update(preparedCapture.manifestSnapshot.content).digest('hex'),
            split_required_artifact_path: latchResult.artifact_path,
            split_required_artifact_sha256: latchResult.artifact_sha256,
            task_queue: queueResult,
            violations
        };
        writeJson(artifactPath, materializationArtifact);
        appendMandatoryTaskEvent(
            joinOrchestratorPath(repoRoot, ''),
            params.taskId,
            'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
            'BLOCKED',
            'Full-suite timeout repair task materialized and parent WIP suspended.',
            {
                artifact_path: normalizePath(artifactPath),
                artifact_sha256: sha256Text(`${JSON.stringify(materializationArtifact, null, 2)}\n`),
                child_task_id: proposal.suggested_task_id,
                wip_manifest_path: normalizePath(manifestPath),
                split_required_artifact_path: latchResult.artifact_path,
                violations
            },
            { actor: 'orchestrator' }
        );

        return {
            status: 'MATERIALIZED',
            task_id: params.taskId,
            child_task_id: proposal.suggested_task_id,
            artifact_path: normalizePath(artifactPath),
            wip_manifest_path: normalizePath(manifestPath),
            split_required_artifact_path: latchResult.artifact_path,
            violations,
            output_lines: formatFullSuiteRepairOutput({
                repoRoot,
                taskId: params.taskId,
                status: 'MATERIALIZED',
                action: 'Continue parent routing through the repair child.',
                reason: 'Full-suite timeout repair task materialized and parent WIP suspended.',
                detailsPath: artifactPath,
                detailsHint: 'Parent routing should continue via the repair child.',
                legacyLines: [
                    'FULL_SUITE_REPAIR_TASK_MATERIALIZED',
                    `TaskId: ${params.taskId}`,
                    `ChildTaskId: ${proposal.suggested_task_id}`,
                    `ArtifactPath: ${normalizePath(artifactPath)}`,
                    `WipManifestPath: ${normalizePath(manifestPath)}`,
                    `SplitRequiredArtifactPath: ${latchResult.artifact_path}`,
                    `NextStep: run ${buildNextStepCommand(repoRoot, params.taskId) || 'next-step'}; parent routing should continue via the repair child.`
                ]
            })
        };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        violations.push(`repair materialization transaction failed: ${message}`);
        const rollbackViolations: string[] = [];
        if (suspensionStarted) {
            rollbackViolations.push(
                ...rollbackPreparedWipSuspension(repoRoot, trackedChanges, preparedCapture)
            );
        }
        rollbackViolations.push(...restoreTaskQueueTransactionSnapshot(repoRoot, taskSnapshot));
        rollbackViolations.push(
            ...restoreOptionalControlPlaneFile(
                repoRoot,
                splitRequiredSnapshot,
                'split-required transaction snapshot'
            )
        );
        rollbackViolations.push(
            ...restoreOptionalControlPlaneFile(
                repoRoot,
                materializationArtifactSnapshot,
                'repair materialization artifact transaction snapshot'
            )
        );
        if (latchResult?.status_sync.outcome === 'updated') {
            const restoredStatus = readTaskStatusFromControlPlaneSnapshot(taskSnapshot, params.taskId);
            if (!restoredStatus) {
                rollbackViolations.push(
                    `failed to record compensating parent status event: original status for ${params.taskId} is unavailable.`
                );
            } else {
                try {
                    appendMandatoryTaskEvent(
                        joinOrchestratorPath(repoRoot, ''),
                        params.taskId,
                        'STATUS_CHANGED',
                        'INFO',
                        `Task status changed: SPLIT_REQUIRED -> ${restoredStatus}.`,
                        {
                            previous_status: 'SPLIT_REQUIRED',
                            new_status: restoredStatus,
                            reason: 'full_suite_repair_materialization_rollback',
                            repair_child_task_id: proposal.suggested_task_id
                        },
                        { actor: 'orchestrator' }
                    );
                } catch (eventError: unknown) {
                    const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
                    rollbackViolations.push(
                        `failed to record compensating parent status event: ${eventMessage}`
                    );
                }
            }
        }
        let retainedManifestPath: string | null = wipCapture.manifestPath;
        if (rollbackViolations.length === 0) {
            const cleanupViolations = removePreparedWipCapture(repoRoot, wipCapture.captureRoot);
            rollbackViolations.push(...cleanupViolations);
            if (cleanupViolations.length === 0) {
                retainedManifestPath = null;
            }
        }
        violations.push(...rollbackViolations);
        try {
            appendMandatoryTaskEvent(
                joinOrchestratorPath(repoRoot, ''),
                params.taskId,
                'FULL_SUITE_REPAIR_TASK_MATERIALIZATION_ROLLED_BACK',
                rollbackViolations.length === 0 ? 'BLOCKED' : 'FAIL',
                rollbackViolations.length === 0
                    ? 'Full-suite repair task materialization rolled back transactionally.'
                    : 'Full-suite repair task materialization rollback is incomplete.',
                {
                    child_task_id: proposal.suggested_task_id,
                    wip_manifest_path: retainedManifestPath
                        ? normalizePath(retainedManifestPath)
                        : null,
                    task_queue: queueResult,
                    split_required_artifact_path: splitRequiredSnapshot.existed
                        ? normalizePath(splitRequiredSnapshot.path)
                        : null,
                    rollback_violations: rollbackViolations,
                    failure: message
                },
                { actor: 'orchestrator' }
            );
        } catch (eventError: unknown) {
            const eventMessage = eventError instanceof Error ? eventError.message : String(eventError);
            violations.push(`failed to record repair materialization rollback event: ${eventMessage}`);
        }
        return buildBlockedMaterializationResult({
            repoRoot,
            taskId: params.taskId,
            proposal,
            artifactPath,
            preflightPath,
            fullSuiteArtifactPath,
            timestampUtc: wipCapture.timestampUtc,
            queueResult,
            splitRequiredArtifactPath: splitRequiredSnapshot.existed
                ? normalizePath(splitRequiredSnapshot.path)
                : null,
            splitRequiredArtifactSha256: splitRequiredSnapshot.content
                ? createHash('sha256').update(splitRequiredSnapshot.content).digest('hex')
                : null,
            retainedManifestPath,
            priorMaterializationArtifactSnapshot: materializationArtifactSnapshot,
            violations
        });
    }
}

function buildMaterializationLockBlockedResult(params: {
    repoRoot: string;
    taskId: string;
    artifactPath: string;
    violation: string;
    action: string;
}): FullSuiteRepairTaskMaterializationResult {
    return {
        status: 'BLOCKED',
        task_id: params.taskId,
        child_task_id: null,
        artifact_path: normalizePath(params.artifactPath),
        wip_manifest_path: null,
        split_required_artifact_path: null,
        violations: [params.violation],
        output_lines: formatFullSuiteRepairOutput({
            repoRoot: params.repoRoot,
            taskId: params.taskId,
            status: 'BLOCKED',
            action: params.action,
            reason: params.violation,
            detailsPath: params.artifactPath,
            legacyLines: [
                'FULL_SUITE_REPAIR_TASK_BLOCKED',
                `TaskId: ${params.taskId}`,
                `ArtifactPath: ${normalizePath(params.artifactPath)}`,
                `Violation: ${params.violation}`
            ]
        })
    };
}

export function materializeFullSuiteRepairTask(
    params: MaterializeFullSuiteRepairTaskParams
): FullSuiteRepairTaskMaterializationResult {
    const repoRoot = path.resolve(params.repoRoot || '.');
    let transactionStarted = false;
    let artifactPath = resolveFullSuiteRepairTaskArtifactPath(
        joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews')),
        params.taskId
    );
    try {
        const reviewsRoot = params.reviewsRoot
            ? resolveInputPathInsideRepo(repoRoot, params.reviewsRoot, 'ReviewsRoot')
            : joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
        artifactPath = resolveFullSuiteRepairTaskArtifactPath(reviewsRoot, params.taskId);
        const lockRoot = joinOrchestratorPath(
            repoRoot,
            path.join('runtime', 'locks', 'full-suite-repair-task')
        );
        ensureContainedDirectoryPath(repoRoot, lockRoot, 'full-suite repair materialization lock root');
        const lockKey = createHash('sha256').update(String(params.taskId || '')).digest('hex').slice(0, 32);
        const lockPath = path.join(lockRoot, `${lockKey}.lock`);
        const containmentViolations = validatePhysicalRepoContainment(
            repoRoot,
            lockPath,
            'full-suite repair materialization lock path'
        );
        if (containmentViolations.length > 0) {
            throw new Error(containmentViolations.join(' '));
        }
        return withFilesystemLock(lockPath, {
            ownerLabel: `full-suite-repair-task-materialization:${String(params.taskId || '').trim() || 'unknown'}`,
            timeoutMs: 5000
        }, () => {
            transactionStarted = true;
            return materializeFullSuiteRepairTaskUnlocked(params);
        }).result;
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        const violation = transactionStarted
            ? `materialization execution failed unexpectedly: ${message}`
            : `materialization lock acquisition failed: ${message}`;
        return buildMaterializationLockBlockedResult({
            repoRoot,
            taskId: params.taskId,
            artifactPath,
            violation,
            action: transactionStarted
                ? 'Resolve the unexpected materialization failure before retrying.'
                : 'Resolve materialization lock failure before retrying.'
        });
    }
}
