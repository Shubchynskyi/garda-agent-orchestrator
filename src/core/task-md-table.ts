export interface TaskMdTableCell {
    raw: string;
    trimmed: string;
    start: number;
    end: number;
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
