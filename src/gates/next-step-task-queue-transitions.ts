import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    appendMandatoryTaskEvent
} from '../gate-runtime/task-events';
import {
    formatTaskQueueStatusCell,
    isTaskQueueDoneStatus,
    readTaskQueueStatusToken
} from '../core/active-task-state';
import {
    parseTaskMdTableRow,
    replaceTaskMdTableCell
} from '../core/task-md-table';
import {
    TASK_ID_ALLOWED_PATTERN
} from '../core/task-ids';
import {
    buildTaskQueueStatusContract,
    type TaskQueueStatusContract
} from '../core/task-queue-status-contract';
import {
    syncTaskQueueStatusDetailed,
    withTaskQueueStatusSyncLock,
    type TaskQueueStatusSyncResult
} from '../cli/commands/gate-flows/task-queue-sync';
import {
    normalizePath
} from './helpers';
import {
    SPLIT_REQUIRED_STATUS,
    extractExplicitLinkedChildTaskIds,
    parseTaskQueueEntriesFromContent,
    resolveDecomposedParentCompletionState
} from './next-step-task-queue';

export interface DecomposedParentBatchStatusSyncResult {
    outcome: TaskQueueStatusSyncResult['outcome'];
    task_path: string;
    root_task_id: string;
    task_ids: string[];
    updated_task_ids: string[];
    previous_statuses: Record<string, string | null>;
    next_status: 'DONE';
    error_message: string | null;
    status_contracts: Record<string, TaskQueueStatusContract>;
}

export interface SplitRequiredLatchTransitionEvidence {
    guard_kind: string | null;
    artifact_path: string;
    artifact_sha256: string | null;
}

const TASK_QUEUE_TASK_ID_PATTERN = TASK_ID_ALLOWED_PATTERN;

function fileExists(filePath: string): boolean {
    try {
        return fs.existsSync(filePath);
    } catch {
        return false;
    }
}

function getOrchestratorRootFromEventsRoot(eventsRoot: string): string {
    return path.resolve(eventsRoot, '..', '..');
}

export function transitionSplitRequiredParentToDecomposed(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusFromSplitRequiredToDecomposed(params.repoRoot, params.taskId);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || SPLIT_REQUIRED_STATUS} -> DECOMPOSED.`,
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'split_required_children_linked'
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_CLEARED',
            'INFO',
            'Split-required latch cleared because child tasks are linked.',
            {
                previous_status: syncResult.previous_status || SPLIT_REQUIRED_STATUS,
                new_status: 'DECOMPOSED',
                reason: 'child_tasks_linked'
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function transitionStrictDecompositionParentToDecomposed(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, 'DECOMPOSED');
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || 'UNKNOWN'} -> DECOMPOSED.`,
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: 'DECOMPOSED',
                reason: 'strict_decomposition_children_linked'
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STRICT_DECOMPOSITION_SPLIT_ROUTED',
            'INFO',
            'Strict split-required decision routed the parent through linked child tasks.',
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: 'DECOMPOSED',
                reason: 'child_tasks_linked'
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function restoreSplitRequiredParentFromPermanentLatch(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    latchEvidence: SplitRequiredLatchTransitionEvidence;
}): TaskQueueStatusSyncResult {
    const syncResult = syncTaskQueueStatusDetailed(params.repoRoot, params.taskId, SPLIT_REQUIRED_STATUS);
    if (syncResult.outcome === 'updated') {
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'STATUS_CHANGED',
            'INFO',
            `Task status changed: ${syncResult.previous_status || 'UNKNOWN'} -> ${SPLIT_REQUIRED_STATUS}.`,
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                reason: 'split_required_permanent_latch_restored',
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
        appendMandatoryTaskEvent(
            getOrchestratorRootFromEventsRoot(params.eventsRoot),
            params.taskId,
            'SPLIT_REQUIRED_RESTORED',
            'BLOCKED',
            'Permanent split-required latch restored the parent task status.',
            {
                previous_status: syncResult.previous_status || 'UNKNOWN',
                new_status: SPLIT_REQUIRED_STATUS,
                guard_kind: params.latchEvidence.guard_kind,
                artifact_path: params.latchEvidence.artifact_path,
                artifact_sha256: params.latchEvidence.artifact_sha256
            },
            { actor: 'orchestrator' }
        );
    }
    return syncResult;
}

