import * as fs from 'node:fs';
import * as path from 'node:path';
import { allocateNextParentDerivedTaskId } from '../../core/task-id-allocation';
import { normalizePath } from '../shared/helpers';

export interface DeferredReviewFindingInput {
    reviewType: string;
    artifactPath: string;
    findings: string[];
}

export interface DeferredFollowupValidationResult {
    required: boolean;
    status: 'NOT_REQUIRED' | 'PASS' | 'FAILED';
    checked_count: number;
    matched_count: number;
    violations: string[];
}

interface TaskQueueRow {
    taskId: string;
    status: string;
    cells: string[];
    searchableNotes: string;
}

const ACTIVE_FOLLOWUP_STATUSES = new Set(['todo', 'in_progress', 'in review', 'in_review']);
const TASK_QUEUE_HEADER_CELLS = ['id', 'status', 'priority', 'area', 'title', 'owner', 'updated', 'profile', 'notes'];

function normalizeSearchText(value: string): string {
    return String(value || '')
        .replace(/\\/g, '/')
        .replace(/\/\|/g, '|')
        .replace(/\s+/g, ' ')
        .trim()
        .toLowerCase();
}

function parseMarkdownTableCells(row: string): string[] {
    const trimmed = String(row || '').trim();
    if (!trimmed.startsWith('|')) {
        return [];
    }
    const cells: string[] = [];
    let current = '';
    let escaped = false;
    for (let index = 1; index < trimmed.length; index += 1) {
        const char = trimmed[index];
        if (escaped) {
            current += char;
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = true;
            current += char;
            continue;
        }
        if (char === '|') {
            cells.push(current.trim());
            current = '';
            continue;
        }
        current += char;
    }
    return cells;
}

function isTaskQueueHeader(cells: string[]): boolean {
    if (cells.length !== TASK_QUEUE_HEADER_CELLS.length) {
        return false;
    }
    return TASK_QUEUE_HEADER_CELLS.every((expected, index) => normalizeSearchText(cells[index] || '') === expected);
}

function isTaskQueueSeparator(cells: string[]): boolean {
    return cells.length === TASK_QUEUE_HEADER_CELLS.length
        && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function parseTaskQueueRows(taskMdContent: string): TaskQueueRow[] {
    const rows: TaskQueueRow[] = [];
    const lines = String(taskMdContent || '').split('\n');
    let inActiveQueue = false;
    let seenActiveQueueHeader = false;
    let seenActiveQueueSeparator = false;
    for (const rawLine of lines) {
        const trimmed = rawLine.trim();
        if (/^##\s+/.test(trimmed)) {
            inActiveQueue = /^##\s+Active Queue\s*$/i.test(trimmed);
            seenActiveQueueHeader = false;
            seenActiveQueueSeparator = false;
            continue;
        }
        if (!inActiveQueue) {
            continue;
        }
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = parseMarkdownTableCells(trimmed);
        if (!seenActiveQueueHeader) {
            if (isTaskQueueHeader(cells)) {
                seenActiveQueueHeader = true;
            }
            continue;
        }
        if (!seenActiveQueueSeparator) {
            if (isTaskQueueSeparator(cells)) {
                seenActiveQueueSeparator = true;
            } else if (!isTaskQueueHeader(cells)) {
                seenActiveQueueHeader = false;
            }
            continue;
        }
        if (cells.length !== TASK_QUEUE_HEADER_CELLS.length || isTaskQueueHeader(cells) || isTaskQueueSeparator(cells)) {
            continue;
        }
        rows.push({
            taskId: cells[0],
            status: cells[1],
            cells,
            searchableNotes: normalizeSearchText(cells[8])
        });
    }
    return rows;
}

function isActiveFollowupStatus(status: string): boolean {
    const normalized = normalizeSearchText(status);
    const canonicalStatus = normalized.replace(/^[^a-z0-9_]+/i, '').trim();
    return ACTIVE_FOLLOWUP_STATUSES.has(canonicalStatus);
}

function hasMatchingFollowup(row: TaskQueueRow, input: {
    parentTaskId: string;
    reviewType: string;
    artifactPath: string;
    findingText: string;
}): boolean {
    if (row.taskId === input.parentTaskId) {
        return false;
    }
    if (!isActiveFollowupStatus(row.status)) {
        return false;
    }
    const artifactPath = normalizeSearchText(input.artifactPath);
    const artifactName = normalizeSearchText(path.basename(input.artifactPath));
    const requiredTokens = [
        normalizeSearchText(input.parentTaskId),
        normalizeSearchText(input.reviewType),
        normalizeSearchText(input.findingText)
    ];
    if (!requiredTokens.every((token) => token && row.searchableNotes.includes(token))) {
        return false;
    }
    return (!!artifactPath && row.searchableNotes.includes(artifactPath))
        || (!!artifactName && row.searchableNotes.includes(artifactName));
}

export function validateStrictDeferredReviewFollowups(options: {
    repoRoot: string;
    taskId: string;
    activeProfile: string | null;
    reviewFindings: DeferredReviewFindingInput[];
}): DeferredFollowupValidationResult {
    const activeProfile = String(options.activeProfile || '').trim().toLowerCase();
    const flattenedFindings = options.reviewFindings.flatMap((reviewFinding) =>
        reviewFinding.findings
            .map((finding) => ({
                reviewType: reviewFinding.reviewType,
                artifactPath: reviewFinding.artifactPath,
                findingText: String(finding || '').trim()
            }))
            .filter((finding) => finding.findingText.length > 0)
    );

    if (activeProfile !== 'strict' || flattenedFindings.length === 0) {
        return {
            required: false,
            status: 'NOT_REQUIRED',
            checked_count: flattenedFindings.length,
            matched_count: 0,
            violations: []
        };
    }

    const taskPath = path.join(options.repoRoot, 'TASK.md');
    if (!fs.existsSync(taskPath) || !fs.statSync(taskPath).isFile()) {
        return {
            required: true,
            status: 'FAILED',
            checked_count: flattenedFindings.length,
            matched_count: 0,
            violations: [`Strict deferred review follow-up validation requires TASK.md, but it was not found at '${normalizePath(taskPath)}'.`]
        };
    }

    const taskRows = parseTaskQueueRows(fs.readFileSync(taskPath, 'utf8'));
    const existingTaskIds = taskRows.map((row) => row.taskId);
    const violations: string[] = [];
    let matchedCount = 0;
    for (const finding of flattenedFindings) {
        const matched = taskRows.some((row) => hasMatchingFollowup(row, {
            parentTaskId: options.taskId,
            reviewType: finding.reviewType,
            artifactPath: finding.artifactPath,
            findingText: finding.findingText
        }));
        if (matched) {
            matchedCount += 1;
            continue;
        }
        const suggestedTaskId = allocateNextParentDerivedTaskId({
            parentTaskId: options.taskId,
            existingTaskIds,
            kind: 'followup'
        });
        existingTaskIds.push(suggestedTaskId);
        violations.push(
            `Strict profile deferred finding from ${finding.reviewType} review '${normalizePath(finding.artifactPath)}' ` +
            `must be materialized as a separate TASK.md follow-up before final closeout. ` +
            `Suggested follow-up task id: ${suggestedTaskId}. ` +
            `Follow-up notes must preserve parent task '${options.taskId}', review type '${finding.reviewType}', ` +
            `source artifact '${normalizePath(finding.artifactPath)}', and original finding text: ${finding.findingText}`
        );
    }

    return {
        required: true,
        status: violations.length > 0 ? 'FAILED' : 'PASS',
        checked_count: flattenedFindings.length,
        matched_count: matchedCount,
        violations
    };
}
