import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    resolveBundleName
} from '../../../core/constants';
import {
    emitMandatoryCompletionGateEventAsync,
    emitMandatoryStatusChangedEventAsync
} from '../../../gate-runtime/lifecycle-events';
import { collectOrderedTimelineEvents } from '../../../gates/completion-evidence';
import {
    isOrchestratorSourceCheckout,
    joinOrchestratorPath
} from '../../../gates/helpers';
import { withFilesystemLock } from '../../../gate-runtime/task-events-locking';
import { reconcileTimelineSummaryForTask } from '../../../gate-runtime/timeline-summary';
import {
    readTaskQueueStatus,
    syncTaskQueueStatusDetailed,
    type TaskQueueStatusSyncResult
} from './task-queue-sync';
import type { TimelineEventEntry } from '../../../gates/completion-evidence';

interface CompletionEventDetails {
    status: unknown;
    outcome: unknown;
    preflight_path: unknown;
    timeline_path: unknown;
    violations: unknown;
}

interface TimelineStatusTransition {
    previous_status: string | null;
    new_status: string | null;
    sequence: number;
}

interface AggregateRollbackOptions {
    taskId: string;
    aggregateSnapshot: FileSnapshot;
}

interface TaskEventRollbackOptions {
    taskEventsRoot: string;
    taskId: string;
    timelineSnapshot: FileSnapshot;
    aggregateSnapshot: FileSnapshot;
    expectedRollbackEventSequences: RollbackEventSignature[][];
}

interface TaskEventRollbackResult {
    errors: string[];
    timeline_restored: boolean;
    aggregate_reconciled: boolean;
    summary_reconciled: boolean;
}

interface FileSnapshot {
    path: string;
    existed: boolean;
    content: string | null;
}

interface RollbackEventSignature {
    event_type: string;
    detail_subset: Record<string, string>;
}

export interface CompletionFinalizationResult {
    completion_event_recorded: boolean;
    status_event_recorded: boolean;
    queue_status_before: string | null;
    queue_status_after: string | null;
    latest_timeline_status: string | null;
    task_queue_sync: TaskQueueStatusSyncResult;
}

export interface ReconcileSuccessfulCompletionFinalizationOptions {
    repoRoot: string;
    taskId: string;
    preflightPath: string;
    completionEventDetails: CompletionEventDetails;
    previousStatusHint?: string;
}

function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

function buildCompletionGateRerunCommand(repoRoot: string, taskId: string, preflightPath: string): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    return [
        `${cliPrefix} gate completion-gate`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ].join(' ');
}

function getLatestSequence(events: TimelineEventEntry[], predicate: (event: TimelineEventEntry) => boolean): number | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (!predicate(event)) {
            continue;
        }
        const sequence = Number(event.sequence);
        if (Number.isFinite(sequence)) {
            return sequence;
        }
        return index;
    }
    return null;
}

function getCurrentCycleBoundarySequence(events: TimelineEventEntry[]): number | null {
    return getLatestSequence(events, (event) => {
        const eventType = String(event.event_type || '').trim();
        return (
            eventType === 'DOC_IMPACT_ASSESSED'
            || eventType === 'REVIEW_GATE_PASSED'
            || eventType === 'REVIEW_GATE_PASSED_WITH_OVERRIDE'
        );
    });
}

function getLatestStatusTransition(events: TimelineEventEntry[]): TimelineStatusTransition | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'STATUS_CHANGED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : {};
        const sequence = Number(event.sequence);
        return {
            previous_status: typeof details.previous_status === 'string' ? details.previous_status.trim().toUpperCase() : null,
            new_status: typeof details.new_status === 'string' ? details.new_status.trim().toUpperCase() : null,
            sequence: Number.isFinite(sequence) ? sequence : index
        };
    }
    return null;
}