export function transitionDecomposedParentsToDone(params: {
    repoRoot: string;
    eventsRoot: string;
    rootTaskId: string;
    taskIds: string[];
}): DecomposedParentBatchStatusSyncResult {
    const syncResult = syncDecomposedParentsToDone(params.repoRoot, params.rootTaskId, params.taskIds);
    if (syncResult.outcome === 'updated') {
        const statusEventCommittedTaskIds = new Set<string>();
        try {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            for (const taskId of syncResult.updated_task_ids) {
                const previousStatus = syncResult.previous_statuses[taskId] || 'DECOMPOSED';
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'STATUS_CHANGED',
                    'INFO',
                    `Task status changed: ${previousStatus} -> DONE.`,
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'decomposed_explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
                statusEventCommittedTaskIds.add(taskId);
                appendMandatoryTaskEvent(
                    orchestratorRoot,
                    taskId,
                    'DECOMPOSED_PARENT_COMPLETED',
                    'INFO',
                    'Decomposed parent completed because every explicit child task is DONE.',
                    {
                        previous_status: previousStatus,
                        new_status: 'DONE',
                        reason: 'explicit_children_done'
                    },
                    { actor: 'orchestrator' }
                );
            }
        } catch (error: unknown) {
            const orchestratorRoot = getOrchestratorRootFromEventsRoot(params.eventsRoot);
            const compensation = compensateDecomposedParentStatusEvents({
                orchestratorRoot,
                taskIds: syncResult.updated_task_ids,
                previousStatuses: syncResult.previous_statuses,
                committedTaskIds: statusEventCommittedTaskIds
            });
            const uncompensatedCommittedTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => statusEventCommittedTaskIds.has(taskId) && !compensation.compensatedTaskIds.has(taskId)
            );
            const rollbackTaskIds = syncResult.updated_task_ids.filter(
                (taskId) => !uncompensatedCommittedTaskIds.includes(taskId)
            );
            const rollbackError = rollbackDecomposedParentStatusSync(
                params.repoRoot,
                rollbackTaskIds,
                syncResult.previous_statuses
            );
            const remainingUpdatedTaskIds = rollbackError ? syncResult.updated_task_ids : uncompensatedCommittedTaskIds;
            const compensationMessage = compensation.errorMessages.length > 0
                ? ` Compensation event append failed: ${compensation.errorMessages.join('; ')}.`
                : (statusEventCommittedTaskIds.size > 0
                    ? ` Compensating STATUS_CHANGED event(s) recorded for: ${[...compensation.compensatedTaskIds].join(', ')}.`
                    : '');
            const rollbackMessage = rollbackError
                ? `Rollback failed for eligible TASK.md status changes: ${rollbackError}`
                : (rollbackTaskIds.length > 0
                    ? `Rolled back TASK.md status changes for: ${rollbackTaskIds.join(', ')}.`
                    : 'Skipped TASK.md rollback because every updated task already has an uncompensated committed status event.');
            const skippedRollbackMessage = uncompensatedCommittedTaskIds.length > 0
                ? ` Skipped rollback for task(s) with committed status events that could not be compensated: ${uncompensatedCommittedTaskIds.join(', ')}.`
                : '';
            return {
                ...syncResult,
                outcome: 'write_failed',
                updated_task_ids: remainingUpdatedTaskIds,
                error_message:
                    `Mandatory lifecycle event append failed after TASK.md status sync: ${error instanceof Error ? error.message : String(error)}. ` +
                    `${compensationMessage} ${rollbackMessage}${skippedRollbackMessage}`
            };
        }
    }
    return syncResult;
}

