import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    appendAggregateEventAsync,
    appendAggregateEventSync
} from './task-events-retention';
import {
    withFilesystemLock,
    withFilesystemLockAsync,
    type LockOptions
} from './task-events-locking';
import { assertValidTaskId } from './task-events-helpers';
import { createTaskEventPublicRecord } from './task-event-public-contract';
import { redactSecretText, redactSensitiveData } from '../core/redaction';
import { isLowNoiseRuntimeWritesEnabled } from './derived-runtime-writes';
import {
    appendTaskEventLineAsync,
    appendTaskEventLineSync,
    toPositiveInteger
} from './task-events-io-write';
import { refreshTimelineSummaryForCommittedEvent } from './task-events-io-summary';
import {
    applyAggregateLockTelemetry,
    applyTaskLockTelemetry,
    assertMandatoryAppendCommitted,
    buildAppendWarning,
    createAppendResult,
    getBlockingTaskEventAppendWarnings,
    markTaskEventCommitted,
    markTaskEventSkippedDuplicate,
    recordDerivedAppendWarning,
    taskEventAppendHasBlockingFailure
} from './task-events-io-result';
import {
    readTaskEventAppendState,
    readTaskEventAppendStateFast
} from './task-events-io-index';
import type {
    AppendTaskEventOptions,
    AppendTaskEventResult,
    TaskEvent,
    TaskEventAppendState,
    TaskEventCommitStatus,
    TaskEventIntegrity,
    TaskEventPaths
} from './task-events-io-types';

export {
    getBlockingTaskEventAppendWarnings,
    readTaskEventAppendState,
    readTaskEventAppendStateFast,
    taskEventAppendHasBlockingFailure
};

export type {
    AppendTaskEventOptions,
    AppendTaskEventResult,
    TaskEvent,
    TaskEventAppendState,
    TaskEventCommitStatus,
    TaskEventIntegrity
};

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

function buildLockOptions(options: AppendTaskEventOptions): LockOptions {
    return {
        timeoutMs: options.lockTimeoutMs,
        retryMs: options.lockRetryMs,
        staleMs: options.lockStaleMs,
        allowForeignHostStaleRecovery: options.allowForeignHostStaleRecovery
    };
}

function createTaskEvent(
    safeTaskId: string,
    eventType: string,
    outcome: string,
    actor: string,
    message: string,
    details: unknown
): TaskEvent {
    return createTaskEventPublicRecord({
        timestamp_utc: new Date().toISOString(),
        task_id: safeTaskId,
        event_type: eventType,
        outcome,
        actor,
        message: redactSecretText(message),
        details: redactSensitiveData(details)
    }) as TaskEvent;
}

function shouldEmitOnce(value: unknown): boolean {
    return value === true || String(value || '').trim().toLowerCase() === 'true';
}

