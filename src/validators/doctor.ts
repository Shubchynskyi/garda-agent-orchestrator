import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInitAnswersRelativePath } from '../core/constants';
import { pathExists } from '../core/fs';
import {
    collectTimelineSummaryForDoctor,
    type DoctorTimelineEvidence
} from '../gate-runtime/timeline-summary';
import { validateManifest } from './validate-manifest';
import { runVerify } from './verify';
import { getBundlePath, detectSourceBundleParity as getSourceBundleParity } from './workspace-layout';
import {
    readUpdateSentinel,
    readUninstallSentinel,
    getLifecycleOperationLockPath,
    type UpdateSentinelMetadata,
    type UninstallSentinelMetadata
} from '../lifecycle/common';
import {
    listRollbackSnapshotPaths,
    getRollbackSnapshotsRoot
} from '../lifecycle/rollback';
import { checkRuntimeMismatch, type RuntimeMismatchEvidence } from './doctor-runtime';
import { checkProfileHealth, type ProfileHealthEvidence } from './doctor-profile';
import {
    collectLockHealth,
    type LockHealthEvidence,
    type TaskEventLockScanResult,
    type TaskEventLockCleanupResult,
    type ReviewArtifactLockScanResult,
    type ReviewArtifactLockCleanupResult,
    type CompletionGateFinalizationLockScanResult
} from './doctor-lock-health';
import {
    checkPermissions,
    type PermissionCheckEvidence
} from './doctor-permissions';
import {
    collectManifestEvidence
} from './doctor-manifest';
import {
    collectComplianceEvidence
} from './doctor-compliance';
import type { ProtectedControlPlaneManifestEvidence } from '../gates/helpers';
import type { ProviderComplianceResult } from './provider-compliance';
import type { NestedBundleDuplicationResult } from './workspace-layout';

// Re-export extracted collectors for backward compatibility
export { checkRuntimeMismatch, type RuntimeMismatchEvidence } from './doctor-runtime';
export { checkProfileHealth, type ProfileHealthEvidence } from './doctor-profile';
export {
    collectLockHealth,
    type LockHealthEvidence,
    type LockHealthOptions
} from './doctor-lock-health';
export {
    checkPermissions,
    type PermissionCheckEvidence,
    type PermissionCheckEntry
} from './doctor-permissions';
export {
    collectManifestEvidence,
    type ManifestEvidence
} from './doctor-manifest';
export {
    collectComplianceEvidence,
    type ComplianceEvidence
} from './doctor-compliance';

interface DoctorOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath?: string;
    cleanupStaleLocks?: boolean;
    dryRun?: boolean;
    activeAgentFiles?: readonly string[];
}

export interface PartialStateEvidence {
    passed: boolean;
    update_sentinel: UpdateSentinelMetadata | null;
    uninstall_sentinel: UninstallSentinelMetadata | null;
    lifecycle_lock_exists: boolean;
    lifecycle_lock_owner: Record<string, unknown> | null;
    violations: string[];
}

export function checkPartialState(targetRoot: string): PartialStateEvidence {
    const bundlePath = getBundlePath(targetRoot);
    const violations: string[] = [];

    const updateSentinel = readUpdateSentinel(bundlePath);
    if (updateSentinel) {
        const fromVer = updateSentinel.fromVersion || 'unknown';
        const toVer = updateSentinel.toVersion || 'unknown';
        const started = updateSentinel.startedAt || 'unknown';
        violations.push(
            'Interrupted update detected (from ' + fromVer + ' to ' + toVer +
            ', started ' + started + '). Run update or rollback to recover.'
        );
    }

    const uninstallSentinel = readUninstallSentinel(targetRoot);
    if (uninstallSentinel) {
        const operation = uninstallSentinel.operation || 'uninstall';
        const started = uninstallSentinel.startedAt || 'unknown';
        violations.push(
            'Interrupted ' + operation + ' detected (started ' + started +
            '). Re-run uninstall or setup to recover.'
        );
    }

    const lockPath = getLifecycleOperationLockPath(targetRoot);
    const lockExists = fs.existsSync(lockPath);
    let lockOwner: Record<string, unknown> | null = null;
    if (lockExists) {
        const ownerPath = path.join(lockPath, 'owner.json');
        try {
            if (fs.existsSync(ownerPath)) {
                lockOwner = JSON.parse(fs.readFileSync(ownerPath, 'utf8')) as Record<string, unknown>;
            }
        } catch {
            // corrupt metadata is itself a partial-state signal
        }
        violations.push(
            'Lifecycle operation lock exists at ' + lockPath.replace(/\\/g, '/') +
            '. Another operation may be in progress, or a previous operation was interrupted.'
        );
    }

    return {
        passed: violations.length === 0,
        update_sentinel: updateSentinel,
        uninstall_sentinel: uninstallSentinel,
        lifecycle_lock_exists: lockExists,
        lifecycle_lock_owner: lockOwner,
        violations
    };
}