function compensateDecomposedParentStatusEvents(params: {
    orchestratorRoot: string;
    taskIds: string[];
    previousStatuses: Record<string, string | null>;
    committedTaskIds: Set<string>;
}): {
    compensatedTaskIds: Set<string>;
    errorMessages: string[];
} {
    const compensatedTaskIds = new Set<string>();
    const errorMessages: string[] = [];
    for (const taskId of params.taskIds) {
        if (!params.committedTaskIds.has(taskId)) {
            continue;
        }
        const previousStatus = params.previousStatuses[taskId] || 'DECOMPOSED';
        try {
            appendMandatoryTaskEvent(
                params.orchestratorRoot,
                taskId,
                'STATUS_CHANGED',
                'INFO',
                `Task status changed: DONE -> ${previousStatus} after failed decomposed parent completion audit.`,
                {
                    previous_status: 'DONE',
                    new_status: previousStatus,
                    reason: 'decomposed_parent_completion_event_failed_rollback'
                },
                { actor: 'orchestrator' }
            );
            compensatedTaskIds.add(taskId);
        } catch (error: unknown) {
            errorMessages.push(`${taskId}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { compensatedTaskIds, errorMessages };
}

function syncTaskQueueStatusFromSplitRequiredToDecomposed(repoRoot: string, taskId: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const statusContract = buildTaskQueueStatusContract(taskId);
    if (!fileExists(taskPath)) {
        return {
            outcome: 'task_file_missing',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: null,
            status_contract: statusContract
        };
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: 'DECOMPOSED',
            error_message: message,
            status_contract: statusContract
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            let previousStatus: string | null = null;
            let taskFound = false;
            let changed = false;

            for (let index = 0; index < lines.length; index += 1) {
                const rawLine = lines[index];
                if (!rawLine.trim().startsWith('|')) {
                    continue;
                }
                const cells = parseTaskMdTableRow(rawLine);
                if (cells.length < 4 || cells[0].trimmed !== taskId) {
                    continue;
                }
                taskFound = true;
                previousStatus = readTaskQueueStatusToken(cells[1].trimmed);
                if (previousStatus !== SPLIT_REQUIRED_STATUS) {
                    return {
                        outcome: 'write_failed',
                        task_path: normalizePath(taskPath),
                        task_id: taskId,
                        previous_status: previousStatus,
                        next_status: 'DECOMPOSED',
                        error_message: `Expected previous status ${SPLIT_REQUIRED_STATUS}; found ${previousStatus || 'unknown'}.`,
                        status_contract: statusContract
                    };
                }
                const updatedStatusCell = formatTaskQueueStatusCell(cells[1].raw, 'DECOMPOSED');
                if (updatedStatusCell !== cells[1].raw) {
                    const updatedLine = replaceTaskMdTableCell(rawLine, 1, updatedStatusCell);
                    if (!updatedLine) {
                        return {
                            outcome: 'write_failed',
                            task_path: normalizePath(taskPath),
                            task_id: taskId,
                            previous_status: previousStatus,
                            next_status: 'DECOMPOSED',
                            error_message: 'Failed to replace TASK.md status cell.',
                            status_contract: statusContract
                        };
                    }
                    lines[index] = updatedLine;
                    changed = true;
                }
                break;
            }

            if (!taskFound) {
                return {
                    outcome: 'task_not_found',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            if (!changed) {
                return {
                    outcome: 'already_synced',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            }

            try {
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
                return {
                    outcome: 'updated',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: null,
                    status_contract: statusContract
                };
            } catch (error: unknown) {
                return {
                    outcome: 'write_failed',
                    task_path: normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: 'DECOMPOSED',
                    error_message: error instanceof Error ? error.message : String(error),
                    status_contract: statusContract
                };
            }
        }
    );
}

function buildDecomposedParentBatchStatusSyncResult(params: {
    taskPath: string;
    rootTaskId: string;
    taskIds: string[];
    updatedTaskIds?: string[];
    previousStatuses?: Record<string, string | null>;
    outcome: TaskQueueStatusSyncResult['outcome'];
    errorMessage?: string | null;
}): DecomposedParentBatchStatusSyncResult {
    const taskIds = [...new Set(params.taskIds)];
    return {
        outcome: params.outcome,
        task_path: normalizePath(params.taskPath),
        root_task_id: params.rootTaskId,
        task_ids: taskIds,
        updated_task_ids: params.updatedTaskIds || [],
        previous_statuses: params.previousStatuses || {},
        next_status: 'DONE',
        error_message: params.errorMessage || null,
        status_contracts: Object.fromEntries(
            taskIds.map((taskId) => [taskId, buildTaskQueueStatusContract(taskId)])
        )
    };
}

function rollbackDecomposedParentStatusSync(
    repoRoot: string,
    taskIds: string[],
    previousStatuses: Record<string, string | null>
): string | null {
    if (taskIds.length === 0) {
        return null;
    }
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fileExists(taskPath)) {
        return 'TASK.md is missing.';
    }
    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => message,
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const pendingTaskIds = new Set(taskIds);
            for (let index = 0; index < lines.length && pendingTaskIds.size > 0; index += 1) {
                const rawLine = lines[index];
                if (!rawLine.trim().startsWith('|')) {
                    continue;
                }
                const cells = parseTaskMdTableRow(rawLine);
                const taskId = cells[0]?.trimmed;
                if (!taskId || !pendingTaskIds.has(taskId)) {
                    continue;
                }
                const previousStatus = previousStatuses[taskId];
                if (!previousStatus) {
                    return `Missing previous status for ${taskId}.`;
                }
                const updatedStatusCell = formatTaskQueueStatusCell(cells[1].raw, previousStatus);
                const updatedLine = replaceTaskMdTableCell(rawLine, 1, updatedStatusCell);
                if (!updatedLine) {
                    return `Failed to replace TASK.md status cell for ${taskId}.`;
                }
                lines[index] = updatedLine;
                pendingTaskIds.delete(taskId);
            }
            if (pendingTaskIds.size > 0) {
                return `Could not find TASK.md row(s): ${[...pendingTaskIds].join(', ')}.`;
            }
            try {
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
                return null;
            } catch (error: unknown) {
                return error instanceof Error ? error.message : String(error);
            }
        }
    );
}

function syncDecomposedParentsToDone(
    repoRoot: string,
    rootTaskId: string,
    requestedTaskIds: string[]
): DecomposedParentBatchStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const uniqueRequestedTaskIds = [...new Set(requestedTaskIds)];
    if (!fileExists(taskPath)) {
        return buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'task_file_missing',
            errorMessage: null
        });
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => buildDecomposedParentBatchStatusSyncResult({
            taskPath,
            rootTaskId,
            taskIds: uniqueRequestedTaskIds,
            outcome: 'write_failed',
            errorMessage: message
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            const taskEntries = parseTaskQueueEntriesFromContent(originalContent);
            const rootEntry = taskEntries.get(rootTaskId);
            if (!rootEntry) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: uniqueRequestedTaskIds,
                    outcome: 'task_not_found',
                    errorMessage: null
                });
            }

            const completionState = resolveDecomposedParentCompletionState(
                taskEntries,
                rootTaskId,
                new Set<string>(),
                extractExplicitLinkedChildTaskIds
            );
            const previousStatuses: Record<string, string | null> = {};
            const failClosed = (message: string): DecomposedParentBatchStatusSyncResult => (
                buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: uniqueRequestedTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: message
                })
            );

            if (!completionState.hasLinkedChildren) {
                return failClosed(`Root task ${rootTaskId} no longer has explicit child task links.`);
            }
            if (completionState.missingChildTaskIds.length > 0) {
                return failClosed(
                    `Explicit child task link(s) missing at write time: ${completionState.missingChildTaskIds.join(', ')}.`
                );
            }
            if (!completionState.complete) {
                const unfinished = completionState.unfinishedRoute
                    ? `${completionState.unfinishedRoute.taskId} (${completionState.unfinishedRoute.status || 'unknown'})`
                    : 'unknown child';
                return failClosed(`Explicit child completion invariant is no longer satisfied at write time: ${unfinished}.`);
            }

            const freshTaskIds = [...new Set([...completionState.completedDecomposedTaskIds, rootTaskId])];
            const freshTaskIdSet = new Set(freshTaskIds);
            for (const requestedTaskId of uniqueRequestedTaskIds) {
                const requestedEntry = taskEntries.get(requestedTaskId);
                previousStatuses[requestedTaskId] = requestedEntry
                    ? readTaskQueueStatusToken(requestedEntry.status || '')
                    : null;
                if (!freshTaskIdSet.has(requestedTaskId)) {
                    return failClosed(
                        `Completion graph changed at write time; requested parent ${requestedTaskId} is no longer in the completed explicit child graph.`
                    );
                }
            }

            const rowByTaskId = new Map<string, { index: number; rawLine: string; cells: ReturnType<typeof parseTaskMdTableRow> }>();
            for (let index = 0; index < lines.length; index += 1) {
                const rawLine = lines[index];
                if (!rawLine.trim().startsWith('|')) {
                    continue;
                }
                const cells = parseTaskMdTableRow(rawLine);
                const taskId = cells[0]?.trimmed;
                if (taskId && TASK_QUEUE_TASK_ID_PATTERN.test(taskId)) {
                    rowByTaskId.set(taskId, { index, rawLine, cells });
                }
            }

            const updatedTaskIds: string[] = [];
            for (const completedTaskId of freshTaskIds) {
                const completedEntry = taskEntries.get(completedTaskId);
                if (!completedEntry) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'task_not_found',
                        errorMessage: null
                    });
                }
                const previousStatus = readTaskQueueStatusToken(completedEntry.status || '');
                previousStatuses[completedTaskId] = previousStatus;
                if (isTaskQueueDoneStatus(completedEntry.status)) {
                    continue;
                }
                if (previousStatus !== 'DECOMPOSED') {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage: `Expected previous status DECOMPOSED for ${completedTaskId}; found ${previousStatus || 'unknown'}.`
                    });
                }
                const row = rowByTaskId.get(completedTaskId);
                if (!row) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'task_not_found',
                        errorMessage: null
                    });
                }
                const updatedStatusCell = formatTaskQueueStatusCell(row.cells[1].raw, 'DONE');
                if (updatedStatusCell === row.cells[1].raw) {
                    continue;
                }
                const updatedLine = replaceTaskMdTableCell(row.rawLine, 1, updatedStatusCell);
                if (!updatedLine) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage: `Failed to replace TASK.md status cell for ${completedTaskId}.`
                    });
                }
                lines[row.index] = updatedLine;
                updatedTaskIds.push(completedTaskId);
            }

            if (updatedTaskIds.length === 0) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'already_synced',
                    errorMessage: null
                });
            }

            try {
                const currentContent = fs.readFileSync(taskPath, 'utf8');
                if (currentContent !== originalContent) {
                    return buildDecomposedParentBatchStatusSyncResult({
                        taskPath,
                        rootTaskId,
                        taskIds: freshTaskIds,
                        previousStatuses,
                        outcome: 'write_failed',
                        errorMessage:
                            'TASK.md changed during decomposed parent status sync; rerun next-step so write-time revalidation can use the latest task queue snapshot.'
                    });
                }
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    updatedTaskIds,
                    previousStatuses,
                    outcome: 'updated',
                    errorMessage: null
                });
            } catch (error: unknown) {
                return buildDecomposedParentBatchStatusSyncResult({
                    taskPath,
                    rootTaskId,
                    taskIds: freshTaskIds,
                    previousStatuses,
                    outcome: 'write_failed',
                    errorMessage: error instanceof Error ? error.message : String(error)
                });
            }
        }
    );
}
