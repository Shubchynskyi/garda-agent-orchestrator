export interface TaskMdTableCell {
    raw: string;
    trimmed: string;
    start: number;
    end: number;
}

const ACTIVE_QUEUE_HEADING = '## Active Queue';
const CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT = 9;
const MIN_SEPARATOR_WIDTH = 3;

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
        headerCells.length !== CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT
        || separatorCells.length !== CANONICAL_ACTIVE_QUEUE_COLUMN_COUNT
        || !separatorCells.every((cell) => isSeparatorCell(cell.trimmed))
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
