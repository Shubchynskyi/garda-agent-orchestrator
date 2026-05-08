import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizePath } from './helpers';

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
    cells: string[];
    searchableText: string;
}

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

function parseTaskQueueRows(taskMdContent: string): TaskQueueRow[] {
    const rows: TaskQueueRow[] = [];
    for (const rawLine of String(taskMdContent || '').split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = parseMarkdownTableCells(trimmed);
        if (cells.length < 9 || cells[0].toLowerCase() === 'id' || cells[0].startsWith('-')) {
            continue;
        }
        rows.push({
            taskId: cells[0],
            cells,
            searchableText: normalizeSearchText(cells.join(' '))
        });
    }
    return rows;
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
    const artifactPath = normalizeSearchText(input.artifactPath);
    const artifactName = normalizeSearchText(path.basename(input.artifactPath));
    const requiredTokens = [
        normalizeSearchText(input.parentTaskId),
        normalizeSearchText(input.reviewType),
        normalizeSearchText(input.findingText)
    ];
    if (!requiredTokens.every((token) => token && row.searchableText.includes(token))) {
        return false;
    }
    return (!!artifactPath && row.searchableText.includes(artifactPath))
        || (!!artifactName && row.searchableText.includes(artifactName));
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
        violations.push(
            `Strict profile deferred finding from ${finding.reviewType} review '${normalizePath(finding.artifactPath)}' ` +
            `must be materialized as a separate TASK.md follow-up before final closeout. ` +
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
