import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveInitAnswersRelativePath } from '../core/constants';
import { pathExists } from '../core/fs';
import {
    collectTimelineSummaryForDoctor,
    type DoctorTimelineEvidence
} from '../gate-runtime/timeline-summary';
import { validateManifest, formatManifestResult } from './validate-manifest';
import { formatVerifyResult } from './verify';
import { runVerify } from './verify';
import { getBundlePath, detectSourceBundleParity as getSourceBundleParity } from './workspace-layout';
import {
    formatProviderComplianceDetail
} from './provider-compliance';
import { buildProfileAwareNextLine } from './task-command';
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

// ---------------------------------------------------------------------------
// Partial-state detection
// ---------------------------------------------------------------------------

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

    // Check for interrupted update
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

    // Check for interrupted uninstall
    const uninstallSentinel = readUninstallSentinel(targetRoot);
    if (uninstallSentinel) {
        const operation = uninstallSentinel.operation || 'uninstall';
        const started = uninstallSentinel.startedAt || 'unknown';
        violations.push(
            'Interrupted ' + operation + ' detected (started ' + started +
            '). Re-run uninstall or setup to recover.'
        );
    }

    // Check for stale lifecycle operation lock
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

// ---------------------------------------------------------------------------
// Rollback health check
// ---------------------------------------------------------------------------

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

interface DoctorResult {
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
    var targetRoot = path.resolve(options.targetRoot);
    var initAnswersPath = options.initAnswersPath || resolveInitAnswersRelativePath();
    var bundlePath = getBundlePath(targetRoot);

    if (!pathExists(bundlePath)) {
        throw new Error(
            'Deployed bundle not found: '+bundlePath+'\n'+
            "Run 'npx garda-agent-orchestrator' first, then rerun 'doctor'."
        );
    }

    var verifyResult = runVerify({
        targetRoot: targetRoot,
        sourceOfTruth: options.sourceOfTruth,
        initAnswersPath: initAnswersPath
    });

    // T-121: delegate manifest + protected manifest evidence collection
    var manifestEvidence = collectManifestEvidence(bundlePath, targetRoot);
    var manifestResult = manifestEvidence.manifestResult;
    var manifestError = manifestEvidence.manifestError;
    var protectedManifestEvidence = manifestEvidence.protectedManifestEvidence;

    // Detect stale deployed bundle in self-hosted checkouts.
    var parityResult = getSourceBundleParity(targetRoot);

    // T-002: use aggregate timeline summary for cheap health check (read-only)
    var timelineScan = collectTimelineSummaryForDoctor(bundlePath);

    // T-023: delegate lock-health evidence collection
    var lockEvidence = collectLockHealth({
        bundlePath: bundlePath,
        cleanupStaleLocks: options.cleanupStaleLocks,
        dryRun: options.dryRun
    });
    var lockHealth = lockEvidence.lockHealth;
    var lockCleanup = lockEvidence.lockCleanup;
    var reviewLockHealth = lockEvidence.reviewLockHealth;
    var reviewLockCleanup = lockEvidence.reviewLockCleanup;
    var completionFinalizationLockHealth = lockEvidence.completionFinalizationLockHealth;

    // T-121: delegate compliance evidence collection
    var activeAgentFiles = options.activeAgentFiles || [];
    var complianceEvidence = collectComplianceEvidence(targetRoot, activeAgentFiles);
    var providerComplianceResult = complianceEvidence.providerComplianceResult;
    var nestedBundleDuplication = complianceEvidence.nestedBundleDuplication;

    // T-012: runtime mismatch check
    var runtimeMismatchEvidence = checkRuntimeMismatch();

    // T-121: delegate permission checks on critical paths
    var permissionEvidence = checkPermissions(targetRoot);

    // T-012: partial-state detection (interrupted updates/uninstalls, stale locks)
    var partialStateEvidence = checkPartialState(targetRoot);

    // T-012: rollback snapshot health
    var rollbackHealthEvidence = checkRollbackHealth(targetRoot);

    // T-055: profile health check
    var profileHealthEvidence: ProfileHealthEvidence | null = null;
    try {
        profileHealthEvidence = checkProfileHealth(targetRoot);
    } catch {
        // profile health check failure is non-fatal
    }

