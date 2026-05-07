import * as fs from 'node:fs';
import * as path from 'node:path';
import { formatTaskQueueStatusCell, normalizeTaskQueueStatusCell, readTaskQueueStatusToken } from '../../../core/active-task-state';
import { buildTaskQueueStatusContract, type TaskQueueStatusContract } from '../../../core/task-queue-status-contract';
import { parseTaskMdTableRow, replaceTaskMdTableCell } from '../../../core/task-md-table';
import * as gateHelpers from '../../../gates/helpers';

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function readTaskQueueStatus(repoRoot: string, taskId: string): string | null {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return null;
    }

    const lines = fs.readFileSync(taskPath, 'utf8').split('\n');
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = parseTaskMdTableRow(rawLine);
        if (cells.length < 2 || cells[0].trimmed !== taskId) {
            continue;
        }
        return readTaskQueueStatusToken(cells[1].trimmed);
    }

    return null;
}

export function syncTaskQueueStatus(repoRoot: string, taskId: string, nextStatus: string): boolean {
    const result = syncTaskQueueStatusDetailed(repoRoot, taskId, nextStatus);
    return result.outcome === 'updated';
}

export interface TaskQueueStatusSyncResult {
    outcome: 'updated' | 'already_synced' | 'task_file_missing' | 'task_not_found' | 'write_failed';
    task_path: string;
    task_id: string;
    previous_status: string | null;
    next_status: string;
    error_message: string | null;
    status_contract: TaskQueueStatusContract;
}

export function withTaskQueueStatusSyncLock<T>(
    taskPath: string,
    onLockFailure: (message: string) => T,
    operation: () => T
): T {
    const lockPath = `${taskPath}.garda-status-sync.lock`;
    let lockFd: number | null = null;
    try {
        lockFd = fs.openSync(lockPath, 'wx');
    } catch (error: unknown) {
        return onLockFailure(`Could not acquire TASK.md status-sync lock: ${getErrorMessage(error)}`);
    }

    try {
        return operation();
    } finally {
        if (lockFd !== null) {
            fs.closeSync(lockFd);
        }
        try {
            fs.unlinkSync(lockPath);
        } catch {
            // Best-effort cleanup only; a failed unlink keeps later sync attempts fail-closed.
        }
    }
}

export function syncTaskQueueStatusDetailed(repoRoot: string, taskId: string, nextStatus: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    const statusContract = buildTaskQueueStatusContract(taskId);
    const normalizedNextStatus = normalizeTaskQueueStatusCell(nextStatus);
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: normalizedNextStatus,
            error_message: null,
            status_contract: statusContract
        };
    }

    return withTaskQueueStatusSyncLock(
        taskPath,
        (message) => ({
            outcome: 'write_failed',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: normalizedNextStatus,
            error_message: message,
            status_contract: statusContract
        }),
        () => {
            const originalContent = fs.readFileSync(taskPath, 'utf8');
            const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
            const lines = originalContent.split(/\r?\n/);
            let changed = false;
            let taskFound = false;
            let previousStatus: string | null = null;

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
                const updatedStatusCell = formatTaskQueueStatusCell(cells[1].raw, normalizedNextStatus);
                if (updatedStatusCell !== cells[1].raw) {
                    const updatedLine = replaceTaskMdTableCell(rawLine, 1, updatedStatusCell);
                    if (!updatedLine) {
                        continue;
                    }
                    lines[index] = updatedLine;
                    changed = true;
                }
                break;
            }

            if (!taskFound) {
                return {
                    outcome: 'task_not_found',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: null,
                    next_status: normalizedNextStatus,
                    error_message: null,
                    status_contract: statusContract
                };
            }

            if (!changed) {
                return {
                    outcome: 'already_synced',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: normalizedNextStatus,
                    error_message: null,
                    status_contract: statusContract
                };
            }

            try {
                fs.writeFileSync(taskPath, lines.join(newline), 'utf8');
            } catch (error: unknown) {
                return {
                    outcome: 'write_failed',
                    task_path: gateHelpers.normalizePath(taskPath),
                    task_id: taskId,
                    previous_status: previousStatus,
                    next_status: normalizedNextStatus,
                    error_message: getErrorMessage(error),
                    status_contract: statusContract
                };
            }

            return {
                outcome: 'updated',
                task_path: gateHelpers.normalizePath(taskPath),
                task_id: taskId,
                previous_status: previousStatus,
                next_status: normalizedNextStatus,
                error_message: null,
                status_contract: statusContract
            };
        }
    );
}
