import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupStaleTaskEventLocks, scanTaskEventLocks } from '../gate-runtime/task-events';
import { LIFECYCLE_OPERATION_LOCK_DIR_NAME } from './lifecycle-lock';
import { removePathRecursive } from './generic-utils';
import type { CleanupItem, RetentionPolicy } from './cleanup-types';

export interface ProcessCleanupCandidatesResult {
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
}

function directoryEntries(dirPath: string): string[] {
    if (!fs.existsSync(dirPath)) return [];
    try {
        return fs.readdirSync(dirPath).sort();
    } catch {
        return [];
    }
}

function dirSizeBytes(dirPath: string): number {
    let total = 0;
    try {
        const entries = fs.readdirSync(dirPath, { withFileTypes: true });
        for (const entry of entries) {
            const fullPath = path.join(dirPath, entry.name);
            if (entry.isDirectory()) {
                total += dirSizeBytes(fullPath);
            } else {
                try {
                    total += fs.statSync(fullPath).size;
                } catch {
                    // unreadable file
                }
            }
        }
    } catch {
        // inaccessible dir
    }
    return total;
}

function fileSizeBytes(filePath: string): number {
    try {
        return fs.statSync(filePath).size;
    } catch {
        return 0;
    }
}

function fileMtimeMs(filePath: string): number {
    try {
        return fs.statSync(filePath).mtimeMs;
    } catch {
        return 0;
    }
}

function maxGroupMtime(dir: string, files: string[]): number {
    let max = 0;
    for (const file of files) {
        const mtime = fileMtimeMs(path.join(dir, file));
        if (mtime > max) max = mtime;
    }
    return max;
}

function isNotFoundError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT';
}

export function processCleanupCandidates(candidates: CleanupItem[], dryRun: boolean): ProcessCleanupCandidatesResult {
    const removed: CleanupItem[] = [];
    const skipped: CleanupItem[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    let totalFreedBytes = 0;

    for (const item of candidates) {
        if (dryRun) {
            skipped.push(item);
            totalFreedBytes += item.sizeBytes;
            continue;
        }

        if (!fs.existsSync(item.path)) {
            continue;
        }

        try {
            const stat = fs.statSync(item.path);
            if (stat.isDirectory()) {
                removePathRecursive(item.path);
            } else {
                fs.unlinkSync(item.path);
            }
            removed.push(item);
            totalFreedBytes += item.sizeBytes;
        } catch (error: unknown) {
            if (isNotFoundError(error)) continue;
            errors.push({
                path: item.path,
                message: error instanceof Error ? error.message : String(error)
            });
        }
    }

    return { removed, skipped, errors, totalFreedBytes };
}

function parseTimestampName(name: string): Date | null {
    const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-(\d{3})$/.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second, ms] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second), Number(ms));
}

function parseUpdateTimestampName(name: string): Date | null {
    const match = /^update-(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})$/.exec(name);
    if (!match) return null;
    const [, year, month, day, hour, minute, second] = match;
    return new Date(Number(year), Number(month) - 1, Number(day), Number(hour), Number(minute), Number(second));
}

function collectTimestampedDirs(dirPath: string, category: string, maxCount: number, maxAgeDays: number, now: Date): CleanupItem[] {
    const entries = directoryEntries(dirPath);
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
    const excessCount = Math.max(0, entries.length - maxCount);

    for (let i = 0; i < entries.length; i += 1) {
        const entryName = entries[i];
        const entryPath = path.join(dirPath, entryName);
        const entryDate = parseTimestampName(entryName);

        let reason: string | null = null;
        if (i < excessCount) {
            reason = 'count';
        } else if (entryDate && entryDate < cutoff) {
            reason = 'age';
        }

        if (reason) {
            const sizeBytes = fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory()
                ? dirSizeBytes(entryPath)
                : fileSizeBytes(entryPath);
            items.push({ path: entryPath, category, reason, sizeBytes });
        }
    }

    return items;
}

function collectUpdateNamedDirs(dirPath: string, category: string, maxCount: number, maxAgeDays: number, now: Date): CleanupItem[] {
    const entries = directoryEntries(dirPath);
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
    const excessCount = Math.max(0, entries.length - maxCount);

    for (let i = 0; i < entries.length; i += 1) {
        const entryName = entries[i];
        const entryPath = path.join(dirPath, entryName);
        const entryDate = parseUpdateTimestampName(entryName);

        let reason: string | null = null;
        if (i < excessCount) {
            reason = 'count';
        } else if (entryDate && entryDate < cutoff) {
            reason = 'age';
        }

        if (reason) {
            const isDir = fs.existsSync(entryPath) && fs.statSync(entryPath).isDirectory();
            const sizeBytes = isDir ? dirSizeBytes(entryPath) : fileSizeBytes(entryPath);
            items.push({ path: entryPath, category, reason, sizeBytes });
        }
    }

    return items;
}

