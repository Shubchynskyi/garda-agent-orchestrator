import * as path from 'node:path';

import {
    scanTaskEventLocks,
    type TaskEventLockHealth
} from '../gate-runtime/task-events';
import {
    scanReviewArtifactLocks,
    type ReviewArtifactLockHealth
} from '../gate-runtime/review-artifacts';

type RuntimeLockSubsystem = 'task-event' | 'review-artifact';

interface RuntimeLockConflict {
    subsystem: RuntimeLockSubsystem;
    lockName: string;
    lockPath: string;
    status: string;
    ownerPid: number | null;
    ownerHostname: string | null;
    staleReason: string | null;
    remediation: string;
}

function normalizeBundleRoot(bundleRoot: string): string {
    return path.resolve(bundleRoot);
}

function taskEventConflict(lock: TaskEventLockHealth): RuntimeLockConflict {
    return {
        subsystem: 'task-event',
        lockName: lock.lock_name,
        lockPath: lock.lock_path,
        status: lock.status,
        ownerPid: lock.owner_pid,
        ownerHostname: lock.owner_hostname,
        staleReason: lock.stale_reason,
        remediation: lock.remediation
    };
}

function reviewArtifactConflict(lock: ReviewArtifactLockHealth): RuntimeLockConflict {
    return {
        subsystem: 'review-artifact',
        lockName: lock.lock_name,
        lockPath: lock.lock_path,
        status: lock.status,
        ownerPid: lock.owner_pid,
        ownerHostname: lock.owner_hostname,
        staleReason: lock.stale_reason,
        remediation: lock.remediation
    };
}

function formatRuntimeLockConflict(conflict: RuntimeLockConflict): string {
    const ownerPid = conflict.ownerPid === null ? 'unknown' : String(conflict.ownerPid);
    const ownerHost = conflict.ownerHostname || 'unknown';
    const staleReason = conflict.staleReason || 'none';
    return [
        `${conflict.subsystem}:${conflict.lockName}`,
        `status=${conflict.status}`,
        `pid=${ownerPid}`,
        `host=${ownerHost}`,
        `stale_reason=${staleReason}`,
        `path=${conflict.lockPath}`,
        `fix=${conflict.remediation}`
    ].join('; ');
}

function collectRuntimeLockConflicts(bundleRoot: string): RuntimeLockConflict[] {
    const normalizedBundleRoot = normalizeBundleRoot(bundleRoot);
    return [
        ...scanTaskEventLocks(normalizedBundleRoot).locks.map(taskEventConflict),
        ...scanReviewArtifactLocks(normalizedBundleRoot).locks.map(reviewArtifactConflict)
    ];
}

export function assertNoRuntimeLocksBeforeUpdateApply(bundleRoot: string): void {
    const conflicts = collectRuntimeLockConflicts(bundleRoot);
    if (conflicts.length === 0) {
        return;
    }

    const formattedConflicts = conflicts.map(formatRuntimeLockConflict).join(' | ');
    throw new Error(
        `Runtime update preflight blocked apply because active or stale runtime locks exist. ` +
        `Resolve runtime task-event/review locks before updating the deployed bundle. ` +
        `Conflicts: ${formattedConflicts}`
    );
}
