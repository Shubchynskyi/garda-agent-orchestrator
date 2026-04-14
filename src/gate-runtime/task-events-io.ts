import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    applyAggregateRetentionAsync,
    applyAggregateRetentionSync,
    type AggregateAppendMode,
    type AggregateRetentionResult
} from './task-events-retention';
import {
    withFilesystemLock,
    withFilesystemLockAsync,
    type LockContentionLevel,
    type LockOptions
} from './task-events-locking';
import {
    assertValidTaskId,
    buildEventIntegrityHash,
    forEachJsonlLine,
    toTrimmedLowerCaseString,
    toTrimmedString
} from './task-events-helpers';

const TAIL_READ_CHUNK_SIZE = 4096;

export interface TaskEventAppendState {
    matching_events: number;
    parse_errors: number;
    last_integrity_sequence: number | null;
    last_event_sha256: string | null;
}

export interface AppendTaskEventOptions {
    actor?: string;
    passThru?: boolean;
    eventsRoot?: string;
    lockTimeoutMs?: unknown;
    lockRetryMs?: unknown;
    lockStaleMs?: unknown;
    allowForeignHostStaleRecovery?: unknown;
    preWriteDelayMs?: unknown;
    aggregateMaxLines?: unknown;
}

export interface TaskEventIntegrity {
    schema_version: number;
    task_sequence: number;
    prev_event_sha256: string | null;
    event_sha256?: string;
}

export interface TaskEvent {
    timestamp_utc: string;
    task_id: string;
    event_type: string;
    outcome: string;
    actor: string;
    message: string;
    details: unknown;
    integrity?: TaskEventIntegrity;
}

export interface AppendTaskEventResult {
    task_event_log_path: string;
    all_tasks_log_path: string;
    integrity: TaskEventIntegrity | null;
    warnings: string[];
    aggregate_retention?: AggregateRetentionResult;
    lock_telemetry?: {
        task_lock_retries: number;
        task_lock_elapsed_ms: number;
        task_lock_contention_level: LockContentionLevel;
        task_lock_stale_recovered: boolean;
        task_lock_stale_reason: 'owner_dead' | 'age_exceeded' | null;
        aggregate_lock_retries: number;
        aggregate_lock_elapsed_ms: number;
        aggregate_lock_contention_level: LockContentionLevel;
        aggregate_lock_stale_recovered: boolean;
        aggregate_lock_stale_reason: 'owner_dead' | 'age_exceeded' | null;
        aggregate_append_mode: AggregateAppendMode;
    };
}

interface TaskEventPaths {
    eventsRoot: string;
    taskFilePath: string;
    allTasksPath: string;
    taskLockPath: string;
    aggregateLockPath: string;
}

function toPositiveInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleepMsAsync(milliseconds: number): Promise<void> {
    if (!milliseconds || milliseconds <= 0) {
        return Promise.resolve();
    }
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function getErrorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
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
    const state: TaskEventAppendState = {
        matching_events: 0,
        parse_errors: 0,
        last_integrity_sequence: null,
        last_event_sha256: null
    };

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

function resolveTaskEventPaths(repoRoot: string, safeTaskId: string, eventsRoot?: string): TaskEventPaths {
    const resolvedEventsRoot = eventsRoot
        ? path.resolve(String(eventsRoot))
        : path.join(repoRoot, 'runtime', 'task-events');
    return {
        eventsRoot: resolvedEventsRoot,
        taskFilePath: path.join(resolvedEventsRoot, `${safeTaskId}.jsonl`),
        allTasksPath: path.join(resolvedEventsRoot, 'all-tasks.jsonl'),
        taskLockPath: path.join(resolvedEventsRoot, `.${safeTaskId}.lock`),
        aggregateLockPath: path.join(resolvedEventsRoot, '.all-tasks.lock')
    };
}

function createAppendResult(paths: TaskEventPaths): AppendTaskEventResult {
    return {
        task_event_log_path: paths.taskFilePath.replace(/\\/g, '/'),
        all_tasks_log_path: paths.allTasksPath.replace(/\\/g, '/'),
        integrity: null,
        warnings: [],
        lock_telemetry: {
            task_lock_retries: 0,
            task_lock_elapsed_ms: 0,
            task_lock_contention_level: 'none',
            task_lock_stale_recovered: false,
            task_lock_stale_reason: null,
            aggregate_lock_retries: 0,
            aggregate_lock_elapsed_ms: 0,
            aggregate_lock_contention_level: 'none',
            aggregate_lock_stale_recovered: false,
            aggregate_lock_stale_reason: null,
            aggregate_append_mode: 'lock_free'
        }
    };
}

function applyTaskLockTelemetry(result: AppendTaskEventResult, telemetry: {
    retries: number;
    elapsedMs: number;
    contentionLevel: LockContentionLevel;
    staleLockRecovered: boolean;
    staleLockReason: 'owner_dead' | 'age_exceeded' | null;
}): void {
    if (!result.lock_telemetry) {
        return;
    }
    result.lock_telemetry.task_lock_retries = telemetry.retries;
    result.lock_telemetry.task_lock_elapsed_ms = telemetry.elapsedMs;
    result.lock_telemetry.task_lock_contention_level = telemetry.contentionLevel;
    result.lock_telemetry.task_lock_stale_recovered = telemetry.staleLockRecovered;
    result.lock_telemetry.task_lock_stale_reason = telemetry.staleLockReason;
}

function applyAggregateLockTelemetry(
    result: AppendTaskEventResult,
    appendMode: AggregateAppendMode,
    telemetry?: {
        retries: number;
        elapsedMs: number;
        contentionLevel: LockContentionLevel;
        staleLockRecovered: boolean;
        staleLockReason: 'owner_dead' | 'age_exceeded' | null;
    }
): void {
    if (!result.lock_telemetry) {
        return;
    }
    result.lock_telemetry.aggregate_append_mode = appendMode;
    if (!telemetry) {
        return;
    }
    result.lock_telemetry.aggregate_lock_retries = telemetry.retries;
    result.lock_telemetry.aggregate_lock_elapsed_ms = telemetry.elapsedMs;
    result.lock_telemetry.aggregate_lock_contention_level = telemetry.contentionLevel;
    result.lock_telemetry.aggregate_lock_stale_recovered = telemetry.staleLockRecovered;
    result.lock_telemetry.aggregate_lock_stale_reason = telemetry.staleLockReason;
}

function updateTimelineSummaryBestEffort(eventsRoot: string, taskId: string): void {
    try {
        const { updateTimelineSummaryForTask } = require('./timeline-summary') as typeof import('./timeline-summary');
        updateTimelineSummaryForTask(eventsRoot, taskId, false);
    } catch {
        // Summary update failure is non-fatal.
    }
}

function appendTaskEventLineSync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent
): string {
    const appendState = readTaskEventAppendState(taskFilePath, taskId);
    const previousSequence = appendState.last_integrity_sequence;
    const previousHash = appendState.last_event_sha256;
    const nextSequence = typeof previousSequence === 'number'
        ? previousSequence + 1
        : appendState.matching_events + 1;

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
    const serializedLine = JSON.stringify(event);
    fs.appendFileSync(taskFilePath, serializedLine + '\n', 'utf8');
    return serializedLine;
}

async function appendTaskEventLineAsync(
    taskFilePath: string,
    taskId: string,
    event: TaskEvent,
    preWriteDelayMs: number
): Promise<string> {
    const appendState = readTaskEventAppendState(taskFilePath, taskId);
    const previousSequence = appendState.last_integrity_sequence;
    const previousHash = appendState.last_event_sha256;
    const nextSequence = typeof previousSequence === 'number'
        ? previousSequence + 1
        : appendState.matching_events + 1;

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
    const serializedLine = JSON.stringify(event);
    if (preWriteDelayMs > 0) {
        await sleepMsAsync(preWriteDelayMs);
    }
    fs.appendFileSync(taskFilePath, serializedLine + '\n', 'utf8');
    return serializedLine;
}

function buildAppendWarning(prefix: string, error: unknown): string {
    return `${prefix}: ${getErrorMessage(error)}`;
}

export function appendTaskEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AppendTaskEventOptions = {}
): AppendTaskEventResult | null {
    const actor = options.actor || 'gate';
    const passThru = options.passThru || false;

    if (!taskId) {
        return null;
    }

    const safeTaskId = assertValidTaskId(taskId);
    const paths = resolveTaskEventPaths(repoRoot, safeTaskId, options.eventsRoot);
    const lockOptions: LockOptions = {
        timeoutMs: options.lockTimeoutMs,
        retryMs: options.lockRetryMs,
        staleMs: options.lockStaleMs,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    };
    const event: TaskEvent = {
        timestamp_utc: new Date().toISOString(),
        task_id: safeTaskId,
        event_type: eventType,
        outcome,
        actor,
        message,
        details
    };
    const result = createAppendResult(paths);
    let line: string | null = null;

    try {
        fs.mkdirSync(paths.eventsRoot, { recursive: true });

        const taskLockResult = withFilesystemLock(paths.taskLockPath, lockOptions, function (): void {
            line = appendTaskEventLineSync(paths.taskFilePath, safeTaskId, event);
            result.integrity = Object.assign({}, event.integrity);
        });
        applyTaskLockTelemetry(result, taskLockResult.telemetry);
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event append failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
        return passThru ? result : null;
    }

    try {
        fs.appendFileSync(paths.allTasksPath, (line || '') + '\n', 'utf8');
        applyAggregateLockTelemetry(result, 'lock_free');
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event aggregate append failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
    }

    try {
        const retentionResult = applyAggregateRetentionSync(
            paths.allTasksPath,
            paths.aggregateLockPath,
            options.aggregateMaxLines,
            lockOptions
        );
        if (retentionResult.retention) {
            result.aggregate_retention = retentionResult.retention;
        }
        applyAggregateLockTelemetry(result, retentionResult.appendMode, retentionResult.telemetry);
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event aggregate prune failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
    }

    updateTimelineSummaryBestEffort(paths.eventsRoot, safeTaskId);
    return passThru ? result : null;
}

