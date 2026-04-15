import * as fs from 'node:fs';
import * as path from 'node:path';
import { invalidateIndex as invalidateReviewsIndex } from '../gate-runtime/reviews-index';
import { pruneAggregateLogLocked } from '../gate-runtime/task-events';
import { pruneTimelineSummaryEntries } from '../gate-runtime/timeline-summary';
import { validateTargetRoot } from './lifecycle-common';
import { withLifecycleOperationLock } from './lifecycle-lock';
import { applyStoragePolicy, loadStoragePolicy } from './cleanup-storage-policy';
import {
    buildCategorySummary,
    cleanupStaleTaskEventLocks,
    collectIsolationSandbox,
    collectStaleLifecycleLock,
    collectStaleTaskEventLockCandidates,
    collectStandardCandidates,
    processCleanupCandidates
} from './cleanup-removal';
import {
    GC_ALLOWLIST,
    type CleanupResult,
    type GcResult,
    type RetentionPolicy,
    type ReviewArtifactStoragePolicy
} from './cleanup-types';

const DEFAULT_MAX_AGE_DAYS = 30;
const DEFAULT_MAX_BACKUPS = 20;
const DEFAULT_MAX_TASK_EVENTS = 50;
const DEFAULT_MAX_REVIEWS = 100;
const DEFAULT_MAX_UPDATE_REPORTS = 10;
const DEFAULT_MAX_UPDATE_ROLLBACKS = 5;
const DEFAULT_MAX_BUNDLE_BACKUPS = 5;
const DEFAULT_MAX_AGGREGATE_LINES = 10000;
const ACTIVE_TASK_RUNTIME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

export function buildDefaultRetentionPolicy(): RetentionPolicy {
    return {
        maxAgeDays: DEFAULT_MAX_AGE_DAYS,
        maxBackups: DEFAULT_MAX_BACKUPS,
        maxTaskEvents: DEFAULT_MAX_TASK_EVENTS,
        maxReviews: DEFAULT_MAX_REVIEWS,
        maxUpdateReports: DEFAULT_MAX_UPDATE_REPORTS,
        maxUpdateRollbacks: DEFAULT_MAX_UPDATE_ROLLBACKS,
        maxBundleBackups: DEFAULT_MAX_BUNDLE_BACKUPS,
        maxAggregateLines: DEFAULT_MAX_AGGREGATE_LINES
    };
}

export interface CleanupOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    retentionPolicy?: Partial<RetentionPolicy>;
    activeTaskIds?: string[];
}

function isActiveTaskStatus(statusCell: string): boolean {
    const normalized = String(statusCell || '').trim().toUpperCase();
    return normalized.includes('IN_PROGRESS')
        || normalized.includes('IN_REVIEW')
        || String(statusCell || '').includes('🟨')
        || String(statusCell || '').includes('🟧');
}

function isTerminalTaskStatus(statusCell: string): boolean {
    const normalized = String(statusCell || '').trim().toUpperCase();
    return normalized.includes('DONE')
        || normalized.includes('BLOCKED')
        || String(statusCell || '').includes('🟩')
        || String(statusCell || '').includes('🟥');
}

interface RuntimeTaskState {
    activeTaskIds: Set<string>;
    ambiguousTaskIds: Set<string>;
    terminalTaskIds: Set<string>;
}

const RUNTIME_RECOVERY_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED'
]);

function collectRuntimeTaskState(bundleRoot: string): RuntimeTaskState {
    const activeTaskIds = new Set<string>();
    const ambiguousTaskIds = new Set<string>();
    const terminalTaskIds = new Set<string>();
    const taskEventsDir = path.join(bundleRoot, 'runtime', 'task-events');

    try {
        for (const entry of fs.readdirSync(taskEventsDir)) {
            if (!entry.endsWith('.jsonl') || entry === 'all-tasks.jsonl') {
                continue;
            }
            const taskId = entry.replace(/\.jsonl$/, '').trim();
            if (!/^T-\d+$/i.test(taskId)) {
                continue;
            }

            const timelinePath = path.join(taskEventsDir, entry);
            let content: string;
            let timelineMtimeMs = 0;
            try {
                timelineMtimeMs = fs.statSync(timelinePath).mtimeMs;
                content = fs.readFileSync(timelinePath, 'utf8');
            } catch {
                activeTaskIds.add(taskId);
                continue;
            }

            let latestStatus: string | null = null;
            let parseFailed = false;
            let hasLifecycleEvidence = false;
            let hasCompletionGatePass = false;
            let latestEventSequence = -1;
            let latestRestartSequence = -1;
            let latestTerminalSequence = -1;
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const eventType = String(parsed.event_type || '').trim().toUpperCase();
                    if (eventType) {
                        hasLifecycleEvidence = true;
                        latestEventSequence += 1;
                    }
                    if (RUNTIME_RECOVERY_EVENTS.has(eventType)) {
                        latestRestartSequence = latestEventSequence;
                    }
                    if (eventType === 'COMPLETION_GATE_PASSED') {
                        hasCompletionGatePass = true;
                        latestTerminalSequence = latestEventSequence;
                    }
                    if (eventType !== 'STATUS_CHANGED') {
                        continue;
                    }
                    const details = parsed.details;
                    if (!details || typeof details !== 'object' || Array.isArray(details)) {
                        continue;
                    }
                    const nextStatus = String((details as Record<string, unknown>).new_status || '').trim();
                    if (nextStatus) {
                        latestStatus = nextStatus;
                        if (isTerminalTaskStatus(nextStatus)) {
                            latestTerminalSequence = latestEventSequence;
                        }
                    }
                } catch {
                    parseFailed = true;
                    break;
                }
            }

            const withinRuntimeGrace = timelineMtimeMs > 0
                && (Date.now() - timelineMtimeMs) <= ACTIVE_TASK_RUNTIME_GRACE_MS;
            const hasFreshLifecycleRestart = withinRuntimeGrace && latestRestartSequence > latestTerminalSequence;
            if (parseFailed || isActiveTaskStatus(latestStatus || '')) {
                activeTaskIds.add(taskId);
            } else if (hasFreshLifecycleRestart) {
                activeTaskIds.add(taskId);
            } else if (isTerminalTaskStatus(latestStatus || '') || hasCompletionGatePass) {
                terminalTaskIds.add(taskId);
            } else if (hasLifecycleEvidence) {
                ambiguousTaskIds.add(taskId);
            } else {
                continue;
            }
        }
    } catch {
        // best-effort runtime fallback only
    }

    return {
        activeTaskIds,
        ambiguousTaskIds,
        terminalTaskIds
    };
}

