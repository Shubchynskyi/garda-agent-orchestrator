import * as fs from 'node:fs';
import * as path from 'node:path';

import { TASK_ID_ALLOWED_PATTERN } from './task-ids';
import { parseCanonicalActiveTaskQueue } from './task-md-table';

export interface TaskQueueEntry {
    taskId: string;
    status: string | null;
    area: string | null;
    title: string | null;
    profile: string | null;
    notes: string | null;
}

export interface ReadTaskQueueEntriesOptions {
    missingFile?: 'empty' | 'throw';
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function parseTaskQueueEntriesFromContent(content: string): Map<string, TaskQueueEntry> {
    const entries = new Map<string, TaskQueueEntry>();
    for (const row of parseCanonicalActiveTaskQueue(content).rows) {
        const rawTaskId = row.taskId;
        if (!TASK_ID_ALLOWED_PATTERN.test(rawTaskId)) {
            continue;
        }
        const taskId = rawTaskId;
        entries.set(taskId, {
            taskId,
            status: row.status || null,
            area: row.area || null,
            title: row.title || null,
            profile: row.profile || null,
            notes: row.notes || null
        });
    }
    return entries;
}

export function readTaskQueueEntries(
    repoRoot: string,
    options: ReadTaskQueueEntriesOptions = {}
): Map<string, TaskQueueEntry> {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (options.missingFile !== 'throw' && !fileExists(taskPath)) {
        return new Map<string, TaskQueueEntry>();
    }
    return parseTaskQueueEntriesFromContent(fs.readFileSync(taskPath, 'utf8'));
}
