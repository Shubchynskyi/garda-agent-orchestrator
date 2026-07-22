import { readTextFile } from '../core/filesystem';
import { parseCanonicalActiveTaskQueue } from '../core/task-md-table';
import { readTaskQueueStatusToken } from '../core/active-task-state';
import { isCanonicalTaskId } from '../core/task-ids';
import type { TaskQueueEntry } from '../core/task-queue-read';

export function buildTaskQueueStatusMap(
    taskEntries: ReadonlyMap<string, TaskQueueEntry>
): Map<string, string> {
    const statuses = new Map<string, string>();
    for (const [taskId, entry] of taskEntries) {
        const status = readTaskQueueStatusToken(entry.status || '');
        if (isCanonicalTaskId(taskId) && status) {
            statuses.set(taskId, status);
        }
    }
    return statuses;
}

export function readTaskQueueStatusMap(taskPath: string, taskPresent: boolean): Map<string, string> {
    const statuses = new Map<string, string>();
    if (!taskPresent) {
        return statuses;
    }

    try {
        for (const row of parseCanonicalActiveTaskQueue(readTextFile(taskPath)).rows) {
            const taskId = row.taskId;
            const status = readTaskQueueStatusToken(row.status);
            if (isCanonicalTaskId(taskId) && status) {
                statuses.set(taskId, status);
            }
        }
    } catch {
        return statuses;
    }

    return statuses;
}
