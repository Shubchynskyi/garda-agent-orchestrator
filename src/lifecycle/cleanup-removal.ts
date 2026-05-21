import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupStaleTaskEventLocks, scanTaskEventLocks } from '../gate-runtime/task-events';
import { resolveTaskHistoryLedgerPath } from '../gate-runtime/task-history-ledger';
import { KNOWN_SUFFIXES } from '../gate-runtime/reviews-index';
import {
    isCanonicalTaskId,
    parseActiveReviewArtifactTaskId,
    parseKnownReviewArtifactTaskId
} from '../core/task-ids';
import { LIFECYCLE_OPERATION_LOCK_DIR_NAME } from './lifecycle-lock';
import { ensureWithinRoot, removePathRecursive } from './generic-utils';
import { buildRuntimeRetentionPreview } from './runtime-retention-policy';
import { resolveStructuredOrJsonReviewArtifactTaskId } from './cleanup-review-artifact-ownership';
import type { CleanupItem, RetentionPolicy } from './cleanup-types';

export interface ProcessCleanupCandidatesResult {
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
}

export interface RuntimeRetentionCandidateSelection {
    previewCandidates: CleanupItem[];
    compactionCandidates: CleanupItem[];
}

function parseReviewArtifactTaskId(filePath: string, fileName: string): string | null {
    const knownTaskId = parseKnownReviewArtifactTaskId(fileName, KNOWN_SUFFIXES);
    if (knownTaskId) {
        return knownTaskId;
    }
    return resolveStructuredOrJsonReviewArtifactTaskId(filePath, fileName);
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

function isNotFoundError(error: unknown): boolean {
    return typeof error === 'object'
        && error !== null
        && 'code' in error
        && (error as { code?: unknown }).code === 'ENOENT';
}

export function processCleanupCandidates(
    candidates: CleanupItem[],
    dryRun: boolean,
    runtimeRoot?: string
): ProcessCleanupCandidatesResult {
    const removed: CleanupItem[] = [];
    const skipped: CleanupItem[] = [];
    const errors: Array<{ path: string; message: string }> = [];
    let totalFreedBytes = 0;

    for (const item of candidates) {
        let safePath = path.resolve(item.path);
        if (runtimeRoot) {
            try {
                safePath = ensureWithinRoot(runtimeRoot, item.path, 'Cleanup candidate');
            } catch (error: unknown) {
                errors.push({
                    path: item.path,
                    message: error instanceof Error ? error.message : String(error)
                });
                continue;
            }
        }
        if (dryRun) {
            skipped.push(item);
            totalFreedBytes += item.sizeBytes;
            continue;
        }

        if (!fs.existsSync(safePath)) {
            continue;
        }

        try {
            const stat = fs.statSync(safePath);
            if (stat.isDirectory()) {
                removePathRecursive(safePath);
            } else {
                fs.unlinkSync(safePath);
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

function parseMarkdownWorkingPlanTaskId(fileName: string): string | null {
    if (!fileName.endsWith('.md')) {
        return null;
    }
    const taskId = fileName.slice(0, -'.md'.length).trim();
    return /^T-\d+(?:-[A-Za-z0-9]+)*$/u.test(taskId) && isCanonicalTaskId(taskId) ? taskId : null;
}

function collectTaskReviewArtifactsInventory(
    reviewsDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(reviewsDir)) return [];
    const items: CleanupItem[] = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(reviewsDir).sort();
    } catch {
        return [];
    }

    for (const entry of entries) {
        const activeTaskId = parseActiveReviewArtifactTaskId(entry, activeTaskIds);
        if (activeTaskId) {
            continue;
        }
        const entryPath = path.join(reviewsDir, entry);
        const taskId = parseReviewArtifactTaskId(entryPath, entry);
        if (!taskId) {
            continue;
        }
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'reviews',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });
    }

    return items;
}

function collectTaskTimelineArtifactsInventory(
    eventsDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(eventsDir)) return [];
    const items: CleanupItem[] = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(eventsDir).sort();
    } catch {
        return [];
    }

    for (const entry of entries) {
        if (!entry.endsWith('.jsonl') || entry === 'all-tasks.jsonl') {
            continue;
        }
        const taskId = entry.replace(/\.jsonl$/, '');
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        const entryPath = path.join(eventsDir, entry);
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'task-events',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });

        const cachePath = path.join(eventsDir, `${taskId}.completeness.json`);
        if (fs.existsSync(cachePath)) {
            items.push({
                path: cachePath,
                category: 'task-events',
                reason: 'retention-inventory',
                sizeBytes: fileSizeBytes(cachePath),
                taskId
            });
        }
    }

    return items;
}

