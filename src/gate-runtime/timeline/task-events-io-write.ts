import * as fs from 'node:fs';

import { buildEventIntegrityHash } from '../task-events-helpers';
import { readTaskEventAppendReadiness, refreshTaskEventAppendIndexAfterAppend } from '../task-events-io-index';
import type { TaskEvent } from '../task-events-io-types';

function sleepMsAsync(milliseconds: number): Promise<void> {
    if (!milliseconds || milliseconds <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function assignEventIntegrity(event: TaskEvent, matchingEvents: number, previousSequence: number | null, previousHash: string | null): void {
    const nextSequence = typeof previousSequence === 'number'
        ? previousSequence + 1
        : matchingEvents + 1;

    event.integrity = {
        schema_version: 1,
        task_sequence: nextSequence,
        prev_event_sha256: previousHash
    };

    const eventSha256 = buildEventIntegrityHash({ ...event });
    if (eventSha256 == null) {
        throw new Error('Failed to build event integrity hash.');
    }

    event.integrity.event_sha256 = eventSha256;
}

export function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function appendTaskEventLineSync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent,
    emitOnce: boolean
): string | null {
    const readiness = readTaskEventAppendReadiness(taskFilePath, taskId, event.event_type, emitOnce);
    if (readiness.duplicate) {
        return null;
    }

    const appendState = readiness.state;
    assignEventIntegrity(
        event,
        appendState.matching_events,
        appendState.last_integrity_sequence,
        appendState.last_event_sha256
    );

    const serializedLine = JSON.stringify(event);
    fs.appendFileSync(taskFilePath, serializedLine + '\n', 'utf8');
    refreshTaskEventAppendIndexAfterAppend(taskFilePath, taskId, event);
    return serializedLine;
}

export async function appendTaskEventLineAsync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent,
    preWriteDelayMs: number,
    emitOnce: boolean
): Promise<string | null> {
    const readiness = readTaskEventAppendReadiness(taskFilePath, taskId, event.event_type, emitOnce);
    if (readiness.duplicate) {
        return null;
    }

    const appendState = readiness.state;
    assignEventIntegrity(
        event,
        appendState.matching_events,
        appendState.last_integrity_sequence,
        appendState.last_event_sha256
    );

    const serializedLine = JSON.stringify(event);
    if (preWriteDelayMs > 0) {
        await sleepMsAsync(preWriteDelayMs);
    }
    fs.appendFileSync(taskFilePath, serializedLine + '\n', 'utf8');
    refreshTaskEventAppendIndexAfterAppend(taskFilePath, taskId, event);
    return serializedLine;
}
