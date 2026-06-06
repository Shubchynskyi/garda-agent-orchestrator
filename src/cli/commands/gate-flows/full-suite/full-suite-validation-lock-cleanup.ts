import * as fs from 'node:fs';
import * as path from 'node:path';

import * as gateHelpers from '../../../../gates/shared/helpers';

const FULL_SUITE_GENERATED_LOCKS = Object.freeze([
    '.scripts-build.lock',
    '.node-build.lock',
    'dist.lock'
]);

export interface GeneratedLockCleanupObservation {
    readonly lock_path: string;
    readonly removed: boolean;
    readonly reason: string;
    readonly owner_pid: number | null;
    readonly owner_alive: boolean | null;
}

function readGeneratedLockOwnerPid(lockPath: string): number | null {
    const ownerPath = path.join(lockPath, 'owner.json');
    try {
        const parsed = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
        return Number.isInteger(parsed.pid) && Number(parsed.pid) > 0
            ? Number(parsed.pid)
            : null;
    } catch {
        return null;
    }
}

function isProcessAlive(pid: number | null): boolean | null {
    if (pid === null || !Number.isInteger(pid) || pid <= 0) {
        return null;
    }

    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        const code = error != null && typeof error === 'object' && 'code' in error
            ? String((error as { code?: unknown }).code || '')
            : '';
        if (code === 'ESRCH') {
            return false;
        }
        if (code === 'EPERM') {
            return true;
        }
        return null;
    }
}

export function cleanupGeneratedLocksAfterTimedOutFullSuite(repoRoot: string): GeneratedLockCleanupObservation[] {
    const observations: GeneratedLockCleanupObservation[] = [];
    const resolvedRoot = path.resolve(repoRoot);

    for (const lockName of FULL_SUITE_GENERATED_LOCKS) {
        const lockPath = path.resolve(resolvedRoot, lockName);
        if (!lockPath.startsWith(`${resolvedRoot}${path.sep}`)) {
            continue;
        }
        if (!fs.existsSync(lockPath) || !fs.statSync(lockPath).isDirectory()) {
            continue;
        }

        const ownerPid = readGeneratedLockOwnerPid(lockPath);
        const ownerAlive = isProcessAlive(ownerPid);
        if (ownerPid !== null && ownerAlive === false) {
            fs.rmSync(lockPath, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
            observations.push({
                lock_path: gateHelpers.normalizePath(lockPath),
                removed: true,
                reason: 'owner_process_dead_after_full_suite_timeout',
                owner_pid: ownerPid,
                owner_alive: false
            });
            continue;
        }

        observations.push({
            lock_path: gateHelpers.normalizePath(lockPath),
            removed: false,
            reason: ownerPid === null ? 'owner_pid_missing_or_unreadable' : 'owner_process_still_alive_or_unknown',
            owner_pid: ownerPid,
            owner_alive: ownerAlive
        });
    }

    return observations;
}

export function formatGeneratedLockCleanupObservation(observation: GeneratedLockCleanupObservation): string {
    const action = observation.removed ? 'removed' : 'retained';
    const ownerPid = observation.owner_pid === null ? 'unknown' : String(observation.owner_pid);
    const ownerAlive = observation.owner_alive === null ? 'unknown' : String(observation.owner_alive);
    return `Full-suite timeout cleanup ${action} generated lock ${observation.lock_path} `
        + `(reason=${observation.reason}; owner_pid=${ownerPid}; owner_alive=${ownerAlive}).`;
}
