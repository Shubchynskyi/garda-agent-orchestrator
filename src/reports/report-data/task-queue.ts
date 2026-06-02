import * as fs from 'node:fs';
import * as path from 'node:path';
import { readTaskQueueStatusToken } from '../../core/active-task-state';
import { parseTaskMdTableRow } from '../../core/task-md-table';
import { toPosix } from '../../gates/shared/helpers';
import type { ReportDataUnavailableEntry, ReportTaskQueueRow } from './types';

const ACTIVE_QUEUE_HEADER = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'];

function normalizeHeaderCells(cells: string[]): string[] {
    return cells.map((cell) => cell.trim());
}

function isSeparatorRow(line: string): boolean {
    const cells = parseTaskMdTableRow(line.trim()).map((cell) => cell.trimmed);
    return cells.length === ACTIVE_QUEUE_HEADER.length
        && cells.every((cell) => /^:?-{3,}:?$/.test(cell));
}

function isActiveQueueHeader(line: string): boolean {
    const cells = normalizeHeaderCells(parseTaskMdTableRow(line.trim()).map((cell) => cell.trimmed));
    return cells.length === ACTIVE_QUEUE_HEADER.length
        && cells.every((cell, index) => cell === ACTIVE_QUEUE_HEADER[index]);
}

export function readCanonicalActiveQueueRows(repoRoot: string): {
    source_path: string;
    rows: ReportTaskQueueRow[];
    unavailable: ReportDataUnavailableEntry[];
} {
    const taskPath = path.join(path.resolve(repoRoot), 'TASK.md');
    const unavailable: ReportDataUnavailableEntry[] = [];
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'TASK.md not found.' }]
        };
    }

    const lines = fs.readFileSync(taskPath, 'utf8').split(/\r?\n/);
    const activeQueueIndex = lines.findIndex((line) => line.trim() === '## Active Queue');
    if (activeQueueIndex < 0) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'Canonical ## Active Queue section not found.' }]
        };
    }

    const headerIndex = activeQueueIndex + 1;
    const separatorIndex = activeQueueIndex + 2;
    if (!isActiveQueueHeader(lines[headerIndex] || '') || !isSeparatorRow(lines[separatorIndex] || '')) {
        return {
            source_path: toPosix(taskPath),
            rows: [],
            unavailable: [{ scope: 'tasks', reason: 'Canonical Active Queue 9-column table header not found.' }]
        };
    }

    const rows: ReportTaskQueueRow[] = [];
    for (let index = separatorIndex + 1; index < lines.length; index += 1) {
        const rawLine = lines[index];
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            break;
        }
        const cells = parseTaskMdTableRow(trimmed).map((cell) => cell.trimmed);
        if (cells.length !== ACTIVE_QUEUE_HEADER.length) {
            unavailable.push({
                scope: 'tasks',
                reason: `Skipped noncanonical Active Queue row ${index + 1}: expected 9 cells, got ${cells.length}.`
            });
            continue;
        }
        if (cells[0].toLowerCase() === 'id' || cells[0].startsWith('-')) {
            continue;
        }
        rows.push({
            task_id: cells[0],
            status: cells[1],
            status_token: readTaskQueueStatusToken(cells[1]),
            priority: cells[2],
            area: cells[3],
            title: cells[4],
            owner: cells[5],
            updated: cells[6],
            profile: cells[7],
            notes: cells[8]
        });
    }

    return {
        source_path: toPosix(taskPath),
        rows,
        unavailable
    };
}
