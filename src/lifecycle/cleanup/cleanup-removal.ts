import * as fs from 'node:fs';
import * as path from 'node:path';
import { cleanupStaleTaskEventLocks, scanTaskEventLocks } from '../../gate-runtime/task-events';
import { resolveTaskHistoryLedgerPath } from '../../gate-runtime/task-history-ledger';
import { KNOWN_SUFFIXES } from '../../gate-runtime/reviews-index';
import {
    isCanonicalTaskId,
    parseActiveReviewArtifactTaskId,
    parseKnownReviewArtifactTaskId,
    parseStructuredTaskArtifactTaskId
} from '../../core/task-ids';
import { LIFECYCLE_OPERATION_LOCK_DIR_NAME } from '../lock/lifecycle-lock';
import { ensureWithinRoot, removePathRecursive } from '../generic-utils';
import {
    buildRuntimeRetentionPreview,
    contributesToRetentionAge,
    type RuntimeRetentionTaskPreview
} from '../runtime-policy/runtime-retention-policy';
import { resolveStructuredOrJsonReviewArtifactTaskId } from './cleanup-review-artifact-ownership';
import {
    isRuntimeCleanupTaskPurgeDeletionCategory,
    listRuntimeCleanupCollectorContracts,
    resolveRuntimeCleanupStandardPaths
} from './runtime-cleanup-ownership';
import type { CleanupItem, RetentionPolicy } from './cleanup-types';
import type { RuntimeCleanupCollectorKey, RuntimeCleanupStandardPaths } from './runtime-cleanup-ownership';

export interface ProcessCleanupCandidatesResult {
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
}

export interface RuntimeRetentionCandidateSelection {
    previewCandidates: CleanupItem[];
    compactionCandidates: CleanupItem[];
    selectedTaskIds: Set<string>;
    boundedTaskIds: Set<string> | null;
}

export interface RuntimeRetentionSelectionOptions {
    maxEligibleTasks?: number;
    eligibleOlderThanDays?: number;
    keepLatestTasks?: number;
    now?: Date;
}

interface TaskArtifactSummary {
    taskId: string;
    newestMtimeMs: number;
}

interface TaskScopedCollectorContext {
    standardPaths: RuntimeCleanupStandardPaths;
    activeTaskIds: ReadonlySet<string>;
    taskIdFilter?: ReadonlySet<string>;
}

type TaskScopedArtifactCollector = (context: TaskScopedCollectorContext) => CleanupItem[];

function isRuntimeRetentionCompactionCandidate(
    item: CleanupItem,
    compactableLedgerTaskIds: ReadonlySet<string>
): boolean {
    return Boolean(
        item.taskId
        && compactableLedgerTaskIds.has(item.taskId)
        && item.category !== 'task-ledger'
        && isRuntimeCleanupTaskPurgeDeletionCategory(item.category)
    );
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

function collectAgedEntries(dirPath: string, category: string, maxAgeDays: number, now: Date): CleanupItem[] {
    const entries = directoryEntries(dirPath);
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);

    for (const entryName of entries) {
        const entryPath = path.join(dirPath, entryName);
        try {
            const stat = fs.statSync(entryPath);
            if (stat.mtime >= cutoff) {
                continue;
            }
            items.push({
                path: entryPath,
                category,
                reason: 'age',
                sizeBytes: stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size
            });
        } catch {
            // Skip unreadable entries.
        }
    }

    return items;
}

function collectRuntimeRootTempFiles(runtimeDir: string, maxAgeDays: number, now: Date): CleanupItem[] {
    const entries = directoryEntries(runtimeDir);
    const items: CleanupItem[] = [];
    const cutoff = new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000);
    for (const entry of entries) {
        if (!entry.endsWith('.tmp') && !entry.endsWith('.partial')) {
            continue;
        }
        const entryPath = path.join(runtimeDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (!stat.isFile()) {
                continue;
            }
            if (stat.mtime >= cutoff) {
                continue;
            }
            items.push({
                path: entryPath,
                category: 'tmp',
                reason: 'orphaned-temp-file',
                sizeBytes: stat.size
            });
        } catch {
            // Skip unreadable temp files.
        }
    }
    return items;
}

