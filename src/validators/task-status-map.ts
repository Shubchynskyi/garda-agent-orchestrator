import { readTextFile } from '../core/filesystem';
import { parseTaskMdTableRow } from '../core/task-md-table';
import { readTaskQueueStatusToken } from '../core/active-task-state';
import { isCanonicalTaskId } from '../core/task-ids';

export function readTaskQueueStatusMap(taskPath: string, taskPresent: boolean): Map<string, string> {
    const statuses = new Map<string, string>();
    if (!taskPresent) {
        return statuses;
    }

    try {
        for (const line of readTextFile(taskPath).split(/\r?\n/)) {
            const cells = parseTaskMdTableRow(line);
            if (cells.length < 2) {
                continue;
            }
            const taskId = cells[0].trimmed;
            const status = readTaskQueueStatusToken(cells[1].trimmed);
            if (isCanonicalTaskId(taskId) && status) {
                statuses.set(taskId, status);
            }
        }
    } catch {
        return statuses;
    }

    return statuses;
}
