import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { parseCanonicalActiveTaskQueue, parseTaskMdTableRow } from '../../core/task-md-table';
import { toPosix } from '../../gates/shared/helpers';
import type { ReportDataUnavailableEntry, ReportTaskQueueRow } from './types';

const ACTIVE_QUEUE_HEADER = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'];

function isCanonicalSeparatorRow(line: string): boolean {
    const cells = parseTaskMdTableRow(line).map((cell) => cell.trimmed);
    return cells.length === ACTIVE_QUEUE_HEADER.length
        && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

export function readCanonicalActiveQueueRows(repoRoot: string): {
    source_path: string;
    rows: ReportTaskQueueRow[];
    unavailable: ReportDataUnavailableEntry[];
} {
    const taskPath = path.join(path.resolve(repoRoot), 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'TASK.md not found.' }]
        };
    }

    const content = fs.readFileSync(taskPath, 'utf8');
    const parsed = parseCanonicalActiveTaskQueue(content);
    if (!parsed.found) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: parsed.unavailableReason || 'Canonical Active Queue 9-column table header not found.' }]
        };
    }

    const rows: ReportTaskQueueRow[] = [];
    const unavailable: ReportDataUnavailableEntry[] = [];
    for (const row of parsed.rows) {
        const cells = row.cells.map((cell) => cell.trimmed);
        if (cells.length !== ACTIVE_QUEUE_HEADER.length) {
            unavailable.push({
                scope: 'tasks',
                reason: `Skipped noncanonical Active Queue row ${row.lineIndex + 1}: expected 9 cells, got ${cells.length}.`
            });
            continue;
        }
        if (cells[0].toLowerCase() === 'id' || isCanonicalSeparatorRow(row.rawLine)) {
            continue;
        }
        rows.push({
            task_id: row.taskId,
            status: row.status,
            status_token: readTaskQueueStatusToken(row.status),
            priority: row.priority,
            area: row.area,
            title: row.title,
            owner: row.owner,
            updated: row.updated,
            profile: row.profile,
            notes: row.notes
        });
    }

    return {
        source_path: toPosix(taskPath),
        rows,
        unavailable
    };
}
