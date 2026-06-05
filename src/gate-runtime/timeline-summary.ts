import * as fs from 'node:fs';
import * as path from 'node:path';
import { writeFileAtomically } from '../core/filesystem';
import {
    validateTimelineCompleteness,
    isTaskBoundFullSuiteValidationRequirement,
    type TimelineCompletenessResult
} from './lifecycle-events';
import { inspectTaskEventFile } from './task-events';
import { withFilesystemLock } from './task-events-locking';
import { detectCodeChanged } from '../gates/preflight/preflight-code-change';
import { loadFullSuiteValidationConfig } from '../gates/full-suite/full-suite-validation';
import { parseTaskIdJsonlFileName } from '../core/task-ids';

const SUMMARY_VERSION = 2;
const SUMMARY_FILE_NAME = '.timeline-summary.json';
const SUMMARY_LOCK_FILE_NAME = '.timeline-summary.lock';
const DEFAULT_SUMMARY_LOCK_TIMEOUT_MS = 500;
const DEFAULT_SUMMARY_LOCK_RETRY_MS = 25;
const DEFAULT_SUMMARY_LOCK_STALE_MS = 30 * 1000;

export interface TimelineSummaryEntry {
    task_id: string;
    file_size_bytes: number;
    file_mtime_ms: number;
    code_changed: boolean;
    full_suite_validation_required?: boolean;
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
    beforeMerge?: (eventsRoot: string, taskId: string, entry: TimelineSummaryEntry) => void;
    afterWrite?: (eventsRoot: string, taskId: string, entry: TimelineSummaryEntry, attempt: number) => void;
}

let timelineSummaryTestHooks: TimelineSummaryTestHooks | null = null;
const preflightCodeChangedCache = new Map<string, { file_size_bytes: number; file_mtime_ms: number; code_changed: boolean }>();

// Test-only hook for deterministic race simulation; no production callers should use this.
export function __setTimelineSummaryTestHooks(hooks: TimelineSummaryTestHooks | null): void {
    timelineSummaryTestHooks = hooks;
}

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

export function getTimelineSummaryPath(eventsRoot: string): string {
    return path.join(eventsRoot, SUMMARY_FILE_NAME);
}

export function getTimelineSummaryLockPath(eventsRoot: string): string {
    return path.join(eventsRoot, SUMMARY_LOCK_FILE_NAME);
}

function withTimelineSummaryLock<T>(eventsRoot: string, callback: () => T): T {
    const { result } = withFilesystemLock(getTimelineSummaryLockPath(eventsRoot), {
        timeoutMs: DEFAULT_SUMMARY_LOCK_TIMEOUT_MS,
        retryMs: DEFAULT_SUMMARY_LOCK_RETRY_MS,
        staleMs: DEFAULT_SUMMARY_LOCK_STALE_MS
    }, callback);
    return result;
}

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

function isFiniteNumber(value: unknown): value is number {
    return typeof value === 'number' && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isTimelineSummaryEntryLike(value: unknown): value is TimelineSummaryEntry {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return false;
    }
    const entry = value as Record<string, unknown>;
    return typeof entry.task_id === 'string'
        && isFiniteNumber(entry.file_size_bytes)
        && isFiniteNumber(entry.file_mtime_ms)
        && typeof entry.code_changed === 'boolean'
        && typeof entry.completeness_status === 'string'
        && isStringArray(entry.events_found)
        && isStringArray(entry.events_missing)
        && isStringArray(entry.completeness_violations)
        && typeof entry.integrity_status === 'string'
        && isFiniteNumber(entry.events_scanned)
        && isFiniteNumber(entry.integrity_event_count)
        && isStringArray(entry.integrity_violations)
        && (entry.written_at_ms === undefined || isFiniteNumber(entry.written_at_ms));
}

interface CleanupPruneSummaryIndex {
    index: TimelineSummaryIndex;
    dropped_invalid_entry_keys: string[];
}

function readTimelineSummaryIndexForCleanupPrune(eventsRoot: string): CleanupPruneSummaryIndex | null {
    const currentIndex = readTimelineSummaryIndex(eventsRoot);
    if (currentIndex) {
        return {
            index: currentIndex,
            dropped_invalid_entry_keys: []
        };
    }

    try {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        if (!fs.existsSync(summaryPath)) return null;
        const raw = fs.readFileSync(summaryPath, 'utf8');
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        if (!parsed.entries || typeof parsed.entries !== 'object' || Array.isArray(parsed.entries)) {
            return null;
        }

        const normalizedEntries: Record<string, TimelineSummaryEntry> = {};
        const droppedInvalidEntryKeys: string[] = [];
        for (const [taskId, entry] of Object.entries(parsed.entries as Record<string, unknown>)) {
            if (!isTimelineSummaryEntryLike(entry)) {
                droppedInvalidEntryKeys.push(taskId);
                continue;
            }
            normalizedEntries[taskId] = entry;
        }

        return {
            index: {
                version: SUMMARY_VERSION,
                updated_at_utc: typeof parsed.updated_at_utc === 'string'
                    ? parsed.updated_at_utc
                    : new Date().toISOString(),
                entries: normalizedEntries
            },
            dropped_invalid_entry_keys: droppedInvalidEntryKeys
        };
    } catch {
        return null;
    }
}