function handleAppendFailure(result: AppendTaskEventResult, warning: string, passThru: boolean): AppendTaskEventResult | null {
    result.warnings.push(warning);
    process.stderr.write(`WARNING: ${warning}\n`);
    return passThru ? result : null;
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
    const emitOnce = shouldEmitOnce(options.emitOnce);

    if (!taskId) {
        return null;
    }

    const safeTaskId = assertValidTaskId(taskId);
    const paths = resolveTaskEventPaths(repoRoot, safeTaskId, options.eventsRoot);
    const lockOptions = buildLockOptions(options);
    const event = createTaskEvent(safeTaskId, eventType, outcome, actor, message, details);
    const result = createAppendResult(paths);
    const lowNoiseRuntimeWrites = isLowNoiseRuntimeWritesEnabled(options);
    let line: string | null = null;

    try {
        fs.mkdirSync(paths.eventsRoot, { recursive: true });

        const taskLockResult = withFilesystemLock(paths.taskLockPath, lockOptions, function (): void {
            line = appendTaskEventLineSync(paths.taskFilePath, safeTaskId, event, emitOnce);
            if (line == null) {
                markTaskEventSkippedDuplicate(result);
                return;
            }
            markTaskEventCommitted(result, event);
        });
        applyTaskLockTelemetry(result, taskLockResult.telemetry);
    } catch (error: unknown) {
        return handleAppendFailure(result, buildAppendWarning('task-event append failed', error), passThru);
    }

    if (result.skipped_reason === 'emit_once_duplicate') {
        return passThru ? result : null;
    }

    if (lowNoiseRuntimeWrites) {
        applyAggregateLockTelemetry(result, 'skipped_low_noise');
    } else {
        try {
            const retentionResult = appendAggregateEventSync(
                paths.allTasksPath,
                paths.aggregateLockPath,
                line || '',
                options.aggregateMaxLines,
                lockOptions
            );
            if (retentionResult.retention) {
                result.aggregate_retention = retentionResult.retention;
            }
            applyAggregateLockTelemetry(result, retentionResult.appendMode, retentionResult.telemetry);
        } catch (error: unknown) {
            const warning = buildAppendWarning('task-event aggregate append/prune failed', error);
            recordDerivedAppendWarning(result, warning);
            process.stderr.write(`WARNING: ${warning}\n`);
        }
    }

    if (!lowNoiseRuntimeWrites) {
        refreshTimelineSummaryForCommittedEvent(result, paths.eventsRoot, safeTaskId, event);
    }
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
    const emitOnce = shouldEmitOnce(options.emitOnce);

    if (!taskId) {
        return null;
    }

    const safeTaskId = assertValidTaskId(taskId);
    const paths = resolveTaskEventPaths(repoRoot, safeTaskId, options.eventsRoot);
    const lockOptions = buildLockOptions(options);
    const event = createTaskEvent(safeTaskId, eventType, outcome, actor, message, details);
    const result = createAppendResult(paths);
    const lowNoiseRuntimeWrites = isLowNoiseRuntimeWritesEnabled(options);
    let line: string | null = null;

    try {
        fs.mkdirSync(paths.eventsRoot, { recursive: true });

        const taskLockResult = await withFilesystemLockAsync(paths.taskLockPath, lockOptions, async function (): Promise<void> {
            const preWriteDelayMs = toPositiveInteger(options.preWriteDelayMs, 0);
            line = await appendTaskEventLineAsync(paths.taskFilePath, safeTaskId, event, preWriteDelayMs, emitOnce);
            if (line == null) {
                markTaskEventSkippedDuplicate(result);
                return;
            }
            markTaskEventCommitted(result, event);
        });
        applyTaskLockTelemetry(result, taskLockResult.telemetry);
    } catch (error: unknown) {
        return handleAppendFailure(result, buildAppendWarning('task-event append failed', error), passThru);
    }

    if (result.skipped_reason === 'emit_once_duplicate') {
        return passThru ? result : null;
    }

    if (lowNoiseRuntimeWrites) {
        applyAggregateLockTelemetry(result, 'skipped_low_noise');
    } else {
        try {
            const retentionResult = await appendAggregateEventAsync(
                paths.allTasksPath,
                paths.aggregateLockPath,
                line || '',
                options.aggregateMaxLines,
                lockOptions
            );
            if (retentionResult.retention) {
                result.aggregate_retention = retentionResult.retention;
            }
            applyAggregateLockTelemetry(result, retentionResult.appendMode, retentionResult.telemetry);
        } catch (error: unknown) {
            const warning = buildAppendWarning('task-event aggregate append/prune failed', error);
            recordDerivedAppendWarning(result, warning);
            process.stderr.write(`WARNING: ${warning}\n`);
        }
    }

    if (!lowNoiseRuntimeWrites) {
        refreshTimelineSummaryForCommittedEvent(result, paths.eventsRoot, safeTaskId, event);
    }
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
    assertMandatoryAppendCommitted(result, eventType);
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
    assertMandatoryAppendCommitted(result, eventType);
    return result;
}