function collectRuntimeTmp(tmpDir: string, maxAgeDays: number, now: Date, activeTaskIds: ReadonlySet<string>): CleanupItem[] {
    const items = collectAgedEntries(tmpDir, 'tmp', maxAgeDays, now)
        .filter((item) => path.basename(item.path) !== 'reviews');
    const reviewScratchDir = path.join(tmpDir, 'reviews');
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()));

    for (const entry of directoryEntries(reviewScratchDir)) {
        const entryPath = path.join(reviewScratchDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (!stat.isDirectory()) {
                if (stat.mtime < new Date(now.getTime() - maxAgeDays * 24 * 60 * 60 * 1000)) {
                    items.push({ path: entryPath, category: 'tmp', reason: 'age', sizeBytes: stat.size });
                }
                continue;
            }
            if (isCanonicalTaskId(entry) && activeTaskIdsLower.has(entry.toLowerCase())) {
                continue;
            }
            items.push({
                path: entryPath,
                category: 'tmp',
                reason: 'inactive-reviewer-scratch',
                sizeBytes: dirSizeBytes(entryPath),
                taskId: isCanonicalTaskId(entry) ? entry : undefined
            });
        } catch {
            // Skip unreadable scratch entries.
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
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
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
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
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
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
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
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
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

    if (taskIdFilter) {
        const existingCandidatePaths = new Set(items.map((item) => path.resolve(item.path)));
        for (const taskId of taskIdFilter) {
            if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
                continue;
            }
            const cachePath = path.join(eventsDir, `${taskId}.completeness.json`);
            if (!fs.existsSync(cachePath) || existingCandidatePaths.has(path.resolve(cachePath))) {
                continue;
            }
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
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
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
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
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
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
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
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
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

function collectTaskManualValidationArtifactsInventory(
    manualValidationDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(manualValidationDir)) return [];
    const items: CleanupItem[] = [];
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()));

    for (const entry of directoryEntries(manualValidationDir)) {
        if (!isCanonicalTaskId(entry) || activeTaskIdsLower.has(entry.toLowerCase())) {
            continue;
        }
        if (taskIdFilter && !taskIdFilter.has(entry)) {
            continue;
        }
        const entryPath = path.join(manualValidationDir, entry);
        try {
            if (!fs.statSync(entryPath).isDirectory()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'manual-validation',
            reason: 'retention-inventory',
            sizeBytes: dirSizeBytes(entryPath),
            taskId: entry
        });
    }

    return items;
}

function collectTaskLedgerArtifactsInventory(
    taskLedgerDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(taskLedgerDir)) return [];
    const items: CleanupItem[] = [];

    for (const entry of directoryEntries(taskLedgerDir)) {
        if (!entry.endsWith('.json')) {
            continue;
        }
        const taskId = entry.slice(0, -'.json'.length);
        if (!isCanonicalTaskId(taskId) || activeTaskIds.has(taskId)) {
            continue;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            continue;
        }
        const entryPath = path.join(taskLedgerDir, entry);
        try {
            if (!fs.statSync(entryPath).isFile()) {
                continue;
            }
        } catch {
            continue;
        }
        items.push({
            path: entryPath,
            category: 'task-ledger',
            reason: 'retention-inventory',
            sizeBytes: fileSizeBytes(entryPath),
            taskId
        });
    }

    return items;
}

function collectTaskTmpArtifactsInventory(
    tmpDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    if (!fs.existsSync(tmpDir)) return [];
    const items: CleanupItem[] = [];
    const activeTaskIdsLower = new Set(Array.from(activeTaskIds).map((taskId) => taskId.toLowerCase()));
    const addCandidate = (entryPath: string, taskId: string, sizeBytes: number): void => {
        if (!isCanonicalTaskId(taskId) || activeTaskIdsLower.has(taskId.toLowerCase())) {
            return;
        }
        if (taskIdFilter && !taskIdFilter.has(taskId)) {
            return;
        }
        items.push({
            path: entryPath,
            category: 'tmp',
            reason: 'retention-inventory',
            sizeBytes,
            taskId
        });
    };

    const reviewScratchDir = path.join(tmpDir, 'reviews');
    for (const entry of directoryEntries(reviewScratchDir)) {
        const entryPath = path.join(reviewScratchDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            if (!stat.isDirectory()) {
                continue;
            }
            addCandidate(entryPath, entry, dirSizeBytes(entryPath));
        } catch {
            // Skip unreadable scratch entries.
        }
    }

    for (const entry of directoryEntries(tmpDir)) {
        if (entry === 'reviews') {
            continue;
        }
        const taskId = isCanonicalTaskId(entry) ? entry : parseStructuredTaskArtifactTaskId(entry);
        if (!taskId) {
            continue;
        }
        const entryPath = path.join(tmpDir, entry);
        try {
            const stat = fs.statSync(entryPath);
            addCandidate(entryPath, taskId, stat.isDirectory() ? dirSizeBytes(entryPath) : stat.size);
        } catch {
            // Skip unreadable tmp entries.
        }
    }

    return items;
}

