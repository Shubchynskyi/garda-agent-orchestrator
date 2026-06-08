import * as fs from 'node:fs';

import {
    buildEventIntegrityHash,
    forEachJsonlLine,
    toTrimmedLowerCaseString,
    toTrimmedString
} from './task-events-helpers';

// Root module retained for source-contract tests; timeline exports re-route grouped imports.
export interface InspectTaskEventResult {
    source_path: string;
    status: string;
    events_scanned: number;
    matching_events: number;
    parse_errors: number;
    task_id_mismatches: number;
    legacy_event_count: number;
    integrity_event_count: number;
    first_integrity_sequence: number | null;
    last_integrity_sequence: number | null;
    duplicate_event_hashes: string[];
    violations: string[];
}

export function normalizeIntegrityValue(value: unknown): unknown {
    if (value == null) {
        return value;
    }

    if (value instanceof Date) {
        return value.toISOString();
    }

    if (Array.isArray(value)) {
        return value.map(normalizeIntegrityValue);
    }

    if (typeof value === 'object') {
        const sorted: Record<string, unknown> = {};
        const obj = value as Record<string, unknown>;
        const keys = Object.keys(obj).sort();
        for (const key of keys) {
            sorted[key] = normalizeIntegrityValue(obj[key]);
        }
        return sorted;
    }

    if (typeof value === 'string' && value.includes('\\')) {
        return value.replace(/\\/g, '/');
    }

    return value;
}

export function inspectTaskEventFile(taskEventFile: string, taskId: string): InspectTaskEventResult {
    const result: InspectTaskEventResult = {
        source_path: String(taskEventFile).replace(/\\/g, '/'),
        status: 'UNKNOWN',
        events_scanned: 0,
        matching_events: 0,
        parse_errors: 0,
        task_id_mismatches: 0,
        legacy_event_count: 0,
        integrity_event_count: 0,
        first_integrity_sequence: null,
        last_integrity_sequence: null,
        duplicate_event_hashes: [],
        violations: []
    };

    try {
        if (!fs.existsSync(taskEventFile) || !fs.statSync(taskEventFile).isFile()) {
            result.status = 'MISSING';
            result.violations.push(`Task events file not found: ${result.source_path}`);
            return result;
        }
    } catch {
        result.status = 'MISSING';
        result.violations.push(`Task events file not found: ${result.source_path}`);
        return result;
    }

    let lastEventHash: string | null = null;
    let expectedSequence: number | null = null;
    let integrityStarted = false;
    const seenHashes = new Set<string>();

    try {
        forEachJsonlLine(taskEventFile, (rawLine: string, lineNumber: number) => {
            result.events_scanned++;

            let event: Record<string, unknown>;
            try {
                event = JSON.parse(rawLine) as Record<string, unknown>;
            } catch {
                result.parse_errors++;
                result.violations.push(`Task timeline contains invalid JSON at line ${lineNumber}.`);
                return;
            }

            const eventTaskId = toTrimmedString(event.task_id);
            if (eventTaskId && eventTaskId !== taskId) {
                result.task_id_mismatches++;
                result.violations.push(`Task timeline contains foreign task_id '${eventTaskId}' at line ${lineNumber}.`);
                return;
            }

            result.matching_events++;
            const integrity = event.integrity;
            if (!integrity || typeof integrity !== 'object') {
                if (integrityStarted) {
                    result.violations.push(
                        `Task timeline contains legacy/unverified event after integrity chain start at line ${lineNumber}.`
                    );
                } else {
                    result.legacy_event_count++;
                }
                return;
            }

            const integrityRecord = integrity as Record<string, unknown>;
            const schemaVersion = integrityRecord.schema_version;
            const taskSequence = integrityRecord.task_sequence;
            let prevEventSha256 = integrityRecord.prev_event_sha256;
            const eventSha256 = toTrimmedLowerCaseString(integrityRecord.event_sha256);

            if (schemaVersion !== 1) {
                result.violations.push(
                    `Task timeline integrity schema mismatch at line ${lineNumber}: expected 1, got '${schemaVersion}'.`
                );
                return;
            }
            if (typeof taskSequence !== 'number' || taskSequence <= 0) {
                result.violations.push(`Task timeline has invalid task_sequence at line ${lineNumber}.`);
                return;
            }
            if (prevEventSha256 != null && !String(prevEventSha256).trim()) {
                prevEventSha256 = null;
            }
            if (!eventSha256) {
                result.violations.push(`Task timeline missing event_sha256 at line ${lineNumber}.`);
                return;
            }

            if (!integrityStarted) {
                integrityStarted = true;
                expectedSequence = result.legacy_event_count + 1;
                if (prevEventSha256 != null) {
                    result.violations.push(
                        `Task timeline first integrity event must have null prev_event_sha256 (line ${lineNumber}).`
                    );
                }
            }

            if (taskSequence !== expectedSequence) {
                result.violations.push(
                    `Task timeline sequence mismatch at line ${lineNumber}: expected ${expectedSequence}, got ${taskSequence}.`
                );
            }

            const expectedPrevHash = lastEventHash;
            const normalizedPrevHash = prevEventSha256 != null
                ? String(prevEventSha256).trim().toLowerCase()
                : null;
            if (normalizedPrevHash !== expectedPrevHash) {
                result.violations.push(`Task timeline prev_event_sha256 mismatch at line ${lineNumber}.`);
            }

            const recalculatedHash = buildEventIntegrityHash(event);
            if (recalculatedHash !== eventSha256) {
                result.violations.push(`Task timeline event_sha256 mismatch at line ${lineNumber}.`);
            }

            if (seenHashes.has(eventSha256)) {
                result.duplicate_event_hashes.push(eventSha256);
                result.violations.push(`Task timeline duplicate/replayed event detected at line ${lineNumber}.`);
            }
            seenHashes.add(eventSha256);

            result.integrity_event_count++;
            if (result.first_integrity_sequence == null) {
                result.first_integrity_sequence = taskSequence;
            }
            result.last_integrity_sequence = taskSequence;
            lastEventHash = eventSha256;
            expectedSequence = taskSequence + 1;
        });
    } catch {
        result.status = 'MISSING';
        result.violations.push(`Task events file not found: ${result.source_path}`);
        return result;
    }

    if (result.violations.length > 0) {
        result.status = 'FAILED';
    } else if (result.matching_events === 0) {
        result.status = 'EMPTY';
    } else if (result.integrity_event_count === 0) {
        result.status = 'LEGACY_ONLY';
    } else if (result.legacy_event_count > 0) {
        result.status = 'PASS_WITH_LEGACY_PREFIX';
    } else {
        result.status = 'PASS';
    }

    return result;
}
