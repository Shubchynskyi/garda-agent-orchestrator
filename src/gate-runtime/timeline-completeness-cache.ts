import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import {
    isTaskBoundFullSuiteValidationRequirement,
    validateTimelineCompleteness,
    type TimelineCompletenessResult
} from './lifecycle-events';

const CACHE_VERSION = 2;

/**
 * Persisted completeness summary for a single task timeline.
 * Used by status/doctor to avoid re-reading the full JSONL on every invocation.
 */
export interface TimelineCompletenessSummary {
    cache_version: number;
    task_id: string;
    timeline_size_bytes: number;
    timeline_mtime_ms: number;
    code_changed: boolean;
    full_suite_validation_required?: boolean;
    status: TimelineCompletenessResult['status'];
    events_found: string[];
    events_missing: string[];
    violations: string[];
}

/**
 * Derive the cache file path for a given timeline JSONL path.
 * Cache lives alongside the timeline: `<task-id>.completeness.json`.
 */
export function getCompletenessCachePath(timelinePath: string): string {
    const dir = path.dirname(timelinePath);
    const base = path.basename(timelinePath, '.jsonl');
    return path.join(dir, `${base}.completeness.json`);
}

/**
 * Read a cached completeness summary from disk.
 * Returns null if the file is missing, unreadable, or has an incompatible version.
 */
export function readCompletenessSummary(cachePath: string): TimelineCompletenessSummary | null {
    try {
        const resolved = path.resolve(cachePath);
        if (!fs.existsSync(resolved)) return null;
        const raw = fs.readFileSync(resolved, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.cache_version !== CACHE_VERSION) return null;
        if (typeof parsed.task_id !== 'string') return null;
        if (typeof parsed.timeline_size_bytes !== 'number') return null;
        if (typeof parsed.timeline_mtime_ms !== 'number') return null;
        if (typeof parsed.code_changed !== 'boolean') return null;
        if (typeof parsed.status !== 'string') return null;
        if (!Array.isArray(parsed.events_found)) return null;
        if (!Array.isArray(parsed.events_missing)) return null;
        if (!Array.isArray(parsed.violations)) return null;
        return parsed as unknown as TimelineCompletenessSummary;
    } catch {
        return null;
    }
}

/**
 * Write a completeness summary to disk atomically (write-rename).
 */
export function writeCompletenessSummary(cachePath: string, summary: TimelineCompletenessSummary): void {
    const resolved = path.resolve(cachePath);
    writeFileAtomically(resolved, JSON.stringify(summary, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

/**
 * Check whether a cached summary is still current for the given timeline file.
 * Staleness is determined by comparing file size and mtime.
 */
function normalizeCompletenessOptions(
    codeChangedOrOptions: boolean | { codeChanged: boolean; fullSuiteValidationEnabled?: boolean }
): { codeChanged: boolean; fullSuiteValidationEnabled: boolean } {
    if (typeof codeChangedOrOptions === 'boolean') {
        return {
            codeChanged: codeChangedOrOptions,
            fullSuiteValidationEnabled: false
        };
    }
    return {
        codeChanged: codeChangedOrOptions.codeChanged,
        fullSuiteValidationEnabled: codeChangedOrOptions.fullSuiteValidationEnabled === true
    };
}

export function isCompletenessSummaryCurrent(
    summary: TimelineCompletenessSummary,
    timelinePath: string,
    codeChangedOrOptions: boolean | { codeChanged: boolean; fullSuiteValidationEnabled?: boolean }
): boolean {
    const options = normalizeCompletenessOptions(codeChangedOrOptions);
    try {
        const resolved = path.resolve(timelinePath);
        const stat = fs.statSync(resolved);
        if (!stat.isFile()) return false;
        if (stat.size !== summary.timeline_size_bytes) return false;
        if (Math.floor(stat.mtimeMs) !== summary.timeline_mtime_ms) return false;
        if (options.codeChanged !== summary.code_changed) return false;
        if (
            !isTaskBoundFullSuiteValidationRequirement(summary.events_found, summary.status)
            && (summary.full_suite_validation_required === true) !== options.fullSuiteValidationEnabled
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * Validate timeline completeness using the cache when available.
 * Falls back to a full JSONL re-read when the cache is missing or stale,
 * then persists the updated summary for future calls.
 */
export function validateTimelineCompletenessWithCache(
    timelinePath: string,
    taskId: string,
    codeChangedOrOptions: boolean | { codeChanged: boolean; fullSuiteValidationEnabled?: boolean },
    readOnly: boolean = false
): TimelineCompletenessResult {
    const options = normalizeCompletenessOptions(codeChangedOrOptions);
    const cachePath = getCompletenessCachePath(timelinePath);
    const cached = readCompletenessSummary(cachePath);

    if (cached && cached.task_id === taskId && isCompletenessSummaryCurrent(cached, timelinePath, options)) {
        const result: TimelineCompletenessResult = {
            task_id: cached.task_id,
            timeline_path: timelinePath.replace(/\\/g, '/'),
            timeline_exists: true,
            events_found: cached.events_found.slice(),
            events_missing: cached.events_missing.slice(),
            status: cached.status,
            violations: cached.violations.slice(),
            full_suite_validation_required: cached.full_suite_validation_required === true
        };
        return result;
    }

    // Snapshot file metadata BEFORE the full read to avoid TOCTOU cache poisoning
    let preReadSize: number | null = null;
    let preReadMtimeMs: number | null = null;
    try {
        const resolved = path.resolve(timelinePath);
        const preStat = fs.statSync(resolved);
        if (preStat.isFile()) {
            preReadSize = preStat.size;
            preReadMtimeMs = Math.floor(preStat.mtimeMs);
        }
    } catch {
        // Timeline may not exist; validateTimelineCompleteness handles that
    }

    const result = validateTimelineCompleteness(timelinePath, taskId, options);

    // Persist cache only when allowed, the timeline was actually readable,
    // and file metadata hasn't changed between pre-read snapshot and post-read check.
    // Skip caching when the file exists but read failed (status stays MISSING_TIMELINE).
    // readOnly=true prevents writes so read-only commands (status, doctor) honour their contract.
    if (!readOnly && result.timeline_exists && result.status !== 'MISSING_TIMELINE' && preReadSize !== null && preReadMtimeMs !== null) {
        try {
            const resolved = path.resolve(timelinePath);
            const postStat = fs.statSync(resolved);
            if (postStat.size === preReadSize && Math.floor(postStat.mtimeMs) === preReadMtimeMs) {
                const summary: TimelineCompletenessSummary = {
                    cache_version: CACHE_VERSION,
                    task_id: taskId,
                    timeline_size_bytes: preReadSize,
                    timeline_mtime_ms: preReadMtimeMs,
                    code_changed: options.codeChanged,
                    full_suite_validation_required: options.fullSuiteValidationEnabled === true ? true : undefined,
                    status: result.status,
                    events_found: result.events_found.slice(),
                    events_missing: result.events_missing.slice(),
                    violations: result.violations.slice()
                };
                writeCompletenessSummary(cachePath, summary);
            }
            // If post-read metadata differs, skip caching to avoid poisoning
        } catch {
            // Cache write failure is non-fatal; next call will re-read
        }
    }

    return result;
}