    var manifestPassed = manifestResult ? manifestResult.passed : false;
    var compliancePassed = providerComplianceResult === null || providerComplianceResult.passed;
    var protectedManifestOk = protectedManifestEvidence === null
        || protectedManifestEvidence.status === 'MATCH'
        || protectedManifestEvidence.status === 'MISSING';
    var profileHealthOk = profileHealthEvidence === null || !profileHealthEvidence.config_exists || profileHealthEvidence.passed;
    var passed = verifyResult.passed && manifestPassed && !manifestError && lockHealth.stale_count === 0 && reviewLockHealth.stale_count === 0 && completionFinalizationLockHealth.stale_count === 0 && !parityResult.isStale && compliancePassed && !nestedBundleDuplication.duplicatesFound && protectedManifestOk && runtimeMismatchEvidence.passed && permissionEvidence.passed && partialStateEvidence.passed && rollbackHealthEvidence.passed && profileHealthOk;

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

export function formatDoctorResult(result: DoctorResult): string {
    var lines: string[] = [];
    lines.push(formatVerifyResult(result.verifyResult));
    lines.push('');

    // Source-vs-bundle parity summary.
    if (result.parityResult.isSourceCheckout) {
        lines.push('Source Parity (Self-hosted)');
        if (result.parityResult.isStale) {
            lines.push('  Status: STALE');
            for (var k = 0; k < result.parityResult.violations.length; k++) {
                lines.push('  Violation: ' + result.parityResult.violations[k]);
            }
            if (result.parityResult.remediation) {
                lines.push('  Fix: ' + result.parityResult.remediation);
            }
        } else {
            lines.push('  Status: MATCH');
            lines.push('  Version: ' + (result.parityResult.rootVersion || 'unknown'));
        }
        lines.push('');
    }

    if (result.manifestResult) lines.push(formatManifestResult(result.manifestResult));
    else if (result.manifestError) { lines.push('MANIFEST_VALIDATION_FAILED'); lines.push('Error: '+result.manifestError); }
    lines.push('');

    // T-009: protected control-plane manifest early signal
    if (result.protectedManifestEvidence) {
        lines.push('Protected Control-Plane Manifest');
        lines.push('  Status: '+result.protectedManifestEvidence.status);
        lines.push('  ManifestPath: '+result.protectedManifestEvidence.manifest_path);
        if (result.protectedManifestEvidence.status === 'DRIFT') {
            var driftFiles = result.protectedManifestEvidence.changed_files;
            lines.push('  DriftCount: '+driftFiles.length);
            for (var dfi = 0; dfi < driftFiles.length; dfi++) {
                lines.push('  - '+driftFiles[dfi]);
            }
            lines.push('  Fix: Re-run setup/update/reinit to refresh the trusted manifest, or verify changes are intentional.');
        } else if (result.protectedManifestEvidence.status === 'INVALID') {
            lines.push('  Fix: Re-run setup/update/reinit to regenerate the trusted manifest.');
        }
        lines.push('');
    }

    // T-004: timeline evidence summary
    if (result.timelineEvidence.length > 0) {
        lines.push('Timeline Evidence');
        for (var i = 0; i < result.timelineEvidence.length; i++) {
            var te = result.timelineEvidence[i];
            lines.push(
                '  ' + te.task_id + ': integrity=' + te.status +
                ', completeness=' + te.completeness_status +
                ' (' + te.integrity_event_count + ' events)'
            );
        }
        if (result.timelineWarnings.length > 0) {
            lines.push('Timeline Warnings');
            for (var j = 0; j < result.timelineWarnings.length; j++) {
                lines.push('  - ' + result.timelineWarnings[j]);
            }
        }
        lines.push('');
    }

    if (result.lockCleanup) {
        lines.push('Task-Event Lock Cleanup');
        lines.push('  Mode: ' + (result.lockCleanup.dry_run ? 'DRY_RUN' : 'APPLY'));
        lines.push('  LockRoot: ' + result.lockCleanup.lock_root);
        lines.push('  StaleCandidates: ' + result.lockCleanup.removable_stale_locks.length);
        lines.push('  Removed: ' + result.lockCleanup.removed_locks.length);
        if (result.lockCleanup.retained_live_locks.length > 0) {
            lines.push('  LiveLocksRetained: ' + result.lockCleanup.retained_live_locks.join(', '));
        }
        if (result.lockCleanup.failed_locks.length > 0) {
            lines.push('  CleanupFailures: ' + result.lockCleanup.failed_locks.join(', '));
        }
        for (const warning of result.lockCleanup.warnings) {
            lines.push('  Warning: ' + warning);
        }
        lines.push('');
    }

    if (result.lockHealth.locks.length > 0 || result.lockCleanup) {
        lines.push('Task-Event Locks');
        lines.push('  Scope: ' + result.lockHealth.subsystem_scope_note);
        lines.push(
            '  Summary: active=' + result.lockHealth.active_count +
            ', stale=' + result.lockHealth.stale_count
        );
        for (const lock of result.lockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + lock.status +
                ' scope=' + lock.scope +
                (lock.task_id ? ' task=' + lock.task_id : '') +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    if (result.reviewLockCleanup) {
        lines.push('Review Artifact Lock Cleanup');
        lines.push('  Mode: ' + (result.reviewLockCleanup.dry_run ? 'DRY_RUN' : 'APPLY'));
        lines.push('  LockRoot: ' + result.reviewLockCleanup.lock_root);
        lines.push('  StaleCandidates: ' + result.reviewLockCleanup.removable_stale_locks.length);
        lines.push('  Removed: ' + result.reviewLockCleanup.removed_locks.length);
        if (result.reviewLockCleanup.retained_live_locks.length > 0) {
            lines.push('  LiveLocksRetained: ' + result.reviewLockCleanup.retained_live_locks.join(', '));
        }
        if (result.reviewLockCleanup.failed_locks.length > 0) {
            lines.push('  CleanupFailures: ' + result.reviewLockCleanup.failed_locks.join(', '));
        }
        for (const warning of result.reviewLockCleanup.warnings) {
            lines.push('  Warning: ' + warning);
        }
        lines.push('');
    }

    if ((result.reviewLockHealth && result.reviewLockHealth.locks.length > 0) || result.reviewLockCleanup) {
        const reviewLockHealth = result.reviewLockHealth || {
            lock_root: '',
            subsystem_scope_note: '',
            locks: [],
            active_count: 0,
            stale_count: 0
        };
        lines.push('Review Artifact Locks');
        lines.push('  Scope: ' + reviewLockHealth.subsystem_scope_note);
        lines.push(
            '  Summary: active=' + reviewLockHealth.active_count +
            ', stale=' + reviewLockHealth.stale_count
        );
        for (const lock of reviewLockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + lock.status +
                (lock.task_id ? ' task=' + lock.task_id : '') +
                (lock.artifact_type ? ' artifact=' + lock.artifact_type : '') +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    if (result.completionFinalizationLockHealth && result.completionFinalizationLockHealth.locks.length > 0) {
        lines.push('Completion Finalization Locks');
        lines.push('  Scope: ' + result.completionFinalizationLockHealth.subsystem_scope_note);
        lines.push(
            '  AcquisitionPolicy: timeout=' + result.completionFinalizationLockHealth.acquisition_policy.timeout_ms +
            'ms, retry=' + result.completionFinalizationLockHealth.acquisition_policy.retry_ms +
            'ms, stale_after=' + result.completionFinalizationLockHealth.acquisition_policy.stale_after_ms + 'ms'
        );
        lines.push(
            '  Summary: active=' + result.completionFinalizationLockHealth.active_count +
            ', stale=' + result.completionFinalizationLockHealth.stale_count
        );
        lines.push('  Cleanup: doctor --cleanup-stale-locks does not remove completion finalization locks automatically.');
        for (const lock of result.completionFinalizationLockHealth.locks) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
            const ownerAliveText = lock.owner_alive === null ? 'unknown' : (lock.owner_alive ? 'yes' : 'no');
            const ownerHostText = lock.owner_hostname || 'unknown';
            lines.push(
                '  ' + lock.lock_name + ': ' + (lock.stale ? 'STALE' : 'ACTIVE') +
                ' task=' + lock.task_id +
                ' age=' + ageText +
                ' owner_pid=' + ownerPidText +
                ' owner_alive=' + ownerAliveText +
                ' owner_host=' + ownerHostText +
                ' metadata=' + lock.owner_metadata_status +
                ' stale_reason=' + (lock.stale_reason || 'none')
            );
            lines.push('    Fix: ' + lock.remediation);
        }
        lines.push('');
    }

    // T-1006: provider control compliance detail
    if (result.providerComplianceResult) {
        var complianceLines = formatProviderComplianceDetail(result.providerComplianceResult);
        for (const cl of complianceLines) {
            lines.push(cl);
        }
        lines.push('');
    }

    // T-1008: nested bundle duplication warning
    if (result.nestedBundleDuplication.duplicatesFound) {
        lines.push('Nested Bundle Duplication (IDE Index Risk)');
        lines.push('  Status: DUPLICATES_FOUND');
        for (const dp of result.nestedBundleDuplication.duplicatePaths) {
            lines.push('  Duplicate: ' + dp);
        }
        lines.push('  Fix: Remove nested copies or ensure .vscode/settings.json excludes them from indexing.');
        lines.push('');
    }

    // T-012: runtime mismatch
    lines.push('Runtime Compatibility');
    lines.push('  Node: ' + result.runtimeMismatchEvidence.current_node_version);
    lines.push('  Required: ' + result.runtimeMismatchEvidence.required_range);
    lines.push('  Status: ' + (result.runtimeMismatchEvidence.passed ? 'OK' : 'MISMATCH'));
    for (const rv of result.runtimeMismatchEvidence.violations) {
        lines.push('  - ' + rv);
    }
    lines.push('');

    // T-012: permission checks
    var permFailed = result.permissionEvidence.checks.filter(function (c) {
        return c.exists && !c.accessible;
    });
    if (permFailed.length > 0 || !result.permissionEvidence.passed) {
        lines.push('Permission Checks');
        lines.push('  Status: FAIL');
        for (const pf of permFailed) {
            lines.push('  ' + pf.path + ' (' + pf.kind + '): ' + (pf.error || 'not accessible'));
        }
        lines.push('  Fix: Ensure the current user has read/write access to the listed paths.');
        lines.push('');
    }

    // T-012: partial-state detection
    if (!result.partialStateEvidence.passed) {
        lines.push('Partial State');
        lines.push('  Status: DETECTED');
        for (const pv of result.partialStateEvidence.violations) {
            lines.push('  - ' + pv);
        }
        lines.push('');
    }

    // T-012: rollback health
    if (result.rollbackHealthEvidence.snapshot_count > 0) {
        lines.push('Rollback Snapshots');
        lines.push('  Root: ' + result.rollbackHealthEvidence.snapshots_root);
        lines.push('  Count: ' + result.rollbackHealthEvidence.snapshot_count);
        lines.push('  Status: ' + (result.rollbackHealthEvidence.passed ? 'HEALTHY' : 'DEGRADED'));
        for (const snap of result.rollbackHealthEvidence.snapshots) {
            lines.push(
                '  ' + snap.name + ': records=' + (snap.has_records ? 'present' : 'MISSING') +
                (snap.has_records ? ' valid=' + (snap.records_valid ? 'yes' : 'no') : '')
            );
        }
        if (result.rollbackHealthEvidence.violations.length > 0) {
            for (const rbv of result.rollbackHealthEvidence.violations) {
                lines.push('  Warning: ' + rbv);
            }
        }
        lines.push('');
    }

    // T-055: profile health
    if (result.profileHealthEvidence) {
        lines.push('Profile Health');
        if (result.profileHealthEvidence.config_exists) {
            lines.push('  ActiveProfile: ' + (result.profileHealthEvidence.active_profile || 'none'));
            if (result.profileHealthEvidence.profile_source) {
                lines.push('  ProfileSource: ' + result.profileHealthEvidence.profile_source);
            }
            lines.push('  ProfileCount: ' + result.profileHealthEvidence.profile_count);
            lines.push('  Status: ' + (result.profileHealthEvidence.passed ? 'HEALTHY' : 'DEGRADED'));
            for (const pv of result.profileHealthEvidence.violations) {
                lines.push('  - ' + pv);
            }
        } else {
            lines.push('  Status: NOT_CONFIGURED');
        }
        lines.push('');
    }

    if (result.passed) {
        lines.push('Doctor: PASS');
        lines.push(buildProfileAwareNextLine(getBundlePath(result.targetRoot)));
    }
    else { lines.push('Doctor: FAIL'); lines.push('Resolve listed issues and rerun doctor.'); }
    return lines.join('\n');
}

/**
 * Format doctor result in compact mode.
 * On success: single summary line. On failure: full output (delegates to formatDoctorResult).
 */
export function formatDoctorResultCompact(result: DoctorResult): string {
    if (!result.passed) {
        return formatDoctorResult(result);
    }
    const manifestStatus = result.manifestResult
        ? (result.manifestResult.passed ? 'PASS' : 'FAIL')
        : (result.manifestError ? 'ERROR' : 'SKIPPED');
    const profileSuffix = result.profileHealthEvidence && result.profileHealthEvidence.active_profile
        ? ` | profile=${result.profileHealthEvidence.active_profile}`
        : '';
    return `Doctor: PASS | verify=PASS | manifest=${manifestStatus}${profileSuffix}`;
}

export function formatDoctorResultJson(result: DoctorResult): string {
    return JSON.stringify(result, null, 2);
}
