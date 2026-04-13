import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    validateTimelineCompleteness,
    type TimelineCompletenessResult
} from './lifecycle-events';
import { inspectTaskEventFile } from './task-events';

const SUMMARY_VERSION = 1;
const SUMMARY_FILE_NAME = '.timeline-summary.json';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TimelineSummaryEntry {
    task_id: string;
    file_size_bytes: number;
    file_mtime_ms: number;
    code_changed: boolean;
    completeness_status: TimelineCompletenessResult['status'];
    events_found: string[];
    events_missing: string[];
    completeness_violations: string[];
    integrity_status: string;
    events_scanned: number;
    integrity_event_count: number;
    integrity_violations: string[];
    /** Epoch-ms when this entry was last written; enables freshness comparison under concurrent writers. */
    written_at_ms?: number;
}

export interface TimelineSummaryIndex {
    version: number;
    updated_at_utc: string;
    entries: Record<string, TimelineSummaryEntry>;
}

interface TimelineSummaryTestHooks {
    afterWrite?: (eventsRoot: string, taskId: string, entry: TimelineSummaryEntry, attempt: number) => void;
}

let timelineSummaryTestHooks: TimelineSummaryTestHooks | null = null;

// Test-only hook for deterministic race simulation; no production callers should use this.
export function __setTimelineSummaryTestHooks(hooks: TimelineSummaryTestHooks | null): void {
    timelineSummaryTestHooks = hooks;
}

// ---------------------------------------------------------------------------
// Collected results for status and doctor consumers
// ---------------------------------------------------------------------------

export interface StatusTimelineSummary {
    taskCount: number;
    healthy: number;
    warnings: string[];
}

export interface DoctorTimelineEvidence {
    task_id: string;
    timeline_path: string;
    status: string;
    completeness_status: string;
    events_missing: string[];
    code_changed: boolean;
    events_scanned: number;
    integrity_event_count: number;
    violations: string[];
}

export interface DoctorTimelineSummary {
    evidence: DoctorTimelineEvidence[];
    warnings: string[];
}

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

export function getTimelineSummaryPath(eventsRoot: string): string {
    return path.join(eventsRoot, SUMMARY_FILE_NAME);
}

// ---------------------------------------------------------------------------
// Read / Write
// ---------------------------------------------------------------------------

export function readTimelineSummaryIndex(eventsRoot: string): TimelineSummaryIndex | null {
    try {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        if (!fs.existsSync(summaryPath)) return null;
        const raw = fs.readFileSync(summaryPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (parsed.version !== SUMMARY_VERSION) return null;
        if (typeof parsed.updated_at_utc !== 'string') return null;
        if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) return null;
        return parsed as unknown as TimelineSummaryIndex;
    } catch {
        return null;
    }
}

export function writeTimelineSummaryIndex(eventsRoot: string, index: TimelineSummaryIndex): void {
    const summaryPath = getTimelineSummaryPath(eventsRoot);
    const randomSuffix = Math.random().toString(16).slice(2, 10);
    const tmpPath = summaryPath + '.' + process.pid + '.' + randomSuffix + '.tmp';
    try {
        fs.writeFileSync(tmpPath, JSON.stringify(index, null, 2) + '\n', 'utf8');
        fs.renameSync(tmpPath, summaryPath);
    } finally {
        // Clean up tmp file if rename failed or was skipped
        try { fs.unlinkSync(tmpPath); } catch { /* already renamed or missing */ }
    }
}

// ---------------------------------------------------------------------------
// Staleness check
// ---------------------------------------------------------------------------

