import * as path from 'node:path';

import {
    withFilesystemLockAsync
} from '../../../../gate-runtime/timeline/task-events-locking';

const REVIEWER_LAUNCH_LANE_LOCK_TIMEOUT_MS = 30_000;
const REVIEWER_LAUNCH_LANE_LOCK_STALE_MS = 2 * 60 * 1000;

export const REVIEWER_LAUNCH_LANE_RESERVATION_EVIDENCE_TYPE =
    'reviewer_launch_lane_reservation';

export function getReviewerLaunchLaneTransactionLockPath(canonicalLaunchArtifactPath: string): string {
    return `${canonicalLaunchArtifactPath}.lane-transaction.lock`;
}

export function getReviewerLaunchLaneReservationPath(canonicalLaunchArtifactPath: string): string {
    return `${canonicalLaunchArtifactPath}.lane-reservation.json`;
}

export function getReviewerLaunchSemanticPathKey(pathValue: string): string {
    const normalizedPath = path.normalize(path.resolve(pathValue));
    return process.platform === 'win32'
        ? normalizedPath.toLowerCase()
        : normalizedPath;
}

export function reviewerLaunchPathsEqual(left: string, right: string): boolean {
    return getReviewerLaunchSemanticPathKey(left) === getReviewerLaunchSemanticPathKey(right);
}

export async function withReviewerLaunchLaneTransaction<T>(
    canonicalLaunchArtifactPath: string,
    callback: () => Promise<T>
): Promise<T> {
    const lockPath = getReviewerLaunchLaneTransactionLockPath(canonicalLaunchArtifactPath);
    const { result } = await withFilesystemLockAsync(lockPath, {
        timeoutMs: REVIEWER_LAUNCH_LANE_LOCK_TIMEOUT_MS,
        retryMs: 25,
        staleMs: REVIEWER_LAUNCH_LANE_LOCK_STALE_MS,
        heartbeatIntervalMs: 10_000,
        ownerLabel: 'reviewer-launch-lane'
    }, callback);
    return result;
}