const TASK_SCOPED_ARTIFACT_COLLECTORS = Object.freeze({
    'manual-validation-task-root': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskManualValidationArtifactsInventory(standardPaths.manualValidationDir, activeTaskIds, taskIdFilter),
    'reviews-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskReviewArtifactsInventory(standardPaths.reviewsDir, activeTaskIds, taskIdFilter),
    'task-events-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskTimelineArtifactsInventory(standardPaths.taskEventsDir, activeTaskIds, taskIdFilter),
    'plans-task-markdown': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskWorkingPlanArtifactsInventory(standardPaths.plansDir, activeTaskIds, taskIdFilter),
    'project-memory-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskProjectMemoryArtifactsInventory(standardPaths.projectMemoryDir, activeTaskIds, taskIdFilter),
    'task-ledger-files': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskLedgerArtifactsInventory(standardPaths.taskLedgerDir, activeTaskIds, taskIdFilter),
    'tmp-task-artifacts': ({ standardPaths, activeTaskIds, taskIdFilter }: TaskScopedCollectorContext) =>
        collectTaskTmpArtifactsInventory(standardPaths.tmpDir, activeTaskIds, taskIdFilter)
} satisfies Record<RuntimeCleanupCollectorKey, TaskScopedArtifactCollector>);

function collectTaskScopedArtifactInventory(
    runtimeDir: string,
    activeTaskIds: ReadonlySet<string>,
    taskIdFilter?: ReadonlySet<string>
): CleanupItem[] {
    const standardPaths = resolveRuntimeCleanupStandardPaths(runtimeDir);
    const context: TaskScopedCollectorContext = { standardPaths, activeTaskIds, taskIdFilter };
    const items: CleanupItem[] = [];
    for (const contract of listRuntimeCleanupCollectorContracts()) {
        items.push(...TASK_SCOPED_ARTIFACT_COLLECTORS[contract.key](context));
    }
    return items;
}

export function collectTaskRuntimePurgeCandidates(runtimeDir: string, taskId: string): CleanupItem[] {
    const taskIdFilter = new Set([taskId]);
    return collectTaskScopedArtifactInventory(runtimeDir, new Set<string>(), taskIdFilter)
        .filter((item) => item.taskId === taskId && isRuntimeCleanupTaskPurgeDeletionCategory(item.category))
        .map((item) => ({ ...item, reason: 'task-runtime-purge' }));
}

function normalizePositiveIntegerLimit(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.floor(value);
}

function normalizeNonNegativeIntegerLimit(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
        return null;
    }
    return Math.floor(value);
}

function updateTaskArtifactSummary(
    summaries: Map<string, TaskArtifactSummary>,
    item: CleanupItem
): void {
    if (!item.taskId || !contributesToRetentionAge(item.category)) {
        return;
    }
    let newestMtimeMs = 0;
    try {
        newestMtimeMs = fs.statSync(item.path).mtimeMs;
    } catch {
        // Keep unreadable artifacts eligible for preview with the lowest age priority.
    }
    const existing = summaries.get(item.taskId);
    if (!existing || newestMtimeMs > existing.newestMtimeMs) {
        summaries.set(item.taskId, { taskId: item.taskId, newestMtimeMs });
    }
}

function compareTaskArtifactsByNewestFirst(left: TaskArtifactSummary, right: TaskArtifactSummary): number {
    if (right.newestMtimeMs !== left.newestMtimeMs) {
        return right.newestMtimeMs - left.newestMtimeMs;
    }
    return left.taskId.localeCompare(right.taskId);
}

function compareTaskArtifactsByOldestFirst(left: TaskArtifactSummary, right: TaskArtifactSummary): number {
    if (left.newestMtimeMs !== right.newestMtimeMs) {
        return left.newestMtimeMs - right.newestMtimeMs;
    }
    return left.taskId.localeCompare(right.taskId);
}

function compareRuntimeRetentionTasksByOldestArtifactFirst(
    left: RuntimeRetentionTaskPreview,
    right: RuntimeRetentionTaskPreview
): number {
    const leftMtimeMs = left.latest_artifact_mtime_ms ?? 0;
    const rightMtimeMs = right.latest_artifact_mtime_ms ?? 0;
    if (leftMtimeMs !== rightMtimeMs) {
        return leftMtimeMs - rightMtimeMs;
    }
    return left.task_id.localeCompare(right.task_id);
}

function selectRuntimeRetentionPreviewTaskIds(
    inventory: CleanupItem[],
    options: RuntimeRetentionSelectionOptions
): Set<string> | null {
    const eligibleOlderThanDays = normalizeNonNegativeIntegerLimit(options.eligibleOlderThanDays);
    const keepLatestTasks = normalizeNonNegativeIntegerLimit(options.keepLatestTasks) ?? 0;
    const needsBoundedSelection = eligibleOlderThanDays !== null || keepLatestTasks > 0;
    if (!needsBoundedSelection) {
        return null;
    }

    const summaries = new Map<string, TaskArtifactSummary>();
    for (const item of inventory) {
        updateTaskArtifactSummary(summaries, item);
    }

    let candidates = Array.from(summaries.values());
    if (keepLatestTasks > 0) {
        const protectedTaskIds = new Set(
            [...candidates]
                .sort(compareTaskArtifactsByNewestFirst)
                .slice(0, keepLatestTasks)
                .map((summary) => summary.taskId)
        );
        candidates = candidates.filter((summary) => !protectedTaskIds.has(summary.taskId));
    }

    if (eligibleOlderThanDays !== null) {
        const cutoffMs = (options.now ?? new Date()).getTime() - eligibleOlderThanDays * 24 * 60 * 60 * 1000;
        candidates = candidates.filter((summary) => summary.newestMtimeMs <= cutoffMs);
    }

    candidates.sort(compareTaskArtifactsByOldestFirst);
    return new Set(candidates.map((summary) => summary.taskId));
}

