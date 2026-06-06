import * as fs from 'node:fs';
import * as path from 'node:path';

import { forEachJsonlLine, toTrimmedLowerCaseString, toTrimmedString } from './task-events-helpers';
import type { TaskEvent, TaskEventAppendState } from './task-events-io-types';

const TAIL_READ_CHUNK_SIZE = 4096;
const TASK_EVENT_APPEND_INDEX_CACHE_MAX_ENTRIES = 128;

interface TaskEventAppendIndex {
    taskFilePath: string;
    taskId: string;
    size: number;
    mtimeMs: number;
    ctimeMs: number;
    state: TaskEventAppendState;
    eventTypes: Set<string>;
}

interface TaskEventAppendReadiness {
    state: TaskEventAppendState;
    duplicate: boolean;
}

const taskEventAppendIndexCache = new Map<string, TaskEventAppendIndex>();

function createEmptyAppendState(): TaskEventAppendState {
    return {
        matching_events: 0,
        parse_errors: 0,
        last_integrity_sequence: null,
        last_event_sha256: null
    };
}

function readLastNonEmptyLine(filePath: string): string | null {
    let fd: number | null = null;
    try {
        let stat: fs.Stats;
        try {
            stat = fs.statSync(filePath);
        } catch {
            return null;
        }
        if (!stat.isFile() || stat.size === 0) {
            return null;
        }

        fd = fs.openSync(filePath, 'r');
        const fileSize = stat.size;
        const chunkSize = Math.min(TAIL_READ_CHUNK_SIZE, fileSize);
        let offset = fileSize;
        let accumulated = Buffer.alloc(0);

        while (offset > 0) {
            const readSize = Math.min(chunkSize, offset);
            offset -= readSize;
            const buf = Buffer.alloc(readSize);
            fs.readSync(fd, buf, 0, readSize, offset);
            accumulated = Buffer.concat([buf, accumulated]);

            let end = accumulated.length;
            while (end > 0) {
                const newlinePosition = accumulated.lastIndexOf(0x0A, end - 1);
                const lineStart = newlinePosition + 1;
                const lineBytes = accumulated.subarray(lineStart, end);
                if (lineBytes.length > 0 && lineBytes.some((byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0D)) {
                    return lineBytes.toString('utf8').trim();
                }
                end = newlinePosition >= 0 ? newlinePosition : 0;
            }
        }

        const text = accumulated.toString('utf8').trim();
        return text || null;
    } catch {
        return null;
    } finally {
        if (fd != null) {
            try { fs.closeSync(fd); } catch { /* best-effort */ }
        }
    }
}

function getTaskEventAppendIndexCacheKey(taskFilePath: string, taskId: string): string {
    return `${path.resolve(taskFilePath)}\0${taskId}`;
}

function getTaskEventFileStat(taskFilePath: string): { size: number; mtimeMs: number; ctimeMs: number } | null {
    try {
        const stat = fs.statSync(taskFilePath);
        return stat.isFile()
            ? { size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs }
            : null;
    } catch {
        return null;
    }
}

function rememberTaskEventAppendIndex(cacheKey: string, index: TaskEventAppendIndex): TaskEventAppendIndex {
    if (!taskEventAppendIndexCache.has(cacheKey) && taskEventAppendIndexCache.size >= TASK_EVENT_APPEND_INDEX_CACHE_MAX_ENTRIES) {
        const oldestKey = taskEventAppendIndexCache.keys().next().value as string | undefined;
        if (oldestKey) {
            taskEventAppendIndexCache.delete(oldestKey);
        }
    }
    taskEventAppendIndexCache.set(cacheKey, index);
    return index;
}

function readTaskEventAppendIndex(taskFilePath: string, taskId: string): TaskEventAppendIndex {
    const cacheKey = getTaskEventAppendIndexCacheKey(taskFilePath, taskId);
    const stat = getTaskEventFileStat(taskFilePath);

    if (!stat) {
        return rememberTaskEventAppendIndex(cacheKey, {
            taskFilePath,
            taskId,
            size: 0,
            mtimeMs: 0,
            ctimeMs: 0,
            state: createEmptyAppendState(),
            eventTypes: new Set<string>()
        });
    }

    const cached = taskEventAppendIndexCache.get(cacheKey);
    if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs && cached.ctimeMs === stat.ctimeMs) {
        return cached;
    }

    const state = createEmptyAppendState();
    const eventTypes = new Set<string>();

    forEachJsonlLine(taskFilePath, (rawLine: string) => {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            state.parse_errors++;
            return;
        }

        const eventTaskId = toTrimmedString(event.task_id);
        if (eventTaskId && eventTaskId !== taskId) {
            return;
        }

        state.matching_events++;
        const eventType = toTrimmedLowerCaseString(event.event_type);
        if (eventType) {
            eventTypes.add(eventType);
        }

        const integrity = event.integrity;
        if (!integrity || typeof integrity !== 'object') {
            return;
        }

        const integrityRecord = integrity as Record<string, unknown>;
        const sequence = integrityRecord.task_sequence;
        const eventSha256 = toTrimmedLowerCaseString(integrityRecord.event_sha256);
        if (typeof sequence === 'number' && sequence > 0 && eventSha256) {
            state.last_integrity_sequence = sequence;
            state.last_event_sha256 = eventSha256;
        }
    });

    return rememberTaskEventAppendIndex(cacheKey, {
        taskFilePath,
        taskId,
        size: stat.size,
        mtimeMs: stat.mtimeMs,
        ctimeMs: stat.ctimeMs,
        state,
        eventTypes
    });
}

