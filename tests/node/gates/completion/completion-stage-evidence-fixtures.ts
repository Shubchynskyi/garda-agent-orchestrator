import type { TimelineEventEntry } from '../../../../src/gates/completion';

export function makeTimelineEvents(...types: (string | { type: string, details: any })[]): TimelineEventEntry[] {
    return types.map((entry, index) => {
        const type = typeof entry === 'string' ? entry : entry.type;
        const details = typeof entry === 'object' ? entry.details : null;
        return {
            event_type: type,
            timestamp_utc: `2026-01-01T00:0${index}:00.000Z`,
            sequence: index,
            details
        };
    });
}

export function makeTimelineEvent(
    eventType: string,
    sequence: number,
    details: Record<string, unknown> | null = null,
    integrity: Record<string, unknown> | null = null
): TimelineEventEntry {
    return {
        event_type: eventType,
        timestamp_utc: `2026-01-01T00:0${sequence}:00.000Z`,
        sequence,
        details,
        integrity: integrity as TimelineEventEntry['integrity']
    };
}
