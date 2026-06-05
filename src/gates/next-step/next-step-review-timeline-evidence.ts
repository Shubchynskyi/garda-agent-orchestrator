import * as fs from 'node:fs';
import * as path from 'node:path';

import type {
    ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

export function getLatestTaskSequenceForEventTypes(
    eventsRoot: string,
    taskId: string,
    eventTypes: string[]
): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

export function readTaskTimelineEventLikes(eventsRoot: string, taskId: string): ReviewReuseTelemetryEventLike[] {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return [];
    }
    const events: ReviewReuseTelemetryEventLike[] = [];
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as ReviewReuseTelemetryEventLike);
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return events;
}

export function getTimelineEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
        ? event.integrity as Record<string, unknown>
        : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

export function getLatestReviewEventSequence(
    events: readonly ReviewReuseTelemetryEventLike[],
    eventType: string,
    reviewType: string
): number | null {
    const normalizedEventType = eventType.trim().toUpperCase();
    const normalizedReviewType = reviewType.trim().toLowerCase();
    let latestSequence: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== normalizedEventType) {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        const currentReviewType = String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase();
        if (currentReviewType !== normalizedReviewType) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}