function collectOrphanedCompletenessCaches(
    eventsDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(eventsDir)) return [];
    const items: CleanupItem[] = [];

    let cacheEntries: string[];
    try {
        cacheEntries = fs.readdirSync(eventsDir).filter((entry) => entry.endsWith('.completeness.json')).sort();
    } catch {
        return [];
    }

    for (const cacheName of cacheEntries) {
        const taskId = cacheName.replace(/\.completeness\.json$/, '');
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
        if (fs.existsSync(timelinePath)) {
            continue;
        }
        const cachePath = path.join(eventsDir, cacheName);
        items.push({
            path: cachePath,
            category: 'task-events',
            reason: 'orphaned-cache',
            sizeBytes: fileSizeBytes(cachePath),
            taskId
        });
    }

    return items;
}

function collectTaskProjectMemoryArtifactsInventory(
    projectMemoryDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(projectMemoryDir)) return [];
    const items: CleanupItem[] = [];

    let entries: string[];
    try {
        entries = fs.readdirSync(projectMemoryDir).sort();
    } catch {
        return [];
    }

    for (const entry of entries) {
        const taskId = parseProjectMemoryArtifactTaskId(entry);
        if (!taskId) {
            continue;
        }
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        const entryPath = path.join(projectMemoryDir, entry);
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'project-memory',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });
    }

    return items;
}

function parseProjectMemoryArtifactTaskId(fileName: string): string | null {
    for (const suffix of ['-impact.json', '-update.json']) {
        if (!fileName.endsWith(suffix)) {
            continue;
        }
        const taskId = fileName.slice(0, -suffix.length);
        return isCanonicalTaskId(taskId) ? taskId : null;
    }
    return null;
}

function collectTaskWorkingPlanArtifactsInventory(
    plansDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(plansDir)) return [];
    const items: CleanupItem[] = [];
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()));

    let entries: string[];
    try {
        entries = fs.readdirSync(plansDir).sort();
    } catch {
        return [];
    }

    for (const entry of entries) {
        const taskId = parseMarkdownWorkingPlanTaskId(entry);
        if (!taskId || activeTaskIdsLower.has(taskId.toLowerCase())) {
            continue;
        }
        const entryPath = path.join(plansDir, entry);
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'plans',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });
    }

    return items;
}

function collectTaskScopedArtifactInventory(
    runtimeDir: string,
    activeTaskIds: ReadonlySet<string>
): CleanupItem[] {
    return [
        ...collectTaskReviewArtifactsInventory(path.join(runtimeDir, 'reviews'), activeTaskIds),
        ...collectTaskTimelineArtifactsInventory(path.join(runtimeDir, 'task-events'), activeTaskIds),
        ...collectTaskWorkingPlanArtifactsInventory(path.join(runtimeDir, 'plans'), activeTaskIds),
        ...collectTaskProjectMemoryArtifactsInventory(path.join(runtimeDir, 'project-memory'), activeTaskIds)
    ];
}

export function collectRuntimeRetentionCandidates(
    targetRoot: string,
    bundleRoot: string,
    activeTaskIds: ReadonlySet<string>
): RuntimeRetentionCandidateSelection {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const previewCandidates = collectTaskScopedArtifactInventory(runtimeDir, activeTaskIds);
    const preview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );
    const eligibleTasks = new Set(
        preview.tasks
            .filter((task) =>
                task.health_state === 'healthy_done'
                && task.retention_tier === 'compact_ledger_candidate'
                && task.ledger_status === 'VERIFIED'
                && task.eligible_now
            )
            .map((task) => task.task_id)
    );

    return {
        previewCandidates,
        compactionCandidates: previewCandidates
            .filter((item) => item.taskId && eligibleTasks.has(item.taskId))
            .map((item) => ({
                ...item,
                reason: 'ledger-compaction',
                retainedLedgerPath: item.taskId ? resolveTaskHistoryLedgerPath(bundleRoot, item.taskId) : null,
                retentionDisposition: 'ledger-only'
            }))
    };
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
            // Skip unreadable entries.
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
            // Skip unreadable files.
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

export function collectStandardCandidates(
    runtimeDir: string,
    policy: RetentionPolicy,
    now: Date,
    activeTaskIds: ReadonlySet<string> = new Set<string>()
): CleanupItem[] {
    const backupsDir = path.join(runtimeDir, 'backups');
    const taskEventsDir = path.join(runtimeDir, 'task-events');
    const updateReportsDir = path.join(runtimeDir, 'update-reports');
    const updateRollbacksDir = path.join(runtimeDir, 'update-rollbacks');
    const bundleBackupsDir = path.join(runtimeDir, 'bundle-backups');

    return [
        ...collectTimestampedDirs(backupsDir, 'backups', policy.maxBackups, policy.maxAgeDays, now),
        ...collectTimestampedDirs(bundleBackupsDir, 'bundle-backups', policy.maxBundleBackups, policy.maxAgeDays, now),
        ...collectOrphanedCompletenessCaches(taskEventsDir, activeTaskIds),
        ...collectUpdateNamedDirs(updateRollbacksDir, 'update-rollbacks', policy.maxUpdateRollbacks, policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(updateReportsDir, 'update-reports', policy.maxUpdateReports, policy.maxAgeDays, now)
    ];
}

export { cleanupStaleTaskEventLocks };
