import type { LockContentionLevel, LockWaitDiagnostics, LockWaitEntry } from '../task-events-locking-types';

export function pickHigherContention(a: LockContentionLevel, b: LockContentionLevel): LockContentionLevel {
    const order: LockContentionLevel[] = ['none', 'low', 'moderate', 'high'];
    return order.indexOf(a) >= order.indexOf(b) ? a : b;
}

export function buildLockWaitSummary(entry: LockWaitEntry, label: string): string {
    if (entry.contention_level === 'none') return '';
    const parts = [`${label}: contention_level=${entry.contention_level}, retries=${entry.retries}, elapsed_ms=${entry.elapsed_ms}`];
    if (entry.stale_recovered) {
        parts.push(`stale_recovered=true (${entry.stale_reason || 'unknown'})`);
    }
    return parts.join(', ');
}

export function buildLockWaitDiagnostics(lockTelemetry: {
    task_lock_retries?: number;
    task_lock_elapsed_ms?: number;
    task_lock_contention_level?: LockContentionLevel;
    task_lock_stale_recovered?: boolean;
    task_lock_stale_reason?: 'owner_dead' | 'age_exceeded' | null;
    aggregate_lock_retries?: number;
    aggregate_lock_elapsed_ms?: number;
    aggregate_lock_contention_level?: LockContentionLevel;
    aggregate_lock_stale_recovered?: boolean;
    aggregate_lock_stale_reason?: 'owner_dead' | 'age_exceeded' | null;
    aggregate_append_mode?: 'lock_free' | 'locked' | 'locked_prune';
} | null | undefined): LockWaitDiagnostics {
    const taskLock: LockWaitEntry = {
        retries: lockTelemetry?.task_lock_retries ?? 0,
        elapsed_ms: lockTelemetry?.task_lock_elapsed_ms ?? 0,
        contention_level: lockTelemetry?.task_lock_contention_level ?? 'none',
        stale_recovered: lockTelemetry?.task_lock_stale_recovered ?? false,
        stale_reason: lockTelemetry?.task_lock_stale_reason ?? null
    };

    const aggregateLock: LockWaitEntry = {
        retries: lockTelemetry?.aggregate_lock_retries ?? 0,
        elapsed_ms: lockTelemetry?.aggregate_lock_elapsed_ms ?? 0,
        contention_level: lockTelemetry?.aggregate_lock_contention_level ?? 'none',
        stale_recovered: lockTelemetry?.aggregate_lock_stale_recovered ?? false,
        stale_reason: lockTelemetry?.aggregate_lock_stale_reason ?? null
    };

    const overallLevel = pickHigherContention(taskLock.contention_level, aggregateLock.contention_level);

    const summaryParts: string[] = [];
    const taskSummary = buildLockWaitSummary(taskLock, 'task_lock');
    if (taskSummary) summaryParts.push(taskSummary);
    const aggregateSummary = buildLockWaitSummary(aggregateLock, 'aggregate_lock');
    if (aggregateSummary) summaryParts.push(aggregateSummary);

    const summary = summaryParts.length > 0
        ? `Lock contention detected (overall=${overallLevel}): ${summaryParts.join('; ')}`
        : 'No lock contention detected.';

    return {
        task_lock: taskLock,
        aggregate_lock: aggregateLock,
        overall_contention_level: overallLevel,
        summary
    };
}