function resolveActiveTaskIds(targetRoot: string, bundleRoot: string, explicitTaskIds?: readonly string[]): Set<string> {
    const activeTaskIds = new Set(
        (explicitTaskIds || [])
            .map((taskId) => String(taskId || '').trim())
            .filter((taskId) => taskId.length > 0)
    );
    const runtimeTaskState = collectRuntimeTaskState(bundleRoot);
    const mergeRuntimeTaskIds = (includeAmbiguous: boolean): void => {
        for (const taskId of runtimeTaskState.activeTaskIds) {
            activeTaskIds.add(taskId);
        }
        if (includeAmbiguous) {
            for (const taskId of runtimeTaskState.ambiguousTaskIds) {
                activeTaskIds.add(taskId);
            }
        }
    };
    mergeRuntimeTaskIds(false);
    const taskMdActiveTaskIds = new Set<string>();
    const taskPath = path.join(targetRoot, 'TASK.md');
    if (!fs.existsSync(taskPath)) {
        mergeRuntimeTaskIds(true);
        return activeTaskIds;
    }

    let content: string;
    try {
        content = fs.readFileSync(taskPath, 'utf8');
    } catch {
        mergeRuntimeTaskIds(true);
        return activeTaskIds;
    }

    for (const rawLine of content.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 2) {
            continue;
        }
        const taskId = String(cells[0] || '').trim();
        if (!/^T-\d+$/i.test(taskId)) {
            continue;
        }
        if (isActiveTaskStatus(cells[1] || '')) {
            taskMdActiveTaskIds.add(taskId);
        }
    }

    for (const taskId of taskMdActiveTaskIds) {
        if (runtimeTaskState.terminalTaskIds.has(taskId) && !runtimeTaskState.activeTaskIds.has(taskId)) {
            continue;
        }
        activeTaskIds.add(taskId);
    }
    mergeRuntimeTaskIds(true);

    return activeTaskIds;
}

export function runCleanup(options: CleanupOptions): CleanupResult {
    const { targetRoot, bundleRoot, dryRun = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    const policy: RetentionPolicy = {
        ...buildDefaultRetentionPolicy(),
        ...options.retentionPolicy
    };

    const runtimeDir = path.join(bundleRoot, 'runtime');
    const now = new Date();
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds);
    const candidates = collectStandardCandidates(runtimeDir, policy, now, activeTaskIds);
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun);

    if (!dryRun && removed.some((item) => item.category === 'reviews')) {
        try {
            invalidateReviewsIndex(path.join(runtimeDir, 'reviews'));
        } catch {
            // best-effort
        }
    }

    if (!dryRun && removed.some((item) => item.category === 'task-events')) {
        try {
            pruneTimelineSummaryEntries(path.join(runtimeDir, 'task-events'));
        } catch {
            // best-effort
        }
    }

    let aggregateRetention: CleanupResult['aggregateRetention'];
    if (!dryRun && policy.maxAggregateLines > 0) {
        try {
            aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
        } catch {
            // best-effort
        }
    }

    return {
        targetRoot,
        dryRun,
        retentionPolicy: policy,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        aggregateRetention
    };
}

export function runCleanupWithLock(options: CleanupOptions): CleanupResult {
    return withLifecycleOperationLock(options.targetRoot, 'cleanup', () => runCleanup(options));
}

