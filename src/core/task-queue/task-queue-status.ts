export const TASK_QUEUE_STATUS_MARKERS: Readonly<Record<string, string>> = Object.freeze({
    TODO: '🟦',
    IN_PROGRESS: '🟨',
    IN_REVIEW: '🟧',
    DONE: '🟩',
    BLOCKED: '🟥',
    SPLIT_REQUIRED: '🟫',
    DECOMPOSED: '🟪'
});

export function normalizeTaskQueueStatusCell(statusCell: string | null): string {
    return String(statusCell || '').trim().toUpperCase();
}

export function readTaskQueueStatusToken(statusCell: string | null): string | null {
    const normalized = normalizeTaskQueueStatusCell(statusCell);
    for (const [status, marker] of Object.entries(TASK_QUEUE_STATUS_MARKERS)) {
        if (normalized === status || normalized === marker) {
            return status;
        }
        if (normalized.startsWith(marker)) {
            const withoutMarker = normalized.slice(marker.length).trim();
            if (withoutMarker === status) {
                return status;
            }
        }
    }
    return null;
}

export function formatCanonicalTaskQueueStatusCell(statusCell: string | null): string {
    const statusToken = readTaskQueueStatusToken(statusCell);
    if (!statusToken) {
        return String(statusCell || '').trim();
    }
    return `${TASK_QUEUE_STATUS_MARKERS[statusToken]} ${statusToken}`;
}

export function formatTaskQueueStatusCell(existingCell: string, nextStatus: string): string {
    const normalizedStatus = normalizeTaskQueueStatusCell(nextStatus);
    const leadingWhitespace = existingCell.match(/^\s*/)?.[0] ?? ' ';
    const trailingWhitespace = existingCell.match(/\s*$/)?.[0] ?? ' ';
    const formattedStatus = TASK_QUEUE_STATUS_MARKERS[normalizedStatus]
        ? `${TASK_QUEUE_STATUS_MARKERS[normalizedStatus]} ${normalizedStatus}`
        : normalizedStatus;
    return `${leadingWhitespace}${formattedStatus}${trailingWhitespace}`;
}
