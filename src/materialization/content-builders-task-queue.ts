import { normalizeLineEndings } from '../core/line-endings';
import { formatActiveTaskQueueTable } from '../core/task-md-table';
import {
    extractManagedBlockFromContent,
    MANAGED_END,
    MANAGED_START,
    TaskQueueTableRange
} from './content-builders-shared';

export function getTaskQueueTableRange(managedBlock: string | null | undefined): TaskQueueTableRange | null {
    if (!managedBlock || !managedBlock.trim()) return null;
    const normalized = normalizeLineEndings(managedBlock, '\n');
    const lines = normalized.split('\n');

    let activeQueueIndex = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim() === '## Active Queue') {
            activeQueueIndex = i;
            break;
        }
    }
    if (activeQueueIndex < 0) return null;

    let headerIndex = -1;
    for (let i = activeQueueIndex + 1; i < lines.length; i++) {
        if (lines[i].trim().startsWith('|')) {
            headerIndex = i;
            break;
        }
    }
    if (headerIndex < 0) return null;

    let separatorIndex = -1;
    if (headerIndex + 1 < lines.length && lines[headerIndex + 1].trim().startsWith('|')) {
        separatorIndex = headerIndex + 1;
    }
    if (separatorIndex < 0) return null;

    const rowsStartIndex = separatorIndex + 1;
    let rowsEndIndex = rowsStartIndex;
    while (rowsEndIndex < lines.length && lines[rowsEndIndex].trim().startsWith('|')) {
        rowsEndIndex++;
    }

    return { lines, rowsStartIndex, rowsEndIndex };
}

export function getTaskQueueRowsFromManagedBlock(managedBlock: string | null | undefined): string[] {
    const range = getTaskQueueTableRange(managedBlock);
    if (!range) return [];
    const rows = [];
    for (let i = range.rowsStartIndex; i < range.rowsEndIndex; i++) {
        if (range.lines[i] && range.lines[i].trim()) {
            rows.push(range.lines[i]);
        }
    }
    return rows;
}

export function setTaskQueueRowsInManagedBlock(managedBlock: string, rows: string[]): string {
    const range = getTaskQueueTableRange(managedBlock);
    if (!range) return managedBlock;

    const prefix = range.rowsStartIndex > 0 ? range.lines.slice(0, range.rowsStartIndex) : [];
    const suffix = range.rowsEndIndex < range.lines.length ? range.lines.slice(range.rowsEndIndex) : [];
    return formatActiveTaskQueueTable([...prefix, ...rows, ...suffix].join('\n'));
}

export function hasLegacyDepthColumn(managedBlock: string): boolean {
    return /\|\s*Depth\s*\|/i.test(managedBlock) && !/\|\s*Profile\s*\|/i.test(managedBlock);
}

/**
 * Migrates a task row from the legacy `Depth` column to `Profile`.
 * Numeric depth values (1, 2, 3) become `default`; the original depth
 * is preserved in the Notes column as `requested_depth=<value>` when
 * not already present.  Non-numeric values that look like valid profile
 * names are retained as-is (they may be user-entered profile overrides).
 */
export function migrateDepthToProfileRow(row: string): string {
    const cells = row.split('|');
    // Expect at least 10 segments: empty + 9 columns + trailing empty from '| a | b | ... |'
    if (cells.length < 10) return row;

    const depthCell = cells[8].trim(); // column index 8 = Depth (0-based split: ['', ID, Status, ..., Depth, Notes, ''])
    if (!depthCell) return row;

    const numericDepth = /^[1-3]$/.test(depthCell);
    const notesCell = cells[9] || '';

    if (numericDepth) {
        // Numeric depth → default, preserve original in Notes
        cells[8] = ' default ';
        if (!notesCell.includes('requested_depth')) {
            const trimmedNotes = notesCell.trim();
            const depthNote = `requested_depth=${depthCell}`;
            cells[9] = trimmedNotes
                ? ` ${depthNote}; ${trimmedNotes}`
                : ` ${depthNote} `;
        }
    }
    // Non-numeric values are kept as-is (may be valid profile names)

    return cells.join('|');
}

/**
 * Builds a TASK.md managed block preserving existing queue rows.
 * Migrates legacy Depth column values to Profile when the existing block
 * uses the old header format.
 */
