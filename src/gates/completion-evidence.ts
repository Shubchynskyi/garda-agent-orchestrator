import * as fs from 'node:fs';
import * as path from 'node:path';
import type { TaskEventIntegrity } from '../gate-runtime/task-events';
import { normalizePath } from './helpers';

/**
 * A single parsed event from the task timeline JSONL file.
 */
export interface TimelineEventEntry {
    event_type: string;
    timestamp_utc: string;
    sequence: number;
    details: Record<string, unknown> | null;
    integrity?: TaskEventIntegrity | null;
}

/**
 * Read ordered timeline events from a JSONL file.
 * Returns events in file order (integrity-sequence order) with their event types.
 */
export function collectOrderedTimelineEvents(timelinePath: string, errors: string[]): TimelineEventEntry[] {
    const entries: TimelineEventEntry[] = [];
    const resolvedPath = path.resolve(String(timelinePath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        errors.push(`Task timeline not found: ${normalizePath(resolvedPath)}`);
        return entries;
    }

    const lines = fs.readFileSync(resolvedPath, 'utf8').split('\n').filter(line => line.trim().length > 0);
    let seq = 0;
    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            const timestampUtc = String(parsed.timestamp_utc || '').trim();
            const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                ? parsed.details as Record<string, unknown>
                : null;
            const rawIntegrity = parsed.integrity && typeof parsed.integrity === 'object' && !Array.isArray(parsed.integrity)
                ? parsed.integrity as Record<string, unknown>
                : null;
            const taskSequence = typeof rawIntegrity?.task_sequence === 'number'
                ? rawIntegrity.task_sequence
                : Number(rawIntegrity?.task_sequence);
            const eventSha256 = String(rawIntegrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256Raw = rawIntegrity?.prev_event_sha256;
            const prevEventSha256 = prevEventSha256Raw == null
                ? null
                : String(prevEventSha256Raw).trim().toLowerCase() || null;
            const integrity = rawIntegrity
                && Number.isInteger(taskSequence)
                && taskSequence > 0
                && /^[0-9a-f]{64}$/.test(eventSha256)
                && (prevEventSha256 == null || /^[0-9a-f]{64}$/.test(prevEventSha256))
                ? {
                    schema_version: typeof rawIntegrity.schema_version === 'number'
                        ? rawIntegrity.schema_version
                        : Number(rawIntegrity.schema_version) || 1,
                    task_sequence: taskSequence,
                    prev_event_sha256: prevEventSha256,
                    event_sha256: eventSha256
                } as TaskEventIntegrity
                : null;
            if (eventType) {
                entries.push({ event_type: eventType, timestamp_utc: timestampUtc, sequence: seq, details, integrity });
            }
            seq++;
        } catch {
            errors.push(`Task timeline contains invalid JSON line: ${normalizePath(resolvedPath)}`);
            seq++;
            continue;
        }
    }

    return entries;
}

/**
 * Read a JSON artifact from disk. Returns null and pushes to errors on failure.
 */
export function readJsonArtifact(
    artifactPath: string,
    label: string,
    errors: string[],
    { required = true } = {}
): Record<string, unknown> | null {
    const resolvedPath = path.resolve(String(artifactPath || ''));
    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        if (required) {
            errors.push(`${label} artifact not found: ${normalizePath(resolvedPath)}`);
        }
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(resolvedPath, 'utf8'));
    } catch {
        errors.push(`${label} artifact is not valid JSON: ${normalizePath(resolvedPath)}`);
        return null;
    }
}

/**
 * Assert that a loaded artifact has PASSED status and PASS outcome.
 */
export function ensurePassedArtifactStatus(
    artifact: Record<string, unknown> | null,
    label: string,
    errors: string[]
): void {
    if (!artifact) {
        return;
    }
    if (String(artifact.status || '').trim().toUpperCase() !== 'PASSED') {
        errors.push(`${label} artifact status must be PASSED, got '${String(artifact.status || 'UNKNOWN')}'.`);
    }
    if (String(artifact.outcome || '').trim().toUpperCase() !== 'PASS') {
        errors.push(`${label} artifact outcome must be PASS, got '${String(artifact.outcome || 'UNKNOWN')}'.`);
    }
}