export interface RollbackHealthEvidence {
    passed: boolean;
    snapshots_root: string;
    snapshot_count: number;
    snapshots: RollbackSnapshotInfo[];
    violations: string[];
}

export interface RollbackSnapshotInfo {
    path: string;
    name: string;
    has_records: boolean;
    records_valid: boolean;
    records_error: string | null;
}

export function checkRollbackHealth(targetRoot: string): RollbackHealthEvidence {
    const snapshotsRoot = getRollbackSnapshotsRoot(targetRoot);
    const violations: string[] = [];
    const snapshots: RollbackSnapshotInfo[] = [];

    const snapshotPaths = listRollbackSnapshotPaths(targetRoot);

    for (const snapshotPath of snapshotPaths) {
        const name = path.basename(snapshotPath);
        const recordsPath = path.join(snapshotPath, 'rollback-records.json');
        const hasRecords = fs.existsSync(recordsPath);
        let recordsValid = false;
        let recordsError: string | null = null;

        if (hasRecords) {
            try {
                const parsed = JSON.parse(fs.readFileSync(recordsPath, 'utf8'));
                if (Array.isArray(parsed) && parsed.every(function (r: unknown) {
                    return typeof r === 'object' && r !== null &&
                        typeof (r as Record<string, unknown>).relativePath === 'string';
                })) {
                    recordsValid = true;
                } else {
                    recordsError = 'Invalid rollback-records.json structure';
                    violations.push('Snapshot ' + name + ': ' + recordsError);
                }
            } catch (err: unknown) {
                recordsError = getErrorMessage(err);
                violations.push('Snapshot ' + name + ': corrupt rollback-records.json — ' + recordsError);
            }
        } else {
            violations.push('Snapshot ' + name + ': missing rollback-records.json');
        }

        snapshots.push({
            path: snapshotPath.replace(/\\/g, '/'),
            name,
            has_records: hasRecords,
            records_valid: recordsValid,
            records_error: recordsError
        });
    }

    return {
        passed: violations.length === 0,
        snapshots_root: snapshotsRoot.replace(/\\/g, '/'),
        snapshot_count: snapshots.length,
        snapshots,
        violations
    };
}

export interface DoctorResult {
    passed: boolean;
    targetRoot: string;
    verifyResult: ReturnType<typeof runVerify>;
    manifestResult: ReturnType<typeof validateManifest> | null;
    manifestError: string | null;
    timelineEvidence: DoctorTimelineEvidence[];
    timelineWarnings: string[];
    lockHealth: TaskEventLockScanResult;
    lockCleanup: TaskEventLockCleanupResult | null;
    reviewLockHealth?: ReviewArtifactLockScanResult;
    reviewLockCleanup?: ReviewArtifactLockCleanupResult | null;
    completionFinalizationLockHealth?: CompletionGateFinalizationLockScanResult;
    parityResult: ReturnType<typeof getSourceBundleParity>;
    providerComplianceResult: ProviderComplianceResult | null;
    nestedBundleDuplication: NestedBundleDuplicationResult;
    protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null;
    runtimeMismatchEvidence: RuntimeMismatchEvidence;
    permissionEvidence: PermissionCheckEvidence;
    partialStateEvidence: PartialStateEvidence;
    rollbackHealthEvidence: RollbackHealthEvidence;
    profileHealthEvidence: ProfileHealthEvidence | null;
}

function getErrorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export function runDoctor(options: DoctorOptions): DoctorResult {
    const targetRoot = path.resolve(options.targetRoot);
    const initAnswersPath = options.initAnswersPath || resolveInitAnswersRelativePath();
    const bundlePath = getBundlePath(targetRoot);

    if (!pathExists(bundlePath)) {
        throw new Error(
            'Deployed bundle not found: '+bundlePath+'\n'+
            "Run 'npx garda-agent-orchestrator' first, then rerun 'doctor'."
        );
    }

    const verifyResult = runVerify({
        targetRoot: targetRoot,
        sourceOfTruth: options.sourceOfTruth,
        initAnswersPath: initAnswersPath
    });

    const manifestEvidence = collectManifestEvidence(bundlePath, targetRoot);
    const manifestResult = manifestEvidence.manifestResult;
    const manifestError = manifestEvidence.manifestError;
    const protectedManifestEvidence = manifestEvidence.protectedManifestEvidence;

    const parityResult = getSourceBundleParity(targetRoot);

    const timelineScan = collectTimelineSummaryForDoctor(bundlePath);

    const lockEvidence = collectLockHealth({
        bundlePath: bundlePath,
        cleanupStaleLocks: options.cleanupStaleLocks,
        dryRun: options.dryRun
    });
    const lockHealth = lockEvidence.lockHealth;
    const lockCleanup = lockEvidence.lockCleanup;
    const reviewLockHealth = lockEvidence.reviewLockHealth;
    const reviewLockCleanup = lockEvidence.reviewLockCleanup;
    const completionFinalizationLockHealth = lockEvidence.completionFinalizationLockHealth;

    const activeAgentFiles = options.activeAgentFiles || [];
    const complianceEvidence = collectComplianceEvidence(targetRoot, activeAgentFiles);
    const providerComplianceResult = complianceEvidence.providerComplianceResult;
    const nestedBundleDuplication = complianceEvidence.nestedBundleDuplication;

    const runtimeMismatchEvidence = checkRuntimeMismatch();

    const permissionEvidence = checkPermissions(targetRoot);

    const partialStateEvidence = checkPartialState(targetRoot);

    const rollbackHealthEvidence = checkRollbackHealth(targetRoot);

    let profileHealthEvidence: ProfileHealthEvidence | null = null;
    try {
        profileHealthEvidence = checkProfileHealth(targetRoot);
    } catch {
        // profile health check failure is non-fatal
    }

    const manifestPassed = manifestResult ? manifestResult.passed : false;
    const compliancePassed = providerComplianceResult === null || providerComplianceResult.passed;
    const protectedManifestOk = protectedManifestEvidence === null
        || protectedManifestEvidence.status === 'MATCH'
        || protectedManifestEvidence.status === 'MISSING';
    const profileHealthOk = profileHealthEvidence === null || !profileHealthEvidence.config_exists || profileHealthEvidence.passed;
    const passed = verifyResult.passed
        && manifestPassed
        && !manifestError
        && lockHealth.stale_count === 0
        && reviewLockHealth.stale_count === 0
        && completionFinalizationLockHealth.stale_count === 0
        && !parityResult.isStale
        && compliancePassed
        && !nestedBundleDuplication.duplicatesFound
        && protectedManifestOk
        && runtimeMismatchEvidence.passed
        && permissionEvidence.passed
        && partialStateEvidence.passed
        && rollbackHealthEvidence.passed
        && profileHealthOk;

    return {
        passed: passed,
        targetRoot: targetRoot,
        verifyResult: verifyResult,
        manifestResult: manifestResult,
        manifestError: manifestError,
        timelineEvidence: timelineScan.evidence,
        timelineWarnings: timelineScan.warnings,
        lockHealth: lockHealth,
        lockCleanup: lockCleanup,
        reviewLockHealth: reviewLockHealth,
        reviewLockCleanup: reviewLockCleanup,
        completionFinalizationLockHealth: completionFinalizationLockHealth,
        parityResult: parityResult,
        providerComplianceResult: providerComplianceResult,
        nestedBundleDuplication: nestedBundleDuplication,
        protectedManifestEvidence: protectedManifestEvidence,
        runtimeMismatchEvidence: runtimeMismatchEvidence,
        permissionEvidence: permissionEvidence,
        partialStateEvidence: partialStateEvidence,
        rollbackHealthEvidence: rollbackHealthEvidence,
        profileHealthEvidence: profileHealthEvidence
    };
}

// Re-export formatting functions for backward compatibility
export {
    formatDoctorResult,
    formatDoctorResultCompact,
    formatDoctorResultJson
} from './doctor-formatting';