function collectReviewArtifacts(reviewsDir: string, maxReviews: number, maxAgeDays: number, now: Date): CleanupItem[] {
    if (!fs.existsSync(reviewsDir)) return [];
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    let entries: string[];
    try {
        entries = fs.readdirSync(reviewsDir).sort();
    } catch {
        return [];
    }

    const taskGroups = new Map<string, string[]>();
    for (const entry of entries) {
        const match = /^(T-\d+)-/.exec(entry);
        if (match) {
            const taskId = match[1];
            const group = taskGroups.get(taskId) || [];
            group.push(entry);
            taskGroups.set(taskId, group);
        }
    }

    const sortedTaskIds = Array.from(taskGroups.keys()).sort((a, b) => {
        const mtimeA = maxGroupMtime(reviewsDir, taskGroups.get(a) || []);
        const mtimeB = maxGroupMtime(reviewsDir, taskGroups.get(b) || []);
        if (mtimeA !== mtimeB) return mtimeA - mtimeB;
        return parseInt(a.replace('T-', ''), 10) - parseInt(b.replace('T-', ''), 10);
    });

    const excessTaskCount = Math.max(0, sortedTaskIds.length - maxReviews);

    for (let i = 0; i < excessTaskCount; i += 1) {
        const taskId = sortedTaskIds[i];
        const files = taskGroups.get(taskId) || [];
        for (const file of files) {
            const filePath = path.join(reviewsDir, file);
            items.push({ path: filePath, category: 'reviews', reason: 'count', sizeBytes: fileSizeBytes(filePath) });
        }
    }

    for (let i = excessTaskCount; i < sortedTaskIds.length; i += 1) {
        const taskId = sortedTaskIds[i];
        const files = taskGroups.get(taskId) || [];
        for (const file of files) {
            const filePath = path.join(reviewsDir, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.mtime < cutoff) {
                    items.push({ path: filePath, category: 'reviews', reason: 'age', sizeBytes: stat.size });
                }
            } catch {
                // Skip unreadable
            }
        }
    }

    return items;
}

function collectTaskEventFiles(eventsDir: string, maxTaskEvents: number, maxAgeDays: number, now: Date): CleanupItem[] {
    if (!fs.existsSync(eventsDir)) return [];
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    let entries: string[];
    try {
        entries = fs.readdirSync(eventsDir).filter((entry) => entry.endsWith('.jsonl') && entry !== 'all-tasks.jsonl');
    } catch {
        return [];
    }

    entries.sort((a, b) => {
        const mtimeA = fileMtimeMs(path.join(eventsDir, a));
        const mtimeB = fileMtimeMs(path.join(eventsDir, b));
        if (mtimeA !== mtimeB) return mtimeA - mtimeB;
        return a.localeCompare(b);
    });

    const excessCount = Math.max(0, entries.length - maxTaskEvents);

    for (let i = 0; i < entries.length; i += 1) {
        const entryName = entries[i];
        const entryPath = path.join(eventsDir, entryName);

        let reason: string | null = null;
        if (i < excessCount) {
            reason = 'count';
        } else {
            try {
                const stat = fs.statSync(entryPath);
                if (stat.mtime < cutoff) {
                    reason = 'age';
                }
            } catch {
                // Skip
            }
        }

        if (reason) {
            items.push({ path: entryPath, category: 'task-events', reason, sizeBytes: fileSizeBytes(entryPath) });
            const cacheName = entryName.replace(/\.jsonl$/, '.completeness.json');
            const cachePath = path.join(eventsDir, cacheName);
            if (fs.existsSync(cachePath)) {
                items.push({ path: cachePath, category: 'task-events', reason, sizeBytes: fileSizeBytes(cachePath) });
            }
        }
    }

    try {
        const cacheEntries = fs.readdirSync(eventsDir).filter((entry) => entry.endsWith('.completeness.json'));
        const timelineSet = new Set(entries);
        for (const cacheName of cacheEntries) {
            const timelineName = cacheName.replace(/\.completeness\.json$/, '.jsonl');
            if (!timelineSet.has(timelineName)) {
                const orphanPath = path.join(eventsDir, cacheName);
                items.push({ path: orphanPath, category: 'task-events', reason: 'orphaned-cache', sizeBytes: fileSizeBytes(orphanPath) });
            }
        }
    } catch {
        // best-effort orphan scan
    }

    return items;
}