export interface GcOptions {
    targetRoot: string;
    bundleRoot: string;
    confirm?: boolean;
    retentionPolicy?: Partial<RetentionPolicy>;
    categories?: string[];
    storagePolicy?: ReviewArtifactStoragePolicy;
    activeTaskIds?: string[];
}

export function validateGcCategories(categories: string[]): void {
    for (const cat of categories) {
        if (!GC_ALLOWLIST.includes(cat)) {
            throw new Error(`Unknown gc category '${cat}'. Allowed: ${GC_ALLOWLIST.join(', ')}`);
        }
    }
}

export function runGc(options: GcOptions): GcResult {
    const { targetRoot, bundleRoot, confirm = false } = options;
    validateTargetRoot(targetRoot, bundleRoot);

    if (options.categories && options.categories.length > 0) {
        validateGcCategories(options.categories);
    }

    const policy: RetentionPolicy = {
        ...buildDefaultRetentionPolicy(),
        ...options.retentionPolicy
    };

    const dryRun = !confirm;
    const filterCategories = options.categories && options.categories.length > 0
        ? new Set(options.categories)
        : null;

    const runtimeDir = path.join(bundleRoot, 'runtime');
    const now = new Date();
    const activeTaskIds = resolveActiveTaskIds(targetRoot, bundleRoot, options.activeTaskIds);
    const standardCandidates = collectStandardCandidates(runtimeDir, policy, now, activeTaskIds);
    const isolationItems = collectIsolationSandbox(runtimeDir, policy.maxAgeDays, now);
    const staleLockItems = collectStaleLifecycleLock(runtimeDir);
    const shouldCleanTaskEventLocks = !filterCategories || filterCategories.has('task-events');
    const taskEventLockCandidates = shouldCleanTaskEventLocks
        ? collectStaleTaskEventLockCandidates(bundleRoot)
        : [];

    let allCandidates = [...standardCandidates, ...isolationItems, ...staleLockItems];
    if (filterCategories) {
        allCandidates = allCandidates.filter((item) => filterCategories.has(item.category));
    }

    const {
        removed,
        skipped,
        errors,
        totalFreedBytes: standardFreedBytes
    } = processCleanupCandidates(allCandidates, dryRun);
    let totalFreedBytes = standardFreedBytes;

    if (!dryRun && removed.some((item) => item.category === 'reviews')) {
        try {
            invalidateReviewsIndex(path.join(runtimeDir, 'reviews'));
        } catch {
            // best-effort
        }
    }

    if (!dryRun && removed.some((item) => item.category === 'task-events')) {
        try {
            pruneTimelineSummaryEntries(path.join(runtimeDir, 'task-events'));
        } catch {
            // best-effort
        }
    }

    let staleLocksCleaned = 0;
    if (shouldCleanTaskEventLocks) {
        try {
            const lockResult = cleanupStaleTaskEventLocks(bundleRoot, { dryRun });
            const taskEventLockItems = new Map(taskEventLockCandidates.map((item) => [path.basename(item.path), item]));
            const effectiveTaskEventLocks = (dryRun ? lockResult.removable_stale_locks : lockResult.removed_locks)
                .map((lockName) => taskEventLockItems.get(lockName))
                .filter((item): item is NonNullable<typeof item> => item != null);

            staleLocksCleaned = dryRun ? lockResult.removable_stale_locks.length : lockResult.removed_locks.length;
            totalFreedBytes += effectiveTaskEventLocks.reduce((sum, item) => sum + item.sizeBytes, 0);
            if (dryRun) {
                skipped.push(...effectiveTaskEventLocks);
            } else {
                removed.push(...effectiveTaskEventLocks);
            }
        } catch {
            // best-effort
        }
    }

    const actionItems = dryRun ? skipped : removed;
    const isolationSandboxCleaned = actionItems.some((item) => item.category === 'isolation-sandbox');

    const shouldApplyStoragePolicy = !filterCategories || filterCategories.has('reviews');
    let storagePolicyResult: GcResult['storagePolicyResult'];
    if (shouldApplyStoragePolicy && confirm) {
        const storagePolicy = options.storagePolicy ?? loadStoragePolicy(bundleRoot);
        storagePolicyResult = applyStoragePolicy(path.join(runtimeDir, 'reviews'), storagePolicy, activeTaskIds);
    }

    const shouldPruneAggregate = !filterCategories || filterCategories.has('task-events');
    let aggregateRetention: GcResult['aggregateRetention'];
    if (shouldPruneAggregate && policy.maxAggregateLines > 0) {
        try {
            if (confirm) {
                aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
            }
        } catch {
            // best-effort
        }
    }

    return {
        targetRoot,
        dryRun,
        retentionPolicy: policy,
        removed,
        skipped,
        errors,
        totalFreedBytes,
        result: errors.length > 0 ? 'PARTIAL' : 'SUCCESS',
        staleLocksCleaned,
        isolationSandboxCleaned,
        categories: buildCategorySummary(actionItems),
        storagePolicyResult,
        aggregateRetention
    };
}

export function runGcWithLock(options: GcOptions): GcResult {
    return withLifecycleOperationLock(options.targetRoot, 'gc', () => runGc(options));
}
