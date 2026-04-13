import type { ReviewArtifactRetentionMode } from '../schemas/config-schemas';

export type { ReviewArtifactRetentionMode };

export interface ReviewArtifactStoragePolicy {
    retentionMode: ReviewArtifactRetentionMode;
    compressAfterDays: number;
    compressionFormat: string;
    preserveGateReceipts: boolean;
    gateReceiptSuffixes: string[];
}

export interface StoragePolicyResult {
    compressed: string[];
    removed: string[];
    preserved: string[];
    retentionMode: ReviewArtifactRetentionMode;
}

export const GC_ALLOWLIST: readonly string[] = Object.freeze([
    'backups',
    'bundle-backups',
    'task-events',
    'reviews',
    'update-rollbacks',
    'update-reports',
    'isolation-sandbox',
    'stale-locks'
]);

export interface RetentionPolicy {
    maxAgeDays: number;
    maxBackups: number;
    maxTaskEvents: number;
    maxReviews: number;
    maxUpdateReports: number;
    maxUpdateRollbacks: number;
    maxBundleBackups: number;
    maxAggregateLines: number;
}

export interface CleanupItem {
    path: string;
    category: string;
    reason: string;
    sizeBytes: number;
}

export interface CleanupResult {
    targetRoot: string;
    dryRun: boolean;
    retentionPolicy: RetentionPolicy;
    removed: CleanupItem[];
    skipped: CleanupItem[];
    errors: Array<{ path: string; message: string }>;
    totalFreedBytes: number;
    result: string;
    aggregateRetention?: { pruned: boolean; lines_before: number; lines_after: number };
}

export interface GcResult extends CleanupResult {
    staleLocksCleaned: number;
    isolationSandboxCleaned: boolean;
    categories: Record<string, { count: number; bytes: number }>;
    storagePolicyResult?: StoragePolicyResult;
}
