export interface TaskMdTableCell {
    raw: string;
    trimmed: string;
    start: number;
    end: number;
}

const ACTIVE_QUEUE_HEADING = '## Active Queue';
const LOWER_HUMAN_SUMMARY_HEADINGS = new Set([
    '## User Summary (RU)',
    '## Блок очереди'
]);
const ACTIVE_QUEUE_HEADER = ['ID', 'Status', 'Priority', 'Area', 'Title', 'Owner', 'Updated', 'Profile', 'Notes'] as const;
const CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT = 9;
const MIN_SEPARATOR_WIDTH = 3;

export interface CanonicalActiveTaskQueueRow {
    lineIndex: number;
    rawLine: string;
    cells: TaskMdTableCell[];
    taskId: string;
    status: string;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface CanonicalActiveTaskQueueParseResult {
    found: boolean;
    rows: CanonicalActiveTaskQueueRow[];
    unavailableReason: string | null;
}

function isEscapedPipe(row: string, index: number): boolean {
    let backslashCount = 0;
    for (let cursor = index - 1; cursor >= 0 && row[cursor] === '\\'; cursor -= 1) {
        backslashCount += 1;
    }
    return backslashCount % 2 === 1;
}

export function parseTaskMdTableRow(row: string): TaskMdTableCell[] {
    const delimiterIndexes: number[] = [];

    for (let index = 0; index < row.length; index += 1) {
        if (row[index] === '|' && !isEscapedPipe(row, index)) {
            delimiterIndexes.push(index);
        }
    }

    if (delimiterIndexes.length < 2) {
        return [];
    }

    const cells: TaskMdTableCell[] = [];
    for (let index = 0; index < delimiterIndexes.length - 1; index += 1) {
        const start = delimiterIndexes[index] + 1;
        const end = delimiterIndexes[index + 1];
        const raw = row.slice(start, end);
        cells.push({
            raw,
            trimmed: raw.trim(),
            start,
            end
        });
    }

    const lastDelimiter = delimiterIndexes[delimiterIndexes.length - 1];
    if (lastDelimiter < row.length - 1) {
        const start = lastDelimiter + 1;
        const raw = row.slice(start);
        cells.push({
            raw,
            trimmed: raw.trim(),
            start,
            end: row.length
        });
    }

    return cells;
}

export function replaceTaskMdTableCell(row: string, cellIndex: number, nextCellRaw: string): string | null {
    const cells = parseTaskMdTableRow(row);
    if (cellIndex < 0 || cellIndex >= cells.length) {
        return null;
    }

    const targetCell = cells[cellIndex];
    return row.slice(0, targetCell.start) + nextCellRaw + row.slice(targetCell.end);
}

function findActiveQueueTableIndexes(lines: readonly string[]): {
    headerIndex: number;
    separatorIndex: number;
    rowsStartIndex: number;
    rowsEndIndex: number;
} | null {
    const activeQueueIndex = lines.findIndex((line) => line.trim() === ACTIVE_QUEUE_HEADING);
    if (activeQueueIndex < 0) {
        return null;
    }

    let headerIndex = -1;
    for (let index = activeQueueIndex + 1; index < lines.length; index += 1) {
        if (lines[index].trim().startsWith('|')) {
            headerIndex = index;
            break;
        }
        if (lines[index].trim().startsWith('## ')) {
            return null;
        }
    }
    if (headerIndex < 0 || headerIndex + 1 >= lines.length) {
        return null;
    }

    const separatorIndex = headerIndex + 1;
    if (!lines[separatorIndex].trim().startsWith('|')) {
        return null;
    }

    const rowsStartIndex = separatorIndex + 1;
    let rowsEndIndex = rowsStartIndex;
    while (rowsEndIndex < lines.length && lines[rowsEndIndex].trim().startsWith('|')) {
        rowsEndIndex += 1;
    }

    return { headerIndex, separatorIndex, rowsStartIndex, rowsEndIndex };
}

function isSeparatorCell(value: string): boolean {
    return /^:?-{3,}:?$/.test(value.trim());
}

function cellsMatchCanonicalActiveQueueHeader(cells: readonly TaskMdTableCell[]): boolean {
    return cells.length === CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT
        && cells.every((cell, index) => {
            if (index === 5) {
                return cell.trimmed === 'Owner' || cell.trimmed === 'Assignee';
            }
            return cell.trimmed === ACTIVE_QUEUE_HEADER[index];
        });
}

function cellsMatchCanonicalSeparator(cells: readonly TaskMdTableCell[]): boolean {
    return cells.length === CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT
        && cells.every((cell) => isSeparatorCell(cell.trimmed));
}

function isLowerHumanSummaryHeading(line: string): boolean {
    return LOWER_HUMAN_SUMMARY_HEADINGS.has(line.trim());
}

function findFirstCanonicalQueueTableIndexes(lines: readonly string[]): {
    headerIndex: number;
    separatorIndex: number;
    rowsStartIndex: number;
    rowsEndIndex: number;
} | null {
    for (let headerIndex = 0; headerIndex < lines.length - 1; headerIndex += 1) {
        if (isLowerHumanSummaryHeading(lines[headerIndex])) {
            return null;
        }
        const headerCells = parseTaskMdTableRow(lines[headerIndex]);
        if (!cellsMatchCanonicalActiveQueueHeader(headerCells)) {
            continue;
        }
        const separatorIndex = headerIndex + 1;
        const separatorCells = parseTaskMdTableRow(lines[separatorIndex]);
        if (!cellsMatchCanonicalSeparator(separatorCells)) {
            continue;
        }
        const rowsStartIndex = separatorIndex + 1;
        let rowsEndIndex = rowsStartIndex;
        while (rowsEndIndex < lines.length && lines[rowsEndIndex].trim().startsWith('|')) {
            rowsEndIndex += 1;
        }
        return { headerIndex, separatorIndex, rowsStartIndex, rowsEndIndex };
    }
    return null;
}

export function parseCanonicalActiveTaskQueue(content: string): CanonicalActiveTaskQueueParseResult {
    const lines = content.split(/\r?\n/);
    const range = findActiveQueueTableIndexes(lines) || findFirstCanonicalQueueTableIndexes(lines);
    if (!range) {
        return {
            found: false,
            rows: [],
            unavailableReason: 'Canonical ## Active Queue section not found.'
        };
    }

    const headerCells = parseTaskMdTableRow(lines[range.headerIndex]);
    const separatorCells = parseTaskMdTableRow(lines[range.separatorIndex]);
    if (!cellsMatchCanonicalActiveQueueHeader(headerCells) || !cellsMatchCanonicalSeparator(separatorCells)) {
        return {
            found: false,
            rows: [],
            unavailableReason: 'Canonical Active Queue 9-column table header not found.'
        };
    }

    const rows: CanonicalActiveTaskQueueRow[] = [];
    for (let index = range.rowsStartIndex; index < range.rowsEndIndex; index += 1) {
        const rawLine = lines[index];
        const cells = parseTaskMdTableRow(rawLine);
        if (cells.length !== CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT) {
            continue;
        }
        if (cells[0].trimmed.toLowerCase() === 'id' || cellsMatchCanonicalSeparator(cells)) {
            continue;
        }
        rows.push({
            lineIndex: index,
            rawLine,
            cells,
            taskId: cells[0].trimmed,
            status: cells[1].trimmed,
            priority: cells[2].trimmed,
            area: cells[3].trimmed,
            title: cells[4].trimmed,
            owner: cells[5].trimmed,
            updated: cells[6].trimmed,
            profile: cells[7].trimmed,
            notes: cells[8].trimmed
        });
    }

    return {
        found: true,
        rows,
        unavailableReason: null
    };
}

function formatTaskMdTableRowValues(values: readonly string[], widths: readonly number[]): string {
    return `| ${values.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;
}

function formatTaskMdTableSeparator(widths: readonly number[]): string {
    return `|${widths
        .map((width) => '-'.repeat(Math.max(MIN_SEPARATOR_WIDTH, width + 2)))
        .join('|')}|`;
}

export function formatActiveTaskQueueTable(content: string): string {
    const newline = content.includes('\r\n') ? '\r\n' : '\n';
    const hasTrailingNewline = content.endsWith('\n');
    const lines = content.split(/\r?\n/);
    if (hasTrailingNewline && lines.length > 0 && lines[lines.length - 1] === '') {
        lines.pop();
    }

    const range = findActiveQueueTableIndexes(lines);
    if (!range) {
        return content;
    }

    const headerCells = parseTaskMdTableRow(lines[range.headerIndex]);
    const separatorCells = parseTaskMdTableRow(lines[range.separatorIndex]);
    if (
        !cellsMatchCanonicalActiveQueueHeader(headerCells)
        || !cellsMatchCanonicalSeparator(separatorCells)
    ) {
        return content;
    }

    const parsedRows: string[][] = [];
    for (let index = range.rowsStartIndex; index < range.rowsEndIndex; index += 1) {
        const cells = parseTaskMdTableRow(lines[index]);
        if (cells.length !== CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT) {
            return content;
        }
        parsedRows.push(cells.map((cell) => cell.trimmed));
    }

    const headerValues = headerCells.map((cell) => cell.trimmed);
    const widths = headerValues.map((header, columnIndex) => Math.max(
        header.length,
        ...parsedRows.map((row) => row[columnIndex].length)
    ));

    const formattedLines = [
        formatTaskMdTableRowValues(headerValues, widths),
        formatTaskMdTableSeparator(widths),
        ...parsedRows.map((row) => formatTaskMdTableRowValues(row, widths))
    ];

    const nextLines = [
        ...lines.slice(0, range.headerIndex),
        ...formattedLines,
        ...lines.slice(range.rowsEndIndex)
    ];
    const nextContent = nextLines.join(newline);
    return hasTrailingNewline ? `${nextContent}${newline}` : nextContent;
}