export async function appendTaskEventAsync(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AppendTaskEventOptions = {}
): Promise<AppendTaskEventResult | null> {
    const actor = options.actor || 'gate';
    const passThru = options.passThru || false;

    if (!taskId) {
        return null;
    }

    const safeTaskId = assertValidTaskId(taskId);
    const paths = resolveTaskEventPaths(repoRoot, safeTaskId, options.eventsRoot);
    const lockOptions: LockOptions = {
        timeoutMs: options.lockTimeoutMs,
        retryMs: options.lockRetryMs,
        staleMs: options.lockStaleMs,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    };
    const event: TaskEvent = {
        timestamp_utc: new Date().toISOString(),
        task_id: safeTaskId,
        event_type: eventType,
        outcome,
        actor,
        message,
        details
    };
    const result = createAppendResult(paths);
    let line: string | null = null;

    try {
        fs.mkdirSync(paths.eventsRoot, { recursive: true });

        const taskLockResult = await withFilesystemLockAsync(paths.taskLockPath, lockOptions, async function (): Promise<void> {
            const preWriteDelayMs = toPositiveInteger(options.preWriteDelayMs, 0);
            line = await appendTaskEventLineAsync(paths.taskFilePath, safeTaskId, event, preWriteDelayMs);
            result.integrity = Object.assign({}, event.integrity);
        });
        applyTaskLockTelemetry(result, taskLockResult.telemetry);
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event append failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
        return passThru ? result : null;
    }

    try {
        fs.appendFileSync(paths.allTasksPath, (line || '') + '\n', 'utf8');
        applyAggregateLockTelemetry(result, 'lock_free');
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event aggregate append failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
    }

    try {
        const retentionResult = await applyAggregateRetentionAsync(
            paths.allTasksPath,
            paths.aggregateLockPath,
            options.aggregateMaxLines,
            lockOptions
        );
        if (retentionResult.retention) {
            result.aggregate_retention = retentionResult.retention;
        }
        applyAggregateLockTelemetry(result, retentionResult.appendMode, retentionResult.telemetry);
    } catch (error: unknown) {
        const warning = buildAppendWarning('task-event aggregate prune failed', error);
        result.warnings.push(warning);
        process.stderr.write(`WARNING: ${warning}\n`);
    }

    updateTimelineSummaryBestEffort(paths.eventsRoot, safeTaskId);
    return passThru ? result : null;
}

export function appendMandatoryTaskEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AppendTaskEventOptions = {}
): AppendTaskEventResult {
    const result = appendTaskEvent(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            ...options,
            passThru: true
        }
    );

    if (!result) {
        throw new Error(`Mandatory lifecycle event '${eventType}' append failed without diagnostics.`);
    }
    if (result.warnings.length > 0) {
        throw new Error(`Mandatory lifecycle event '${eventType}' append failed: ${result.warnings.join(' | ')}`);
    }
    return result;
}

export async function appendMandatoryTaskEventAsync(
    repoRoot: string,
    taskId: string,
    eventType: string,
    outcome: string,
    message: string,
    details: unknown,
    options: AppendTaskEventOptions = {}
): Promise<AppendTaskEventResult> {
    const result = await appendTaskEventAsync(
        repoRoot,
        taskId,
        eventType,
        outcome,
        message,
        details,
        {
            ...options,
            passThru: true
        }
    );

    if (!result) {
        throw new Error(`Mandatory lifecycle event '${eventType}' append failed without diagnostics.`);
    }
    if (result.warnings.length > 0) {
        throw new Error(`Mandatory lifecycle event '${eventType}' append failed: ${result.warnings.join(' | ')}`);
    }
    return result;
}