export function writeTimelineSummaryIndex(eventsRoot: string, index: TimelineSummaryIndex): void {
    const summaryPath = getTimelineSummaryPath(eventsRoot);
    writeFileAtomically(summaryPath, JSON.stringify(index, null, 2) + '\n', { encoding: 'utf8', fsync: false });
}

export function isTimelineSummaryEntryCurrent(
    entry: TimelineSummaryEntry,
    timelinePath: string,
    fullSuiteValidationEnabled: boolean = false
): boolean {
    try {
        const stat = fs.statSync(path.resolve(timelinePath));
        if (!stat.isFile()) return false;
        if (stat.size !== entry.file_size_bytes) return false;
        if (Math.floor(stat.mtimeMs) !== entry.file_mtime_ms) return false;
        if (
            !isTaskBoundFullSuiteValidationRequirement(entry.events_found, entry.completeness_status)
            && (entry.full_suite_validation_required === true) !== fullSuiteValidationEnabled
        ) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function buildTimelineSummaryEntry(
    timelinePath: string,
    taskId: string,
    codeChanged: boolean,
    fullSuiteValidationEnabled: boolean = false
): TimelineSummaryEntry | null {
    let preStat: fs.Stats;
    try {
        preStat = fs.statSync(path.resolve(timelinePath));
        if (!preStat.isFile()) return null;
    } catch {
        return null;
    }

    const completeness = validateTimelineCompleteness(timelinePath, taskId, {
        codeChanged,
        fullSuiteValidationEnabled
    });
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
        full_suite_validation_required: completeness.full_suite_validation_required === true ? true : undefined,
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

// Called after appendTaskEvent, best-effort. Summary mutations are
// serialized under a dedicated summary lock so append and cleanup do
// not clobber each other.
export function updateTimelineSummaryForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): void {
    // Prefer an explicit hint from the latest PREFLIGHT_CLASSIFIED event.
    // Otherwise reuse the current summary entry's stable code_changed bit
    // to avoid re-reading preflight JSON on every append, and only fall
    // back to preflight parsing when no summary entry exists yet.
    const effectiveCodeChanged = resolveEffectiveCodeChangedForTask(eventsRoot, taskId, codeChanged);
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(path.resolve(eventsRoot, '..', '..')).enabled;
    const entry = buildTimelineSummaryEntry(timelinePath, taskId, effectiveCodeChanged, fullSuiteValidationEnabled);
    if (!entry) return;

    timelineSummaryTestHooks?.beforeMerge?.(eventsRoot, taskId, entry);

    try {
        withTimelineSummaryLock(eventsRoot, () => {
            if (!isTimelineSummaryEntryCurrent(entry, timelinePath, fullSuiteValidationEnabled)) {
                return;
            }
            mergeEntryWithRetry(eventsRoot, taskId, entry);
        });
    } catch {
        // Lock contention or transient filesystem issues are best-effort only.
    }
}

function resolveEffectiveCodeChangedForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): boolean {
    if (typeof codeChanged === 'boolean') {
        return codeChanged;
    }
    const existingSummaryCodeChanged = readTimelineSummaryIndex(eventsRoot)?.entries?.[taskId]?.code_changed;
    if (typeof existingSummaryCodeChanged === 'boolean') {
        return existingSummaryCodeChanged;
    }
    const bundlePath = path.resolve(eventsRoot, '..', '..');
    return detectCodeChangedFromPreflight(bundlePath, taskId);
}

export function reconcileTimelineSummaryForTask(
    eventsRoot: string,
    taskId: string,
    codeChanged?: boolean
): void {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const summaryPath = getTimelineSummaryPath(eventsRoot);
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(path.resolve(eventsRoot, '..', '..')).enabled;
    withTimelineSummaryLock(eventsRoot, () => {
        const summaryFileExists = (() => {
            try {
                return fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile();
            } catch {
                return false;
            }
        })();
        let timelineExists = false;
        try {
            timelineExists = fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile();
        } catch {
            timelineExists = false;
        }

        if (!timelineExists) {
            const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
            if (summaryFileExists && !cleanupIndex) {
                throw new Error(`Unable to safely read existing timeline summary index before removing '${taskId}'.`);
            }
            const index = cleanupIndex?.index ?? null;
            if (!index || !Object.prototype.hasOwnProperty.call(index.entries, taskId)) {
                return;
            }
            delete index.entries[taskId];
            index.updated_at_utc = new Date().toISOString();
            writeTimelineSummaryIndex(eventsRoot, index);
            return;
        }

        const entry = buildTimelineSummaryEntry(
            timelinePath,
            taskId,
            resolveEffectiveCodeChangedForTask(eventsRoot, taskId, codeChanged),
            fullSuiteValidationEnabled
        );
        if (!entry) {
            throw new Error(`Unable to rebuild timeline summary entry for '${taskId}'.`);
        }

        const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
        if (summaryFileExists && !cleanupIndex) {
            throw new Error(`Unable to safely read existing timeline summary index before reconciling '${taskId}'.`);
        }
        let index = cleanupIndex?.index ?? null;
        if (!index) {
            index = {
                version: SUMMARY_VERSION,
                updated_at_utc: new Date().toISOString(),
                entries: {}
            };
        }
        index.entries[taskId] = entry;
        index.updated_at_utc = new Date().toISOString();
        writeTimelineSummaryIndex(eventsRoot, index);
    });
}

const MAX_MERGE_ATTEMPTS = 2;

function mergeEntryWithRetry(
    eventsRoot: string,
    taskId: string,
    entry: TimelineSummaryEntry
): void {
    for (let attempt = 0; attempt < MAX_MERGE_ATTEMPTS; attempt++) {
        const summaryPath = getTimelineSummaryPath(eventsRoot);
        const summaryFileExists = (() => {
            try {
                return fs.existsSync(summaryPath) && fs.statSync(summaryPath).isFile();
            } catch {
                return false;
            }
        })();
        const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
        if (summaryFileExists && !cleanupIndex) {
            return;
        }
        let index = cleanupIndex?.index ?? null;
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

export function pruneTimelineSummaryEntries(eventsRoot: string): void {
    if (!fs.existsSync(eventsRoot)) return;

    try {
        withTimelineSummaryLock(eventsRoot, () => {
            const cleanupIndex = readTimelineSummaryIndexForCleanupPrune(eventsRoot);
            if (!cleanupIndex) return;

            const { index, dropped_invalid_entry_keys: droppedInvalidEntryKeys } = cleanupIndex;
            const taskIds = Object.keys(index.entries);
            if (taskIds.length === 0 && droppedInvalidEntryKeys.length === 0) return;

            let pruned = droppedInvalidEntryKeys.length > 0;
            for (const taskId of taskIds) {
                const jsonlPath = path.join(eventsRoot, `${taskId}.jsonl`);
                if (!fs.existsSync(jsonlPath)) {
                    delete index.entries[taskId];
                    pruned = true;
                }
            }

            if (pruned) {
                index.updated_at_utc = new Date().toISOString();
                writeTimelineSummaryIndex(eventsRoot, index);
            }
        });
    } catch {
        // Cleanup-time summary pruning is also best-effort.
    }
}

function listTimelineJsonlFiles(eventsRoot: string): string[] {
    try {
        return fs.readdirSync(eventsRoot)
            .filter((name: string) => parseTaskIdJsonlFileName(name) !== null);
    } catch {
        return [];
    }
}

function detectCodeChangedFromPreflight(bundlePath: string, taskId: string): boolean {
    const preflightPath = path.join(bundlePath, 'runtime', 'reviews', `${taskId}-preflight.json`);
    try {
        if (!fs.existsSync(preflightPath)) return false;
        const stat = fs.statSync(preflightPath);
        if (!stat.isFile()) return false;
        const cached = preflightCodeChangedCache.get(preflightPath);
        const file_size_bytes = stat.size;
        const file_mtime_ms = Math.floor(stat.mtimeMs);
        if (cached && cached.file_size_bytes === file_size_bytes && cached.file_mtime_ms === file_mtime_ms) {
            return cached.code_changed;
        }
        const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
        const code_changed = detectCodeChanged(parsed, bundlePath);
        preflightCodeChangedCache.set(preflightPath, {
            file_size_bytes,
            file_mtime_ms,
            code_changed
        });
        return code_changed;
    } catch {
        return false;
    }
}

// Read-only — never writes to disk.
export function collectTimelineSummaryForStatus(bundlePath: string): StatusTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(bundlePath).enabled;
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
        const taskId = parseTaskIdJsonlFileName(fileName);
        if (!taskId) continue;
        const timelinePath = path.join(eventsRoot, fileName);
        const cached = summary?.entries[taskId] ?? null;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath, fullSuiteValidationEnabled)) {
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
                const completeness = validateTimelineCompleteness(timelinePath, taskId, {
                    codeChanged,
                    fullSuiteValidationEnabled
                });
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

// Read-only — never writes to disk.
export function collectTimelineSummaryForDoctor(bundlePath: string): DoctorTimelineSummary {
    const eventsRoot = path.join(bundlePath, 'runtime', 'task-events');
    const fullSuiteValidationEnabled = loadFullSuiteValidationConfig(bundlePath).enabled;
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
        const taskId = parseTaskIdJsonlFileName(fileName);
        if (!taskId) continue;
        const timelinePath = path.join(eventsRoot, fileName);
        const cached = summary?.entries[taskId] ?? null;

        if (cached && isTimelineSummaryEntryCurrent(cached, timelinePath, fullSuiteValidationEnabled)) {
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
            const completeness = validateTimelineCompleteness(timelinePath, taskId, {
                codeChanged,
                fullSuiteValidationEnabled
            });

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
