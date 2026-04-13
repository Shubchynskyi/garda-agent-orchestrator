import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    withFilesystemLock,
    withFilesystemLockAsync,
    type AcquireLockTelemetry,
    type LockOptions
} from './task-events-locking';

export const DEFAULT_AGGREGATE_MAX_LINES = 10000;
export const AGGREGATE_BYTES_PER_LINE_ESTIMATE = 512;
const AGGREGATE_PRUNE_CHUNK_SIZE = 64 * 1024;

export type AggregateAppendMode = 'lock_free' | 'locked_prune';

export interface AggregateRetentionResult {
    pruned: boolean;
    lines_before: number;
    lines_after: number;
}

export interface AggregateRetentionApplyResult {
    appendMode: AggregateAppendMode;
    retention?: AggregateRetentionResult;
    telemetry?: AcquireLockTelemetry;
}

function toNonNegativeInteger(value: unknown, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function countLinesStreaming(filePath: string): number {
    let fd: number;
    try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile() || stat.size === 0) return 0;
        fd = fs.openSync(filePath, 'r');
    } catch {
        return 0;
    }
    try {
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
        let count = 0;
        let lineHasContent = false;
        let position = 0;
        while (true) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 0x0A) {
                    if (lineHasContent) count++;
                    lineHasContent = false;
                } else {
                    lineHasContent = true;
                }
            }
            position += bytesRead;
        }
        if (lineHasContent) count++;
        return count;
    } finally {
        fs.closeSync(fd);
    }
}

export function pruneAggregateLog(
    allTasksPath: string,
    maxLines: number = DEFAULT_AGGREGATE_MAX_LINES,
    knownLineCount?: number
): AggregateRetentionResult {
    if (maxLines <= 0) {
        return { pruned: false, lines_before: 0, lines_after: 0 };
    }

    if (!fs.existsSync(allTasksPath)) {
        return { pruned: false, lines_before: 0, lines_after: 0 };
    }

    const linesBefore = knownLineCount ?? countLinesStreaming(allTasksPath);
    if (linesBefore <= maxLines) {
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }

    const linesToSkip = linesBefore - maxLines;

    let fd: number;
    try {
        fd = fs.openSync(allTasksPath, 'r');
    } catch {
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }

    try {
        const fileSize = fs.fstatSync(fd).size;
        const buf = Buffer.alloc(AGGREGATE_PRUNE_CHUNK_SIZE);
        let skipped = 0;
        let position = 0;
        let cutOffset = 0;
        let lineHasContent = false;

        outer:
        while (position < fileSize) {
            const bytesRead = fs.readSync(fd, buf, 0, buf.length, position);
            if (bytesRead === 0) break;
            for (let i = 0; i < bytesRead; i++) {
                if (buf[i] === 0x0A) {
                    if (lineHasContent) {
                        skipped++;
                        if (skipped >= linesToSkip) {
                            cutOffset = position + i + 1;
                            break outer;
                        }
                    }
                    lineHasContent = false;
                } else {
                    lineHasContent = true;
                }
            }
            position += bytesRead;
        }

        const tailSize = fileSize - cutOffset;
        if (tailSize <= 0) {
            fs.closeSync(fd);
            try {
                fs.writeFileSync(allTasksPath, '', 'utf8');
            } catch {
                return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
            }
            return { pruned: true, lines_before: linesBefore, lines_after: 0 };
        }

        const tail = Buffer.alloc(tailSize);
        fs.readSync(fd, tail, 0, tailSize, cutOffset);
        fs.closeSync(fd);

        try {
            fs.writeFileSync(allTasksPath, tail);
        } catch {
            return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
        }

        return { pruned: true, lines_before: linesBefore, lines_after: maxLines };
    } catch {
        try { fs.closeSync(fd); } catch { /* already closed or invalid */ }
        return { pruned: false, lines_before: linesBefore, lines_after: linesBefore };
    }
}

export function pruneAggregateLogLocked(
    eventsRoot: string,
    maxLines: number = DEFAULT_AGGREGATE_MAX_LINES,
    lockOptions: LockOptions = {}
): AggregateRetentionResult {
    const allTasksPath = path.join(eventsRoot, 'all-tasks.jsonl');
    const aggregateLockPath = path.join(eventsRoot, '.all-tasks.lock');
    const lockResult = withFilesystemLock(aggregateLockPath, lockOptions, function (): AggregateRetentionResult {
        return pruneAggregateLog(allTasksPath, maxLines);
    });
    return lockResult.result;
}

export function applyAggregateRetentionSync(
    allTasksPath: string,
    aggregateLockPath: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): AggregateRetentionApplyResult {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    if (resolvedMaxLines <= 0) {
        return { appendMode: 'lock_free' };
    }

    const aggregateSizeTrigger = resolvedMaxLines * AGGREGATE_BYTES_PER_LINE_ESTIMATE;
    try {
        const fileSize = fs.statSync(allTasksPath).size;
        if (fileSize <= aggregateSizeTrigger) {
            return { appendMode: 'lock_free' };
        }
    } catch {
        return { appendMode: 'lock_free' };
    }

    const lockResult = withFilesystemLock(aggregateLockPath, lockOptions, function (): AggregateRetentionResult {
        return pruneAggregateLog(allTasksPath, resolvedMaxLines);
    });
    return {
        appendMode: 'locked_prune',
        retention: lockResult.result,
        telemetry: lockResult.telemetry
    };
}

export async function applyAggregateRetentionAsync(
    allTasksPath: string,
    aggregateLockPath: string,
    maxLines: unknown,
    lockOptions: LockOptions = {}
): Promise<AggregateRetentionApplyResult> {
    const resolvedMaxLines = toNonNegativeInteger(maxLines, DEFAULT_AGGREGATE_MAX_LINES);
    if (resolvedMaxLines <= 0) {
        return { appendMode: 'lock_free' };
    }

    const aggregateSizeTrigger = resolvedMaxLines * AGGREGATE_BYTES_PER_LINE_ESTIMATE;
    try {
        const fileSize = fs.statSync(allTasksPath).size;
        if (fileSize <= aggregateSizeTrigger) {
            return { appendMode: 'lock_free' };
        }
    } catch {
        return { appendMode: 'lock_free' };
    }

    const lockResult = await withFilesystemLockAsync(aggregateLockPath, lockOptions, async function (): Promise<AggregateRetentionResult> {
        return pruneAggregateLog(allTasksPath, resolvedMaxLines);
    });
    return {
        appendMode: 'locked_prune',
        retention: lockResult.result,
        telemetry: lockResult.telemetry
    };
}