export function isTimelineSummaryEntryCurrent(
    entry: TimelineSummaryEntry,
    timelinePath: string
): boolean {
    try {
        const stat = fs.statSync(path.resolve(timelinePath));
        if (!stat.isFile()) return false;
        if (stat.size !== entry.file_size_bytes) return false;
        if (Math.floor(stat.mtimeMs) !== entry.file_mtime_ms) return false;
        return true;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Build a fresh entry for a single task (used by write-side)
// ---------------------------------------------------------------------------

export function buildTimelineSummaryEntry(
    timelinePath: string,
    taskId: string,
    codeChanged: boolean
): TimelineSummaryEntry | null {
    let preStat: fs.Stats;
    try {
        preStat = fs.statSync(path.resolve(timelinePath));
        if (!preStat.isFile()) return null;
    } catch {
        return null;
    }

    const completeness = validateTimelineCompleteness(timelinePath, taskId, codeChanged);
    const inspect = inspectTaskEventFile(timelinePath, taskId);

    // Re-stat after read to detect concurrent modification
    let postStat: fs.Stats;
    try {
        postStat = fs.statSync(path.resolve(timelinePath));
    } catch {
        return null;
    }

    if (postStat.size !== preStat.size || Math.floor(postStat.mtimeMs) !== Math.floor(preStat.mtimeMs)) {
        return null;
    }

    return {
        task_id: taskId,
        file_size_bytes: preStat.size,
        file_mtime_ms: Math.floor(preStat.mtimeMs),
        code_changed: codeChanged,
        completeness_status: completeness.status,
        events_found: completeness.events_found.slice(),
        events_missing: completeness.events_missing.slice(),
        completeness_violations: completeness.violations.slice(),
        integrity_status: inspect.status,
        events_scanned: inspect.events_scanned,
        integrity_event_count: inspect.integrity_event_count,
        integrity_violations: inspect.violations.slice(),
        written_at_ms: Date.now()
    };
}

// ---------------------------------------------------------------------------
// Write-side: update a single task entry in the aggregate summary.
// Called after appendTaskEvent, best-effort. Not under any lock—
// concurrent writers may race; a single optimistic retry resolves
// the most common two-writer overlap, falling back to the stale entry
// that readers already handle gracefully.
// ---------------------------------------------------------------------------

export function updateTimelineSummaryForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): void {
    // When codeChanged is not provided, auto-detect from the preflight
    // artifact so the write-side uses the same logic as the read-side
    // (collectTimelineSummaryForStatus / collectTimelineSummaryForDoctor).
    const bundlePath = path.resolve(eventsRoot, '..', '..');
    const effectiveCodeChanged = typeof codeChanged === 'boolean'
        ? codeChanged
        : detectCodeChangedFromPreflight(bundlePath, taskId);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const entry = buildTimelineSummaryEntry(timelinePath, taskId, effectiveCodeChanged);
    if (!entry) return;

    mergeEntryWithRetry(eventsRoot, taskId, entry);
}

const MAX_MERGE_ATTEMPTS = 2;

function mergeEntryWithRetry(
    eventsRoot: string,
    taskId: string,
    entry: TimelineSummaryEntry
): void {
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
        let index = readTimelineSummaryIndex(eventsRoot);
        if (!index) {
            index = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {}
            };
        }

        // Skip write if existing entry is already at least as fresh
        const existing = index.entries[taskId];
        if (
            existing &&
            existing.written_at_ms &&
            entry.written_at_ms &&
            existing.written_at_ms >= entry.written_at_ms &&
            existing.file_size_bytes === entry.file_size_bytes &&
            existing.file_mtime_ms === entry.file_mtime_ms
        ) {
            return;
        }

        index.entries[taskId] = entry;
        index.updated_at_utc = new Date().toISOString();

        try {
            writeTimelineSummaryIndex(eventsRoot, index);
        } catch {
            // Write failed (e.g. EPERM contention on Windows) — best-effort, skip
            return;
        }
        timelineSummaryTestHooks?.afterWrite?.(eventsRoot, taskId, entry, attempt);

        // Verify our entry persisted (another writer may have clobbered it)
        const verification = readTimelineSummaryIndex(eventsRoot);
        if (verification?.entries[taskId]?.written_at_ms === entry.written_at_ms) {
            return; // Success — our entry is present
        }
        // Entry was clobbered; retry with fresh state on next iteration
    }
    // Exhausted retries — best-effort contract: stale entry is acceptable
}

// ---------------------------------------------------------------------------
// Read-side helpers (no writes)
// ---------------------------------------------------------------------------

function listTimelineJsonlFiles(eventsRoot: string): string[] {
    try {
        return fs.readdirSync(eventsRoot).filter(
            (name: string) => name.endsWith('.jsonl') && name !== 'all-tasks.jsonl'
        );
    } catch {
        return [];
    }
}

function detectCodeChangedFromPreflight(bundlePath: string, taskId: string): boolean {
    const preflightPath = path.join(bundlePath, 'runtime', 'reviews', `${taskId}-preflight.json`);
    try {
        if (!fs.existsSync(preflightPath)) return false;
        const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const metrics = parsed.metrics && typeof parsed.metrics === 'object' && !Array.isArray(parsed.metrics)
            ? parsed.metrics as Record<string, unknown>
            : null;
        if (metrics && typeof metrics.changed_lines_total === 'number' && metrics.changed_lines_total > 0) {
            return true;
        }
        return Array.isArray(parsed.changed_files) && parsed.changed_files.length > 0;
    } catch {
        return false;
    }
}

// ---------------------------------------------------------------------------
// Status read-side: collect timeline health summary.
// Read-only — never writes to disk.
// ---------------------------------------------------------------------------