export function collectRuntimeRetentionCandidates(
    targetRoot: string,
    bundleRoot: string,
    activeTaskIds: ReadonlySet<string>,
    options: RuntimeRetentionSelectionOptions = {}
): RuntimeRetentionCandidateSelection {
    const runtimeDir = path.join(bundleRoot, 'runtime');
    const maxEligibleTasks = normalizePositiveIntegerLimit(options.maxEligibleTasks);
    const allPreviewCandidates = collectTaskScopedArtifactInventory(runtimeDir, activeTaskIds);
    const boundedTaskIds = selectRuntimeRetentionPreviewTaskIds(allPreviewCandidates, options);
    const previewCandidates = boundedTaskIds === null
        ? allPreviewCandidates
        : allPreviewCandidates.filter((item) => item.taskId && boundedTaskIds.has(item.taskId));
    const preview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );
    const eligibleTaskIds = preview.tasks
            .filter((task) =>
                task.eligible_now
                && (
                    (
                        task.health_state === 'healthy_done'
                        && task.retention_tier === 'compact_ledger_candidate'
                        && task.ledger_status === 'VERIFIED'
                    )
                    || task.retention_tier === 'compressed_forensic_candidate'
                )
            )
            .sort(compareRuntimeRetentionTasksByOldestArtifactFirst)
            .map((task) => task.task_id);
    const selectedTaskIds = new Set(
        maxEligibleTasks !== null
            ? eligibleTaskIds.slice(0, maxEligibleTasks)
            : eligibleTaskIds
    );
    const compactableLedgerTaskIds = new Set(
        preview.tasks
            .filter((task) =>
                selectedTaskIds.has(task.task_id)
                && task.health_state === 'healthy_done'
                && task.retention_tier === 'compact_ledger_candidate'
                && task.ledger_status === 'VERIFIED'
                && task.eligible_now
            )
            .map((task) => task.task_id)
    );
    return {
        previewCandidates,
        selectedTaskIds,
        boundedTaskIds,
        compactionCandidates: previewCandidates
            .filter((item) => isRuntimeRetentionCompactionCandidate(item, compactableLedgerTaskIds))
            .map((item) => ({
                ...item,
                reason: 'ledger-compaction',
                retainedLedgerPath: item.taskId ? resolveTaskHistoryLedgerPath(bundleRoot, item.taskId) : null,
                retentionDisposition: 'ledger-only'
            }))
    };
}

export function collectIsolationSandbox(runtimeDir: string, maxAgeDays: number, now: Date): CleanupItem[] {
    const sandboxDir = resolveRuntimeCleanupStandardPaths(runtimeDir).isolationSandboxDir;
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
    const taskEventsDir = resolveRuntimeCleanupStandardPaths(path.join(bundleRoot, 'runtime')).taskEventsDir;
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
    const standardPaths = resolveRuntimeCleanupStandardPaths(runtimeDir);

    return [
        ...collectTimestampedDirs(standardPaths.backupsDir, 'backups', policy.maxBackups, policy.maxAgeDays, now),
        ...collectTimestampedDirs(standardPaths.bundleBackupsDir, 'bundle-backups', policy.maxBundleBackups, policy.maxAgeDays, now),
        ...collectOrphanedCompletenessCaches(standardPaths.taskEventsDir, activeTaskIds),
        ...collectRuntimeRootTempFiles(runtimeDir, policy.maxAgeDays, now),
        ...collectRuntimeTmp(standardPaths.tmpDir, policy.maxAgeDays, now, activeTaskIds),
        ...collectAgedEntries(standardPaths.testScratchDir, 'test-scratch', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.cacheDir, 'cache', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.reportsDir, 'reports', policy.maxAgeDays, now),
        ...collectAgedEntries(standardPaths.updateTempDir, 'update-temp', policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(standardPaths.updateRollbacksDir, 'update-rollbacks', policy.maxUpdateRollbacks, policy.maxAgeDays, now),
        ...collectUpdateNamedDirs(standardPaths.updateReportsDir, 'update-reports', policy.maxUpdateReports, policy.maxAgeDays, now)
    ];
}

export { cleanupStaleTaskEventLocks };