export function readTaskEventAppendReadiness(
    taskFilePath: string,
    taskId: string,
    eventType: string,
    emitOnce: boolean
): TaskEventAppendReadiness {
    if (!emitOnce) {
        return {
            state: readTaskEventAppendState(taskFilePath, taskId),
            duplicate: false
        };
    }

    const index = readTaskEventAppendIndex(taskFilePath, taskId);
    const targetEventType = toTrimmedLowerCaseString(eventType);
    return {
        state: index.state,
        duplicate: targetEventType ? index.eventTypes.has(targetEventType) : false
    };
}

export function refreshTaskEventAppendIndexAfterAppend(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent
): void {
    const cacheKey = getTaskEventAppendIndexCacheKey(taskFilePath, taskId);
    const cached = taskEventAppendIndexCache.get(cacheKey);
    if (!cached) {
        return;
    }

    const stat = getTaskEventFileStat(taskFilePath);
    if (!stat) {
        taskEventAppendIndexCache.delete(cacheKey);
        return;
    }

    const eventType = toTrimmedLowerCaseString(event.event_type);
    if (eventType) {
        cached.eventTypes.add(eventType);
    }
    cached.size = stat.size;
    cached.mtimeMs = stat.mtimeMs;
    cached.ctimeMs = stat.ctimeMs;
    cached.state = {
        matching_events: cached.state.matching_events + 1,
        parse_errors: cached.state.parse_errors,
        last_integrity_sequence: event.integrity?.task_sequence ?? cached.state.last_integrity_sequence,
        last_event_sha256: event.integrity?.event_sha256 ?? cached.state.last_event_sha256
    };
}

export function readTaskEventAppendStateFast(taskFilePath: string, taskId: string): TaskEventAppendState | null {
    const rawLine = readLastNonEmptyLine(taskFilePath);
    if (!rawLine || !rawLine.trim()) {
        return null;
    }

    let event: Record<string, unknown>;
    try {
        event = JSON.parse(rawLine) as Record<string, unknown>;
    } catch {
        return null;
    }

    const eventTaskId = toTrimmedString(event.task_id);
    if (eventTaskId && eventTaskId !== taskId) {
        return null;
    }

    const integrity = event.integrity;
    if (!integrity || typeof integrity !== 'object') {
        return null;
    }

    const integrityRecord = integrity as Record<string, unknown>;
    const sequence = integrityRecord.task_sequence;
    const eventSha256 = toTrimmedLowerCaseString(integrityRecord.event_sha256);
    if (typeof sequence !== 'number' || sequence <= 0 || !eventSha256) {
        return null;
    }

    return {
        matching_events: sequence,
        parse_errors: 0,
        last_integrity_sequence: sequence,
        last_event_sha256: eventSha256
    };
}

export function readTaskEventAppendState(taskFilePath: string, taskId: string): TaskEventAppendState {
    const state = createEmptyAppendState();

    try {
        if (!fs.existsSync(taskFilePath) || !fs.statSync(taskFilePath).isFile()) {
            return state;
        }
    } catch {
        return state;
    }

    const fastState = readTaskEventAppendStateFast(taskFilePath, taskId);
    if (fastState != null) {
        return fastState;
    }

    forEachJsonlLine(taskFilePath, (rawLine: string) => {
        let event: Record<string, unknown>;
        try {
            event = JSON.parse(rawLine) as Record<string, unknown>;
        } catch {
            state.parse_errors++;
            return;
        }

        const eventTaskId = toTrimmedString(event.task_id);
        if (eventTaskId && eventTaskId !== taskId) {
            return;
        }

        state.matching_events++;
        const integrity = event.integrity;
        if (!integrity || typeof integrity !== 'object') {
            return;
        }

        const integrityRecord = integrity as Record<string, unknown>;
        const sequence = integrityRecord.task_sequence;
        const eventSha256 = toTrimmedLowerCaseString(integrityRecord.event_sha256);
        if (typeof sequence === 'number' && sequence > 0 && eventSha256) {
            state.last_integrity_sequence = sequence;
            state.last_event_sha256 = eventSha256;
        }
    });

    return state;
}