export function collectTimelineSummaryForStatus(bundlePath: string): StatusTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    if (!fs.existsSync(eventsRoot)) {
        return { taskCount: 0, healthy: 0, warnings: [] };
    }

    const files = listTimelineJsonlFiles(eventsRoot);
    if (files.length === 0) {
        return { taskCount: 0, healthy: 0, warnings: [] };
    }

    const summary = readTimelineSummaryIndex(eventsRoot);
    let healthy = 0;
    const warnings: string[] = [];

    for (const fileName of files) {
        const taskId = fileName.replace(/\.jsonl$/i, '');
        const timelinePath = path.join(eventsRoot, fileName);
        const cached = summary?.entries[taskId] ?? null;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath)) {
            if (cached.completeness_status === 'COMPLETE') {
                healthy++;
            } else {
                warnings.push(
                    'Incomplete timeline: ' + fileName + ' (' + cached.events_missing.join(', ') + ')'
                );
            }
            continue;
        }

        // Stale or missing — fall back to per-file validation (read-only)
        try {
            const stat = fs.statSync(path.resolve(timelinePath));
            if (stat.isFile() && stat.size > 0) {
                const codeChanged = detectCodeChangedFromPreflight(bundlePath, taskId);
                const completeness = validateTimelineCompleteness(timelinePath, taskId, codeChanged);
                if (completeness.status === 'COMPLETE') {
                    healthy++;
                } else {
                    warnings.push(
                        'Incomplete timeline: ' + fileName + ' (' + completeness.events_missing.join(', ') + ')'
                    );
                }
            } else {
                warnings.push('Empty timeline: ' + fileName);
            }
        } catch {
            warnings.push('Unreadable timeline: ' + fileName);
        }
    }

    return { taskCount: files.length, healthy, warnings };
}

// ---------------------------------------------------------------------------
// Doctor read-side: collect detailed timeline evidence.
// Read-only — never writes to disk.
// ---------------------------------------------------------------------------

export function collectTimelineSummaryForDoctor(bundlePath: string): DoctorTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    if (!fs.existsSync(eventsRoot)) {
        return { evidence: [], warnings: [] };
    }

    const files = listTimelineJsonlFiles(eventsRoot);
    if (files.length === 0) {
        return { evidence: [], warnings: [] };
    }

    const summary = readTimelineSummaryIndex(eventsRoot);
    const evidence: DoctorTimelineEvidence[] = [];
    const warnings: string[] = [];

    for (const fileName of files) {
        const taskId = fileName.replace(/\.jsonl$/i, '');
        const timelinePath = path.join(eventsRoot, fileName);
        const cached = summary?.entries[taskId] ?? null;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath)) {
            const item: DoctorTimelineEvidence = {
                task_id: taskId,
                timeline_path: timelinePath.replace(/\\/g, '/'),
                status: cached.integrity_status,
                completeness_status: cached.completeness_status,
                events_missing: cached.events_missing.slice(),
                code_changed: cached.code_changed,
                events_scanned: cached.events_scanned,
                integrity_event_count: cached.integrity_event_count,
                violations: cached.integrity_violations.slice()
            };
            evidence.push(item);

            if (cached.integrity_status === 'FAILED') {
                warnings.push(
                    'Timeline integrity FAILED for ' + taskId + ': ' +
                    cached.integrity_violations.join('; ')
                );
            } else if (cached.integrity_status === 'EMPTY') {
                warnings.push('Timeline is EMPTY for ' + taskId + ': ' + timelinePath.replace(/\\/g, '/'));
            } else if (cached.completeness_status !== 'COMPLETE') {
                warnings.push(
                    'Timeline completeness ' + cached.completeness_status + ' for ' + taskId + ': ' +
                    cached.events_missing.join(', ')
                );
            }
            continue;
        }

        // Stale or missing — fall back to full validation (read-only)
        try {
            const codeChanged = detectCodeChangedFromPreflight(bundlePath, taskId);
            const inspectResult = inspectTaskEventFile(timelinePath, taskId);
            const completeness = validateTimelineCompleteness(timelinePath, taskId, codeChanged);

            const item: DoctorTimelineEvidence = {
                task_id: taskId,
                timeline_path: timelinePath.replace(/\\/g, '/'),
                status: inspectResult.status,
                completeness_status: completeness.status,
                events_missing: completeness.events_missing.slice(),
                code_changed: codeChanged,
                events_scanned: inspectResult.events_scanned,
                integrity_event_count: inspectResult.integrity_event_count,
                violations: inspectResult.violations.slice()
            };
            evidence.push(item);

            if (inspectResult.status === 'FAILED') {
                warnings.push(
                    'Timeline integrity FAILED for ' + taskId + ': ' +
                    inspectResult.violations.join('; ')
                );
            } else if (inspectResult.status === 'EMPTY') {
                warnings.push('Timeline is EMPTY for ' + taskId + ': ' + timelinePath.replace(/\\/g, '/'));
            } else if (completeness.status !== 'COMPLETE') {
                warnings.push(
                    'Timeline completeness ' + completeness.status + ' for ' + taskId + ': ' +
                    completeness.events_missing.join(', ')
                );
            }
        } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            warnings.push('Timeline scan error for ' + taskId + ': ' + msg);
        }
    }

    return { evidence, warnings };
}