export function buildTaskManagedBlockWithExistingQueue(templateContent: string, existingContent: string): string | null {
    const templateBlock = extractManagedBlockFromContent(templateContent, MANAGED_START, MANAGED_END);
    if (!templateBlock) return null;

    const existingBlock = extractManagedBlockFromContent(existingContent, MANAGED_START, MANAGED_END);
    if (!existingBlock) return templateBlock;

    let existingRows = getTaskQueueRowsFromManagedBlock(existingBlock);
    if (existingRows.length === 0) return templateBlock;

    if (hasLegacyDepthColumn(existingBlock)) {
        existingRows = existingRows.map(migrateDepthToProfileRow);
    }

    return setTaskQueueRowsInManagedBlock(templateBlock, existingRows);
}

function getTaskQueueRowsFromRange(range: TaskQueueTableRange): string[] {
    const rows = [];
    for (let i = range.rowsStartIndex; i < range.rowsEndIndex; i++) {
        if (range.lines[i] && range.lines[i].trim()) {
            rows.push(range.lines[i]);
        }
    }
    return rows;
}

function joinTaskManagedBlockAndSuffix(
    managedBlock: string,
    suffix: string,
    newline: string
): string {
    const normalizedBlock = normalizeLineEndings(managedBlock, newline);
    const normalizedSuffix = normalizeLineEndings(suffix || '', newline);
    const content = `${normalizedBlock}${normalizedSuffix}`;
    return content.endsWith(newline) ? content : `${content}${newline}`;
}

/**
 * Builds the full TASK.md content for install/update sync.
 *
 * TASK.md is a local operator-owned task surface even though its header is
 * installer-managed. A normal managed-block replacement is unsafe when an old
 * or hand-edited TASK.md lost its managed-end marker: the whole task queue and
 * local lower planning block would be replaced by the template default queue.
 *
 * This builder preserves the existing Active Queue rows and everything after
 * that table, then refreshes only the template-owned managed preamble/table
 * shape. Valid managed blocks keep any existing prefix/suffix around the block.
 */
export function buildTaskContentWithExistingQueue(templateContent: string, existingContent: string): string | null {
    const templateBlock = extractManagedBlockFromContent(templateContent, MANAGED_START, MANAGED_END);
    if (!templateBlock) return null;

    const newline = String(existingContent || '').includes('\r\n') ? '\r\n' : '\n';
    const existingBlock = extractManagedBlockFromContent(existingContent, MANAGED_START, MANAGED_END);

    if (existingBlock) {
        let existingRows = getTaskQueueRowsFromManagedBlock(existingBlock);
        if (hasLegacyDepthColumn(existingBlock)) {
            existingRows = existingRows.map(migrateDepthToProfileRow);
        }

        const nextBlock = existingRows.length > 0
            ? setTaskQueueRowsInManagedBlock(templateBlock, existingRows)
            : templateBlock;
        const blockStart = existingContent.indexOf(existingBlock);
        const blockEnd = blockStart + existingBlock.length;
        const prefix = blockStart > 0 ? existingContent.slice(0, blockStart) : '';
        const suffix = existingContent.slice(blockEnd);
        const nextContent = `${prefix}${nextBlock}${suffix}`;
        return normalizeLineEndings(
            nextContent.endsWith(newline) ? nextContent : `${nextContent}${newline}`,
            newline
        );
    }

    const existingQueueRange = getTaskQueueTableRange(existingContent);
    if (!existingQueueRange) {
        return normalizeLineEndings(
            templateContent.endsWith(newline) ? templateContent : `${templateContent}${newline}`,
            newline
        );
    }

    let existingRows = getTaskQueueRowsFromRange(existingQueueRange);
    if (existingRows.length === 0) {
        return normalizeLineEndings(
            templateContent.endsWith(newline) ? templateContent : `${templateContent}${newline}`,
            newline
        );
    }

    if (hasLegacyDepthColumn(existingContent)) {
        existingRows = existingRows.map(migrateDepthToProfileRow);
    }

    const suffix = existingQueueRange.lines
        .slice(existingQueueRange.rowsEndIndex)
        .join('\n');
    const nextBlock = setTaskQueueRowsInManagedBlock(templateBlock, existingRows);
    return joinTaskManagedBlockAndSuffix(nextBlock, suffix, newline);
}
