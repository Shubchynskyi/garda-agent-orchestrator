import * as path from 'node:path';
import { invalidateIndex as invalidateReviewsIndex } from '../../gate-runtime/reviews-index';
import { pruneAggregateLogLocked } from '../../gate-runtime/task-events';
import { resolveActiveTaskIds } from '../../core/active-task-state';
import { pruneTimelineSummaryEntries } from '../../gate-runtime/timeline-summary';
import { DEFAULT_METRICS_MAX_LINES, pruneMetricsFile } from '../../runtime/toxin-metrics';
import { validateTargetRoot } from '../lifecycle-common';
import { withLifecycleOperationLock } from '../lock/lifecycle-lock';
import { applyForensicCompressionPolicy, applyStoragePolicy, loadStoragePolicy } from './cleanup-storage-policy';
import { buildRuntimeRetentionPreview, loadRuntimeRetentionPolicy } from '../runtime-policy/runtime-retention-policy';
import {
    buildCategorySummary,
    cleanupStaleTaskEventLocks,
    collectIsolationSandbox,
    collectRuntimeRetentionCandidates,
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
const DEFAULT_MAX_BACKUPS = 10;
const DEFAULT_MAX_TASK_EVENTS = 50;
const DEFAULT_MAX_REVIEWS = 100;
const DEFAULT_MAX_WORKING_PLANS = 100;
const DEFAULT_MAX_UPDATE_REPORTS = 10;
const DEFAULT_MAX_UPDATE_ROLLBACKS = 10;
const DEFAULT_MAX_BUNDLE_BACKUPS = 10;
const DEFAULT_MAX_AGGREGATE_LINES = 10000;
const DEFAULT_MAX_METRICS_LINES = DEFAULT_METRICS_MAX_LINES;

export function buildDefaultRetentionPolicy(): RetentionPolicy {
    return {
        maxAgeDays: DEFAULT_MAX_AGE_DAYS,
        maxBackups: DEFAULT_MAX_BACKUPS,
        maxTaskEvents: DEFAULT_MAX_TASK_EVENTS,
        maxReviews: DEFAULT_MAX_REVIEWS,
        maxWorkingPlans: DEFAULT_MAX_WORKING_PLANS,
        maxUpdateReports: DEFAULT_MAX_UPDATE_REPORTS,
        maxUpdateRollbacks: DEFAULT_MAX_UPDATE_ROLLBACKS,
        maxBundleBackups: DEFAULT_MAX_BUNDLE_BACKUPS,
        maxAggregateLines: DEFAULT_MAX_AGGREGATE_LINES,
        maxMetricsLines: DEFAULT_MAX_METRICS_LINES
    };
}

export interface CleanupOptions {
    targetRoot: string;
    bundleRoot: string;
    dryRun?: boolean;
    retentionPolicy?: Partial<RetentionPolicy>;
    activeTaskIds?: string[];
    runtimeRetentionTaskLimit?: number;
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
    const runtimeRetentionCandidates = collectRuntimeRetentionCandidates(targetRoot, bundleRoot, activeTaskIds, {
        maxEligibleTasks: options.runtimeRetentionTaskLimit
    });
    const candidates = [
        ...collectStandardCandidates(runtimeDir, policy, now, activeTaskIds),
        ...runtimeRetentionCandidates.compactionCandidates
    ];
    const runtimeRetentionPreview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        runtimeRetentionCandidates.previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );
    const { removed, skipped, errors, totalFreedBytes } = processCleanupCandidates(candidates, dryRun, runtimeDir);

    if (!dryRun && removed.some((item) => item.category === 'reviews')) {
        try {
            invalidateReviewsIndex(path.join(runtimeDir, 'reviews'));
        } catch {
            // Best-effort cleanup.
        }
    }

    if (!dryRun && removed.some((item) => item.category === 'task-events')) {
        try {
            pruneTimelineSummaryEntries(path.join(runtimeDir, 'task-events'));
        } catch {
            // Best-effort cleanup.
        }
    }

    let aggregateRetention: CleanupResult['aggregateRetention'];
    if (!dryRun && policy.maxAggregateLines > 0) {
        try {
            aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
        } catch {
            // Best-effort cleanup.
        }
    }

    let metricsRetention: CleanupResult['metricsRetention'];
    if (!dryRun && policy.maxMetricsLines > 0) {
        try {
            const pruned = pruneMetricsFile(path.join(runtimeDir, 'metrics.jsonl'), policy.maxMetricsLines);
            metricsRetention = {
                pruned: pruned.pruned,
                lines_before: pruned.linesBefore,
                lines_after: pruned.linesAfter
            };
        } catch {
            // Best-effort cleanup.
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
        aggregateRetention,
        metricsRetention,
        runtimeRetentionPreview
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
    runtimeRetentionTaskLimit?: number;
    runtimeRetentionOnly?: boolean;
}

export function validateGcCategories(categories: string[]): void {
    for (const cat of categories) {
        if (!GC_ALLOWLIST.includes(cat)) {
            throw new Error(`Unknown gc category '${cat}'. Allowed: ${GC_ALLOWLIST.join(', ')}`);
        }
    }
}

export function runGc(options: GcOptions): GcResult {
    const { targetRoot, bundleRoot, confirm = false, runtimeRetentionOnly = false } = options;
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
    const runtimeRetentionCandidates = collectRuntimeRetentionCandidates(targetRoot, bundleRoot, activeTaskIds, {
        maxEligibleTasks: options.runtimeRetentionTaskLimit
    });
    const standardCandidates = runtimeRetentionOnly
        ? [...runtimeRetentionCandidates.compactionCandidates]
        : [
            ...collectStandardCandidates(runtimeDir, policy, now, activeTaskIds),
            ...runtimeRetentionCandidates.compactionCandidates
        ];
    const isolationItems = runtimeRetentionOnly ? [] : collectIsolationSandbox(runtimeDir, policy.maxAgeDays, now);
    const staleLockItems = runtimeRetentionOnly ? [] : collectStaleLifecycleLock(runtimeDir);
    const shouldCleanTaskEventLocks = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('task-events'));
    const taskEventLockCandidates = shouldCleanTaskEventLocks
        ? collectStaleTaskEventLockCandidates(bundleRoot)
        : [];

    let allCandidates = [...standardCandidates, ...isolationItems, ...staleLockItems];
    if (filterCategories) {
        allCandidates = allCandidates.filter((item) => filterCategories.has(item.category));
    }
    const runtimeRetentionPreview = buildRuntimeRetentionPreview(
        targetRoot,
        bundleRoot,
        runtimeRetentionCandidates.previewCandidates.map((item) => ({ path: item.path, category: item.category }))
    );

    const {
        removed,
        skipped,
        errors,
        totalFreedBytes: standardFreedBytes
    } = processCleanupCandidates(allCandidates, dryRun, runtimeDir);
    let totalFreedBytes = standardFreedBytes;

    if (!dryRun && removed.some((item) => item.category === 'reviews')) {
        try {
            invalidateReviewsIndex(path.join(runtimeDir, 'reviews'));
        } catch {
            // Best-effort cleanup.
        }
    }

    if (!dryRun && removed.some((item) => item.category === 'task-events')) {
        try {
            pruneTimelineSummaryEntries(path.join(runtimeDir, 'task-events'));
        } catch {
            // Best-effort cleanup.
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
            // Best-effort cleanup.
        }
    }

    const actionItems = dryRun ? skipped : removed;
    const isolationSandboxCleaned = actionItems.some((item) => item.category === 'isolation-sandbox');

    const shouldApplyStoragePolicy = !filterCategories || filterCategories.has('reviews');
    let storagePolicyResult: GcResult['storagePolicyResult'];
    if (shouldApplyStoragePolicy && confirm) {
        const storagePolicy = options.storagePolicy ?? loadStoragePolicy(bundleRoot);
        const retentionPolicyConfig = loadRuntimeRetentionPolicy(bundleRoot);
        const protectedReviewTaskIds = new Set(activeTaskIds);
        const forensicCompressionTaskIds = new Set<string>();
        for (const task of runtimeRetentionPreview.tasks) {
            const selectedByBoundedMaintenance = runtimeRetentionCandidates.selectedTaskIds.has(task.task_id);
            const compactableHealthyDone = task.health_state === 'healthy_done'
                && task.retention_tier === 'compact_ledger_candidate'
                && task.ledger_status === 'VERIFIED'
                && task.eligible_now;
            const compressableForensic = task.retention_tier === 'compressed_forensic_candidate'
                && task.eligible_now;
            if (
                compressableForensic
                && selectedByBoundedMaintenance
                && !retentionPolicyConfig.problemTasks.preserveDetailedEvidence
            ) {
                forensicCompressionTaskIds.add(task.task_id);
            }
            if (!(compactableHealthyDone && selectedByBoundedMaintenance)) {
                protectedReviewTaskIds.add(task.task_id);
            }
        }
        storagePolicyResult = applyStoragePolicy(
            path.join(runtimeDir, 'reviews'),
            storagePolicy,
            protectedReviewTaskIds,
            runtimeDir,
            runtimeRetentionCandidates.boundedTaskIds ?? undefined
        );
        const forensicCompressionResult = applyForensicCompressionPolicy(
            path.join(runtimeDir, 'reviews'),
            forensicCompressionTaskIds,
            runtimeDir
        );
        const forensicCompressed = new Set(forensicCompressionResult.compressed);
        storagePolicyResult.preserved = storagePolicyResult.preserved.filter((entry) => !forensicCompressed.has(entry));
        storagePolicyResult.compressed.push(...forensicCompressionResult.compressed);
        storagePolicyResult.preserved.push(...forensicCompressionResult.preserved);
    }

    const shouldPruneAggregate = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('task-events'));
    let aggregateRetention: GcResult['aggregateRetention'];
    if (shouldPruneAggregate && policy.maxAggregateLines > 0) {
        try {
            if (confirm) {
                aggregateRetention = pruneAggregateLogLocked(path.join(runtimeDir, 'task-events'), policy.maxAggregateLines, {}, activeTaskIds);
            }
        } catch {
            // Best-effort cleanup.
        }
    }

    const shouldPruneMetrics = !runtimeRetentionOnly && (!filterCategories || filterCategories.has('metrics'));
    let metricsRetention: GcResult['metricsRetention'];
    if (shouldPruneMetrics && policy.maxMetricsLines > 0) {
        try {
            if (confirm) {
                const pruned = pruneMetricsFile(path.join(runtimeDir, 'metrics.jsonl'), policy.maxMetricsLines);
                metricsRetention = {
                    pruned: pruned.pruned,
                    lines_before: pruned.linesBefore,
                    lines_after: pruned.linesAfter
                };
            }
        } catch {
            // Best-effort cleanup.
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
        aggregateRetention,
        metricsRetention,
        runtimeRetentionPreview
    };
}

export function runGcWithLock(options: GcOptions): GcResult {
    return withLifecycleOperationLock(options.targetRoot, 'gc', () => runGc(options));
}