function getLatestStatusTransitionAfterSequence(
    events: TimelineEventEntry[],
    afterSequence: number | null
): TimelineStatusTransition | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'STATUS_CHANGED') {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : {};
        const rawSequence = Number(event.sequence);
        const effectiveSequence = Number.isFinite(rawSequence) ? rawSequence : index;
        if (afterSequence != null && effectiveSequence <= afterSequence) {
            continue;
        }
        return {
            previous_status: typeof details.previous_status === 'string' ? details.previous_status.trim().toUpperCase() : null,
            new_status: typeof details.new_status === 'string' ? details.new_status.trim().toUpperCase() : null,
            sequence: effectiveSequence
        };
    }
    return null;
}

function getLatestCurrentCycleStatusTransition(events: TimelineEventEntry[]): TimelineStatusTransition | null {
    return getLatestStatusTransitionAfterSequence(events, getCurrentCycleBoundarySequence(events));
}

function hasCurrentCycleCompletionPass(events: TimelineEventEntry[]): boolean {
    const boundarySequence = getCurrentCycleBoundarySequence(events);
    const latestCompletionPassSequence = getLatestSequence(events, (event) => (
        String(event.event_type || '').trim() === 'COMPLETION_GATE_PASSED'
    ));
    if (latestCompletionPassSequence == null) {
        return false;
    }
    if (boundarySequence == null) {
        return true;
    }
    return latestCompletionPassSequence > boundarySequence;
}

function hasCurrentCycleDoneStatus(events: TimelineEventEntry[]): boolean {
    return getLatestCurrentCycleStatusTransition(events)?.new_status === 'DONE';
}

function isSuccessfulTaskQueueSync(syncResult: TaskQueueStatusSyncResult): boolean {
    return syncResult.outcome === 'updated' || syncResult.outcome === 'already_synced';
}

function resolveDoneTransitionPreviousStatus(
    queueStatusBefore: string | null,
    latestStatus: string | null,
    previousStatusHint?: string
): string {
    if (queueStatusBefore && queueStatusBefore !== 'DONE') {
        return queueStatusBefore;
    }
    if (latestStatus && latestStatus !== 'DONE') {
        return latestStatus;
    }
    const normalizedHint = String(previousStatusHint || 'IN_REVIEW').trim().toUpperCase();
    return normalizedHint || 'IN_REVIEW';
}

function captureFileSnapshot(filePath: string): FileSnapshot {
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
        return {
            path: filePath,
            existed: false,
            content: null
        };
    }
    return {
        path: filePath,
        existed: true,
        content: fs.readFileSync(filePath, 'utf8')
    };
}

function restoreFileSnapshot(snapshot: FileSnapshot): void {
    if (fs.existsSync(snapshot.path)) {
        const stat = fs.statSync(snapshot.path);
        if (!stat.isFile()) {
            fs.rmSync(snapshot.path, { recursive: true, force: true });
        }
    }
    if (!snapshot.existed) {
        if (fs.existsSync(snapshot.path)) {
            fs.rmSync(snapshot.path, { recursive: true, force: true });
        }
        return;
    }
    fs.mkdirSync(path.dirname(snapshot.path), { recursive: true });
    fs.writeFileSync(snapshot.path, snapshot.content || '', 'utf8');
}

