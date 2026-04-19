import * as fs from 'node:fs';
import * as path from 'node:path';
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

    const statusPattern = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i;
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
        const statusMatch = statusPattern.exec(cells[1].trimmed);
        return statusMatch ? statusMatch[1].toUpperCase() : null;
    }

    return null;
}

const TASK_QUEUE_STATUS_MARKERS: Record<string, string> = Object.freeze({
    TODO: '🟦',
    IN_PROGRESS: '🟨',
    IN_REVIEW: '🟧',
    DONE: '🟩',
    BLOCKED: '🟥'
});

function formatTaskQueueStatusCell(existingCell: string, nextStatus: string): string {
    const normalizedStatus = String(nextStatus || '').trim().toUpperCase();
    const leadingWhitespace = existingCell.match(/^\s*/)?.[0] ?? ' ';
    const trailingWhitespace = existingCell.match(/\s*$/)?.[0] ?? ' ';
    const hasMarker = Object.values(TASK_QUEUE_STATUS_MARKERS).some((marker) => existingCell.includes(marker));
    const formattedStatus = hasMarker && TASK_QUEUE_STATUS_MARKERS[normalizedStatus]
        ? `${TASK_QUEUE_STATUS_MARKERS[normalizedStatus]} ${normalizedStatus}`
        : normalizedStatus;
    return `${leadingWhitespace}${formattedStatus}${trailingWhitespace}`;
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
}

export function syncTaskQueueStatusDetailed(repoRoot: string, taskId: string, nextStatus: string): TaskQueueStatusSyncResult {
    const taskPath = path.join(repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            outcome: 'task_file_missing',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: null,
            next_status: String(nextStatus || '').trim().toUpperCase(),
            error_message: null
        };
    }

    const originalContent = fs.readFileSync(taskPath, 'utf8');
    const newline = originalContent.includes('\r\n') ? '\r\n' : '\n';
    const lines = originalContent.split(/\r?\n/);
    const normalizedNextStatus = String(nextStatus || '').trim().toUpperCase();
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
        const statusMatch = /\b(TODO|IN_PROGRESS|IN_REVIEW|DONE|BLOCKED)\b/i.exec(cells[1].trimmed);
        previousStatus = statusMatch ? statusMatch[1].toUpperCase() : null;
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
            error_message: null
        };
    }

    if (!changed) {
        return {
            outcome: 'already_synced',
            task_path: gateHelpers.normalizePath(taskPath),
            task_id: taskId,
            previous_status: previousStatus,
            next_status: normalizedNextStatus,
            error_message: null
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
            error_message: getErrorMessage(error)
        };
    }

    return {
        outcome: 'updated',
        task_path: gateHelpers.normalizePath(taskPath),
        task_id: taskId,
        previous_status: previousStatus,
        next_status: normalizedNextStatus,
        error_message: null
    };
}
