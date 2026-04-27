export interface PrePreflightTimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

const PRE_PREFLIGHT_CYCLE_RESET_BOUNDARY_EVENTS = new Set([
    'REVIEW_GATE_PASSED',
    'REVIEW_GATE_PASSED_WITH_OVERRIDE',
    'COMPLETION_GATE_PASSED'
]);

export function isTaskEntryRulePackLoadedEvent(entry: PrePreflightTimelineEventEntry): boolean {
    return entry.event_type === 'RULE_PACK_LOADED'
        && String(entry.details?.stage || '').trim().toUpperCase() === 'TASK_ENTRY';
}

export function getLatestPrePreflightCycleAnchor<T extends PrePreflightTimelineEventEntry>(
    events: readonly T[]
): T | null {
    let latestTaskMode: T | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.event_type === 'TASK_MODE_ENTERED') {
            latestTaskMode = entry;
            break;
        }
    }
    if (!latestTaskMode) {
        return null;
    }

    let lowerBoundExclusive = latestTaskMode.sequence;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence <= latestTaskMode.sequence) {
            break;
        }
        if (PRE_PREFLIGHT_CYCLE_RESET_BOUNDARY_EVENTS.has(entry.event_type)) {
            lowerBoundExclusive = entry.sequence;
            break;
        }
    }

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence <= lowerBoundExclusive) {
            break;
        }
        if (isTaskEntryRulePackLoadedEvent(entry)) {
            return entry;
        }
    }

    return latestTaskMode;
}

export function describePrePreflightCycleAnchor(entry: PrePreflightTimelineEventEntry): string {
    if (entry.event_type === 'TASK_MODE_ENTERED') {
        return `latest TASK_MODE_ENTERED (seq ${entry.sequence})`;
    }
    if (isTaskEntryRulePackLoadedEvent(entry)) {
        return `latest RULE_PACK_LOADED for TASK_ENTRY (seq ${entry.sequence})`;
    }
    return `${entry.event_type} (seq ${entry.sequence})`;
}