export function collectIsolationSandbox(runtimeDir: string, maxAgeDays: number, now: Date): CleanupItem[] {
    const sandboxDir = path.join(runtimeDir, '.isolation-sandbox');
    if (!fs.existsSync(sandboxDir)) return [];

    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    let entries: string[];
    try {
        entries = fs.readdirSync(sandboxDir);
    } catch {
        return [];
    }

    for (const entry of entries) {
        const entryPath = path.join(sandboxDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (stat.mtime < cutoff) {
                const sizeBytes = stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size;
                items.push({ path: entryPath, category: 'isolation-sandbox', reason: 'age', sizeBytes });
            }
        } catch {
            // Skip unreadable entries
        }
    }

    return items;
}

export function collectStaleLifecycleLock(runtimeDir: string): CleanupItem[] {
    const items: CleanupItem[] = [];
    if (!fs.existsSync(runtimeDir)) return items;

    let siblings: string[];
    try {
        siblings = fs.readdirSync(runtimeDir);
    } catch {
        return items;
    }

    const staleLockPattern = new RegExp(`^${LIFECYCLE_OPERATION_LOCK_DIR_NAME.replace(/\./g, '\\.')}\\.stale-`);

    for (const sibling of siblings) {
        if (!staleLockPattern.test(sibling)) continue;
        const stalePath = path.join(runtimeDir, sibling);
        try {
            const stat = fs.statSync(stalePath);
            const sizeBytes = stat.isDirectory() ? dirSizeBytes(stalePath) : stat.size;
            items.push({ path: stalePath, category: 'stale-locks', reason: 'orphaned', sizeBytes });
        } catch {
            // Skip unreadable
        }
    }

    return items;
}

export function collectStaleTaskEventLockCandidates(bundleRoot: string): CleanupItem[] {
    const taskEventsDir = path.join(bundleRoot, 'runtime', 'task-events');
    const inspection = scanTaskEventLocks(bundleRoot);

    return inspection.locks
        .filter((lock) => lock.status === 'STALE')
        .map((lock) => {
            const lockPath = path.join(taskEventsDir, lock.lock_name);
            let sizeBytes = 0;
            try {
                const stat = fs.statSync(lockPath);
                sizeBytes = stat.isDirectory() ? dirSizeBytes(lockPath) : stat.size;
            } catch {
                // leave at zero
            }
            return { path: lockPath, category: 'task-events', reason: 'stale-lock', sizeBytes };
        });
}

export function buildCategorySummary(items: CleanupItem[]): Record<string, { count: number; bytes: number }> {
    const summary: Record<string, { count: number; bytes: number }> = {};
    for (const item of items) {
        const entry = summary[item.category] || { count: 0, bytes: 0 };
        entry.count += 1;
        entry.bytes += item.sizeBytes;
        summary[item.category] = entry;
    }
    return summary;
}

export function collectStandardCandidates(runtimeDir: string, policy: RetentionPolicy, now: Date): CleanupItem[] {
    const backupsDir = path.join(runtimeDir, 'backups');
    const taskEventsDir = path.join(runtimeDir, 'task-events');
    const reviewsDir = path.join(runtimeDir, 'reviews');
    const updateReportsDir = path.join(runtimeDir, 'update-reports');
    const updateRollbacksDir = path.join(runtimeDir, 'update-rollbacks');
    const bundleBackupsDir = path.join(runtimeDir, 'bundle-backups');

    return [
        ...collectTimestampedDirs(backupsDir, 'backups', policy.maxBackups, policy.maxAgeDays, now),
        ...collectTimestampedDirs(bundleBackupsDir, 'bundle-backups', policy.maxBundleBackups, policy.maxAgeDays, now),
        ...collectTaskEventFiles(taskEventsDir, policy.maxTaskEvents, policy.maxAgeDays, now),
        ...collectReviewArtifacts(reviewsDir, policy.maxReviews, policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(updateRollbacksDir, 'update-rollbacks', policy.maxUpdateRollbacks, policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(updateReportsDir, 'update-reports', policy.maxUpdateReports, policy.maxAgeDays, now)
    ];
}

export { cleanupStaleTaskEventLocks };