function restoreSnapshots(snapshots: readonly FileSnapshot[]): string[] {
    const rollbackErrors: string[] = [];
    for (const snapshot of snapshots) {
        try {
            restoreFileSnapshot(snapshot);
        } catch (rollbackError: unknown) {
            rollbackErrors.push(
                `${path.basename(snapshot.path)} restore failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
            );
        }
    }
    return rollbackErrors;
}

function rawLineLooksLikeTaskId(rawLine: string, taskId: string): boolean {
    const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`"task_id"\\s*:\\s*"${escapedTaskId}"`).test(rawLine);
}

function readCurrentSnapshotContent(snapshot: FileSnapshot): string {
    if (!fs.existsSync(snapshot.path)) {
        if (!snapshot.existed) {
            return '';
        }
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot: expected file is missing`
        );
    }
    const stat = fs.statSync(snapshot.path);
    if (!stat.isFile()) {
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot: expected file but found non-file`
        );
    }
    return fs.readFileSync(snapshot.path, 'utf8');
}

function getAppendedRawLinesSinceSnapshot(snapshot: FileSnapshot): string[] {
    const baselineContent = snapshot.existed ? (snapshot.content || '') : '';
    const currentContent = readCurrentSnapshotContent(snapshot);
    if (!currentContent.startsWith(baselineContent)) {
        throw new Error(
            `rollback target '${path.basename(snapshot.path)}' no longer matches the captured snapshot prefix`
        );
    }
    return currentContent
        .slice(baselineContent.length)
        .split('\n')
        .filter((line) => line.trim().length > 0);
}

function buildSnapshotRestoredContent(snapshot: FileSnapshot, appendedLines: readonly string[]): string {
    const baselineContent = snapshot.existed ? (snapshot.content || '') : '';
    if (appendedLines.length === 0) {
        return baselineContent;
    }
    const separator = baselineContent.length > 0 && !baselineContent.endsWith('\n')
        ? '\n'
        : '';
    return `${baselineContent}${separator}${appendedLines.join('\n')}\n`;
}

function shouldKeepAppendedAggregateLogLine(rawLine: string, taskId: string): boolean {
    try {
        const parsed = JSON.parse(rawLine) as Record<string, unknown>;
        return String(parsed.task_id || '').trim() !== taskId;
    } catch {
        return !rawLineLooksLikeTaskId(rawLine, taskId);
    }
}

function rollbackAggregateTaskEntriesUnsafe(options: AggregateRollbackOptions): void {
    const aggregatePath = options.aggregateSnapshot.path;
    const appendedTailLines = getAppendedRawLinesSinceSnapshot(options.aggregateSnapshot)
        .filter((line) => shouldKeepAppendedAggregateLogLine(line, options.taskId));
    const restoredContent = buildSnapshotRestoredContent(options.aggregateSnapshot, appendedTailLines);
    if (!options.aggregateSnapshot.existed && restoredContent.length === 0) {
        if (fs.existsSync(aggregatePath)) {
            fs.rmSync(aggregatePath, { force: true });
        }
        return;
    }
    const randomSuffix = Math.random().toString(16).slice(2, 10);
    const tmpPath = `${aggregatePath}.${process.pid}.${randomSuffix}.tmp`;
    try {
        fs.writeFileSync(tmpPath, restoredContent, 'utf8');
        fs.renameSync(tmpPath, aggregatePath);
    } finally {
        try {
            fs.unlinkSync(tmpPath);
        } catch {
            // Already renamed or missing.
        }
    }
}

function normalizeRollbackDetailValue(value: unknown): string {
    if (value == null) {
        return '';
    }
    return String(value).trim();
}

function buildRollbackEventSignature(
    eventType: string,
    detailSubset: Record<string, unknown> = {}
): RollbackEventSignature {
    const normalizedDetailSubset: Record<string, string> = {};
    for (const [key, value] of Object.entries(detailSubset)) {
        normalizedDetailSubset[key] = normalizeRollbackDetailValue(value);
    }
    return {
        event_type: String(eventType || '').trim().toUpperCase(),
        detail_subset: normalizedDetailSubset
    };
}

function getRollbackEventSignatures(rawLines: readonly string[]): RollbackEventSignature[] {
    const eventSignatures: RollbackEventSignature[] = [];
    for (const rawLine of rawLines) {
        try {
            const parsed = JSON.parse(rawLine) as Record<string, unknown>;
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : {};
            const normalizedDetails: Record<string, unknown> = {};
            for (const [key, value] of Object.entries(details)) {
                normalizedDetails[key] = value;
            }
            eventSignatures.push(buildRollbackEventSignature(
                String(parsed.event_type || ''),
                normalizedDetails
            ));
        } catch {
            eventSignatures.push(buildRollbackEventSignature('<UNPARSEABLE>'));
        }
    }
    return eventSignatures;
}

function resolveAllowedRollbackEventSequences(
    pendingFinalizationStep: 'STATUS_CHANGED' | 'COMPLETION_GATE_PASSED' | null,
    statusDoneRecorded: boolean,
    completionPassRecorded: boolean,
    previousStatusForDoneTransition: string,
    completionEventDetails: CompletionEventDetails
): RollbackEventSignature[][] {
    const statusChangedSignature = buildRollbackEventSignature('STATUS_CHANGED', {
        previous_status: previousStatusForDoneTransition,
        new_status: 'DONE'
    });
    const completionPassedSignature = buildRollbackEventSignature('COMPLETION_GATE_PASSED', {
        status: completionEventDetails.status,
        outcome: completionEventDetails.outcome,
        preflight_path: completionEventDetails.preflight_path,
        timeline_path: completionEventDetails.timeline_path
    });
    if (pendingFinalizationStep === 'STATUS_CHANGED') {
        return statusDoneRecorded ? [[]] : [[], [statusChangedSignature]];
    }
    if (pendingFinalizationStep === 'COMPLETION_GATE_PASSED') {
        if (completionPassRecorded) {
            return [[]];
        }
        return statusDoneRecorded
            ? [[], [completionPassedSignature]]
            : [[statusChangedSignature], [statusChangedSignature, completionPassedSignature]];
    }
    return [[]];
}

function formatRollbackEventSignature(signature: RollbackEventSignature): string {
    const detailEntries = Object.entries(signature.detail_subset);
    if (detailEntries.length === 0) {
        return signature.event_type || '<UNKNOWN>';
    }
    return `${signature.event_type}(${detailEntries.map(([key, value]) => `${key}=${value}`).join(', ')})`;
}

function formatAllowedRollbackEventSequences(sequences: readonly RollbackEventSignature[][]): string {
    return sequences
        .map((sequence) => sequence.length === 0 ? '<none>' : sequence.map((signature) => formatRollbackEventSignature(signature)).join(' -> '))
        .join(' | ');
}

function rollbackEventSignatureMatches(actual: RollbackEventSignature, expected: RollbackEventSignature): boolean {
    if (actual.event_type !== expected.event_type) {
        return false;
    }
    return Object.entries(expected.detail_subset).every(([key, value]) => (
        normalizeRollbackDetailValue(actual.detail_subset[key]) === value
    ));
}

function assertNoUnexpectedSameTaskAppend(options: TaskEventRollbackOptions): void {
    const appendedEventSignatures = getRollbackEventSignatures(getAppendedRawLinesSinceSnapshot(options.timelineSnapshot));
    const allowedSequences = options.expectedRollbackEventSequences;
    const rollbackTailIsAllowed = allowedSequences.some((sequence) => (
        sequence.length === appendedEventSignatures.length
        && sequence.every((signature, index) => rollbackEventSignatureMatches(appendedEventSignatures[index], signature))
    ));
    if (!rollbackTailIsAllowed) {
        throw new Error(
            `same-task concurrent append detected before rollback: appended_events=${appendedEventSignatures.map((signature) => formatRollbackEventSignature(signature)).join(' -> ') || '<none>'}; `
            + `allowed_sequences=${formatAllowedRollbackEventSequences(allowedSequences)}`
        );
    }
}

function rollbackTaskEventArtifacts(options: TaskEventRollbackOptions): TaskEventRollbackResult {
    const rollbackResult: TaskEventRollbackResult = {
        errors: [],
        timeline_restored: false,
        aggregate_reconciled: false,
        summary_reconciled: false
    };
    const taskLockPath = path.join(options.taskEventsRoot, `.${options.taskId}.lock`);
    const aggregateLockPath = path.join(options.taskEventsRoot, '.all-tasks.lock');
    try {
        withFilesystemLock(taskLockPath, {}, () => {
            assertNoUnexpectedSameTaskAppend(options);
            restoreFileSnapshot(options.timelineSnapshot);
            rollbackResult.timeline_restored = true;
            withFilesystemLock(aggregateLockPath, {}, () => {
                rollbackAggregateTaskEntriesUnsafe({
                    taskId: options.taskId,
                    aggregateSnapshot: options.aggregateSnapshot
                });
            });
            rollbackResult.aggregate_reconciled = true;
            reconcileTimelineSummaryForTask(options.taskEventsRoot, options.taskId);
            rollbackResult.summary_reconciled = true;
        });
    } catch (rollbackError: unknown) {
        rollbackResult.errors.push(
            `task-event rollback failed: ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`
        );
    }
    return rollbackResult;
}

function buildFinalizationRepairMessage(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    reason: string,
    queueStatus: string | null,
    latestTimelineStatus: string | null,
    completionPassRecorded: boolean,
    statusDoneRecorded: boolean,
    syncResult: TaskQueueStatusSyncResult | null
): string {
    const stateParts = [
        `task_queue_status=${queueStatus || 'missing'}`,
        `latest_timeline_status=${latestTimelineStatus || 'missing'}`,
        `completion_pass_recorded=${completionPassRecorded ? 'yes' : 'no'}`,
        `status_done_recorded=${statusDoneRecorded ? 'yes' : 'no'}`
    ];
    if (syncResult) {
        stateParts.push(`task_queue_sync=${syncResult.outcome}`);
        if (syncResult.error_message) {
            stateParts.push(`task_queue_sync_error=${syncResult.error_message}`);
        }
    }
    return [
        `completion-gate finalization for '${taskId}' is incomplete: ${reason}`,
        `Observed state: ${stateParts.join(', ')}.`,
        `Fix the underlying issue, then rerun: ${buildCompletionGateRerunCommand(repoRoot, taskId, preflightPath)}`
    ].join(' ');
}

export async function reconcileSuccessfulCompletionFinalizationAsync(
    options: ReconcileSuccessfulCompletionFinalizationOptions
): Promise<CompletionFinalizationResult> {
    const repoRoot = path.resolve(options.repoRoot);
    const taskId = String(options.taskId || '').trim();
    const orchestratorRoot = joinOrchestratorPath(repoRoot, '');
    const taskPath = path.join(repoRoot, 'TASK.md');
    const taskEventsRoot = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events'));
    const timelinePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const aggregatePath = joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', 'all-tasks.jsonl'));
    const snapshots = [
        captureFileSnapshot(taskPath),
        captureFileSnapshot(timelinePath),
        captureFileSnapshot(aggregatePath)
    ] as const;
    const orderedEvents = collectOrderedTimelineEvents(timelinePath, []);
    const queueStatusBefore = readTaskQueueStatus(repoRoot, taskId);
    const latestStatusTransition = getLatestStatusTransition(orderedEvents);
    const latestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(orderedEvents);
    const completionPassRecorded = hasCurrentCycleCompletionPass(orderedEvents);
    const statusDoneRecorded = hasCurrentCycleDoneStatus(orderedEvents);
    const previousStatusForDoneTransition = resolveDoneTransitionPreviousStatus(
        queueStatusBefore,
        latestCurrentCycleStatusTransition?.new_status || latestStatusTransition?.new_status || null,
        options.previousStatusHint
    );

    const syncResult = syncTaskQueueStatusDetailed(repoRoot, taskId, 'DONE');
    if (!isSuccessfulTaskQueueSync(syncResult)) {
        const rollbackErrors = syncResult.outcome === 'write_failed'
            ? restoreSnapshots([snapshots[0]])
            : [];
        const restoredEvents = collectOrderedTimelineEvents(timelinePath, []);
        const restoredLatestStatusTransition = getLatestStatusTransition(restoredEvents);
        const restoredLatestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(restoredEvents);
        const restoredQueueStatus = readTaskQueueStatus(repoRoot, taskId);
        const restoredCompletionPassRecorded = hasCurrentCycleCompletionPass(restoredEvents);
        const restoredStatusDoneRecorded = hasCurrentCycleDoneStatus(restoredEvents);
        const effectiveSyncResult: TaskQueueStatusSyncResult = rollbackErrors.length === 0
            ? syncResult
            : {
                ...syncResult,
                error_message: rollbackErrors.join(' | ')
            };
        throw new Error(
            buildFinalizationRepairMessage(
                repoRoot,
                taskId,
                options.preflightPath,
                `TASK.md queue state could not be reconciled to DONE.${rollbackErrors.length > 0 ? ` Rollback failed: ${rollbackErrors.join(' ')}` : ''}`,
                restoredQueueStatus,
                restoredLatestCurrentCycleStatusTransition?.new_status || restoredLatestStatusTransition?.new_status || null,
                restoredCompletionPassRecorded,
                restoredStatusDoneRecorded,
                effectiveSyncResult
            )
        );
    }

    let statusEventRecorded = false;
    let completionEventRecorded = false;
    let pendingFinalizationStep: 'STATUS_CHANGED' | 'COMPLETION_GATE_PASSED' | null = null;

    try {
        if (!statusDoneRecorded) {
            pendingFinalizationStep = 'STATUS_CHANGED';
            await emitMandatoryStatusChangedEventAsync(orchestratorRoot, taskId, previousStatusForDoneTransition, 'DONE');
            statusEventRecorded = true;
        }
        if (!completionPassRecorded) {
            pendingFinalizationStep = 'COMPLETION_GATE_PASSED';
            await emitMandatoryCompletionGateEventAsync(orchestratorRoot, taskId, true, options.completionEventDetails);
            completionEventRecorded = true;
        }
        pendingFinalizationStep = null;
    } catch (error: unknown) {
        const taskEventRollbackResult = rollbackTaskEventArtifacts({
            taskEventsRoot,
            taskId,
            timelineSnapshot: snapshots[1],
            aggregateSnapshot: snapshots[2],
            expectedRollbackEventSequences: resolveAllowedRollbackEventSequences(
                pendingFinalizationStep,
                statusDoneRecorded,
                completionPassRecorded,
                previousStatusForDoneTransition,
                options.completionEventDetails
            )
        });
        const queueRollbackErrors = taskEventRollbackResult.timeline_restored
            ? restoreSnapshots([snapshots[0]])
            : [];
        const rollbackErrors = [
            ...taskEventRollbackResult.errors,
            ...queueRollbackErrors
        ];

        const restoredEvents = collectOrderedTimelineEvents(timelinePath, []);
        const restoredLatestStatusTransition = getLatestStatusTransition(restoredEvents);
        const restoredLatestCurrentCycleStatusTransition = getLatestCurrentCycleStatusTransition(restoredEvents);
        const restoredQueueStatus = readTaskQueueStatus(repoRoot, taskId);
        const restoredCompletionPassRecorded = hasCurrentCycleCompletionPass(restoredEvents);
        const restoredStatusDoneRecorded = hasCurrentCycleDoneStatus(restoredEvents);
        const effectiveSyncResult: TaskQueueStatusSyncResult = rollbackErrors.length === 0
            ? syncResult
            : {
                ...syncResult,
                error_message: rollbackErrors.join(' | ')
            };

        throw new Error(
            buildFinalizationRepairMessage(
                repoRoot,
                taskId,
                options.preflightPath,
                `${pendingFinalizationStep === 'COMPLETION_GATE_PASSED'
                    ? `mandatory COMPLETION_GATE_PASSED append failed. ${error instanceof Error ? error.message : String(error)}`
                    : `mandatory STATUS_CHANGED append failed. ${error instanceof Error ? error.message : String(error)}`}${rollbackErrors.length > 0 ? ` Rollback failed: ${rollbackErrors.join(' ')}` : ''}`,
                restoredQueueStatus,
                restoredLatestCurrentCycleStatusTransition?.new_status || restoredLatestStatusTransition?.new_status || null,
                restoredCompletionPassRecorded,
                restoredStatusDoneRecorded,
                effectiveSyncResult
            )
        );
    }

    return {
        completion_event_recorded: completionEventRecorded,
        status_event_recorded: statusEventRecorded,
        queue_status_before: queueStatusBefore,
        queue_status_after: readTaskQueueStatus(repoRoot, taskId),
        latest_timeline_status: statusDoneRecorded || statusEventRecorded ? 'DONE' : (latestCurrentCycleStatusTransition?.new_status || latestStatusTransition?.new_status || null),
        task_queue_sync: syncResult
    };
}
