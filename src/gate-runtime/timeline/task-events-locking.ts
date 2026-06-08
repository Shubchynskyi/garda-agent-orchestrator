export { FOREIGN_HOST_FILE_LOCK_STALE_RECOVERY_ENV } from '../task-events-locking-types';
export type {
    AcquireLockTelemetry,
    LockContentionLevel,
    LockFreshness,
    LockFreshnessSource,
    LockHandle,
    LockInspectionResult,
    LockOptions,
    LockOwnerMetadata,
    LockWaitDiagnostics,
    TaskEventLockCleanupResult,
    TaskEventLockHealth,
    TaskEventLockScanResult,
    TaskEventLockStatus
} from '../task-events-locking-types';
export { classifyLockContention } from '../task-events-locking-support';
export {
    filesystemLockRequiresExplicitForeignHostRecovery,
    inspectFilesystemLock,
    isForeignHostFilesystemLockRecoveryAllowed,
    reclaimStaleFilesystemLock
} from '../task-events-locking-inspection';
export { removeLockPathWithRetry, renameLockPathWithRetry } from '../task-events-locking-release';
export { acquireFilesystemLock, acquireFilesystemLockAsync, releaseFilesystemLock, withFilesystemLock, withFilesystemLockAsync } from '../task-events-locking-acquire';
export { cleanupStaleTaskEventLocks, scanTaskEventLocks } from '../task-events-locking-health';
export { buildLockWaitDiagnostics } from '../task-events-locking-diagnostics';
