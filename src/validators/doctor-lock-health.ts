import * as path from 'node:path';
import {
    cleanupStaleTaskEventLocks,
    scanTaskEventLocks,
    type TaskEventLockCleanupResult,
    type TaskEventLockScanResult
} from '../gate-runtime/task-events';
import {
    cleanupStaleReviewArtifactLocks,
    scanReviewArtifactLocks,
    type ReviewArtifactLockCleanupResult,
    type ReviewArtifactLockScanResult
} from '../gate-runtime/review-artifacts';
import {
    scanCompletionGateFinalizationLocks,
    type CompletionGateFinalizationLockScanResult
} from '../gates/locks/finalization-lock';

export interface LockHealthEvidence {
    lockHealth: TaskEventLockScanResult;
    lockCleanup: TaskEventLockCleanupResult | null;
    reviewLockHealth: ReviewArtifactLockScanResult;
    reviewLockCleanup: ReviewArtifactLockCleanupResult | null;
    completionFinalizationLockHealth: CompletionGateFinalizationLockScanResult;
}

export interface LockHealthOptions {
    bundlePath: string;
    cleanupStaleLocks?: boolean;
    dryRun?: boolean;
}

export function collectLockHealth(options: LockHealthOptions): LockHealthEvidence {
    const { bundlePath, cleanupStaleLocks, dryRun } = options;

    const lockCleanup = cleanupStaleLocks
        ? cleanupStaleTaskEventLocks(bundlePath, { dryRun: dryRun === true })
        : null;
    const lockHealth = scanTaskEventLocks(bundlePath);

    const reviewLockCleanup = cleanupStaleLocks
        ? cleanupStaleReviewArtifactLocks(bundlePath, { dryRun: dryRun === true })
        : null;
    const reviewLockHealth = scanReviewArtifactLocks(bundlePath);

    const completionFinalizationLockHealth = scanCompletionGateFinalizationLocks(
        path.join(bundlePath, 'runtime', 'reviews')
    );

    return {
        lockHealth,
        lockCleanup,
        reviewLockHealth,
        reviewLockCleanup,
        completionFinalizationLockHealth
    };
}

// Re-export types that doctor.ts consumers may need
export type {
    TaskEventLockScanResult,
    TaskEventLockCleanupResult,
    ReviewArtifactLockScanResult,
    ReviewArtifactLockCleanupResult,
    CompletionGateFinalizationLockScanResult
};