/**
 * Read an optional string field from a loaded artifact, returning null if absent or empty.
 */
export function readOptionalArtifactStringField(
    artifact: Record<string, unknown> | null,
    fieldName: string
): string | null {
    if (!artifact) {
        return null;
    }
    const value = artifact[fieldName];
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed || null;
}

/**
 * Normalize a timeline event detail value to a trimmed string or null.
 */
export function normalizeTimelineDetailString(value: unknown): string | null {
    const text = String(value || '').trim();
    return text || null;
}

/**
 * Extract and normalize the skill_id from a timeline event's details.
 */
export function getTimelineSkillId(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    return normalizeTimelineDetailString(event.details.skill_id ?? event.details.skillId)?.toLowerCase() || null;
}

/**
 * Extract and normalize the reference_path from a timeline event's details.
 */
export function getTimelineReferencePath(event: TimelineEventEntry): string | null {
    if (!event.details) {
        return null;
    }
    const raw = normalizeTimelineDetailString(event.details.reference_path ?? event.details.referencePath);
    return raw ? normalizePath(raw).toLowerCase() : null;
}

/**
 * Check if a timeline event matches any of the candidate review skill IDs.
 */
export function eventMatchesReviewSkill(event: TimelineEventEntry, candidateSkillIds: string[]): boolean {
    const normalizedCandidates = candidateSkillIds.map(candidate => candidate.toLowerCase());
    const skillId = getTimelineSkillId(event);
    if (skillId && normalizedCandidates.includes(skillId)) {
        return true;
    }

    const referencePath = getTimelineReferencePath(event);
    if (!referencePath) {
        return false;
    }

    return normalizedCandidates.some((candidate) => referencePath.includes(`/live/skills/${candidate.toLowerCase()}/`));
}

/**
 * Check if a timeline event matches a given stage name.
 */
export function eventMatchesStage(entry: TimelineEventEntry, stage: string): boolean {
    if (stage === 'REVIEW_GATE_PASSED') {
        return entry.event_type === 'REVIEW_GATE_PASSED' || entry.event_type === 'REVIEW_GATE_PASSED_WITH_OVERRIDE';
    }
    return entry.event_type === stage;
}

/**
 * Find the latest timeline event matching a predicate (scanning from end).
 */
export function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    predicate: (entry: TimelineEventEntry) => boolean
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (predicate(entry)) {
            return entry;
        }
    }
    return null;
}

/**
 * Find the latest occurrence of a stage event with sequence below an upper bound.
 */
export function findLatestStageOccurrence(
    events: readonly TimelineEventEntry[],
    stage: string,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

/**
 * Find the latest occurrence of a stage event within a bounded sequence range.
 */
export function findLatestStageOccurrenceInRange(
    events: readonly TimelineEventEntry[],
    stage: string,
    lowerBoundExclusive: number,
    upperBoundExclusive: number
): TimelineEventEntry | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.sequence >= upperBoundExclusive) {
            continue;
        }
        if (entry.sequence <= lowerBoundExclusive) {
            break;
        }
        if (eventMatchesStage(entry, stage)) {
            return entry;
        }
    }
    return null;
}

/**
 * Find the latest REVIEW_RECORDED event for a given review key and return its review_context_path.
 */
export function findLatestRecordedReviewContextPath(
    events: readonly TimelineEventEntry[],
    reviewKey: string
): string | null {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const entry = events[index];
        if (entry.event_type !== 'REVIEW_RECORDED') {
            continue;
        }
        const recordedReviewType = String(entry.details?.review_type || entry.details?.reviewType || '').trim().toLowerCase();
        if (recordedReviewType !== reviewKey) {
            continue;
        }
        const reviewContextPath = String(entry.details?.review_context_path || entry.details?.reviewContextPath || '').trim();
        if (reviewContextPath) {
            return reviewContextPath;
        }
    }
    return null;
}
