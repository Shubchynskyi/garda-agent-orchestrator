import * as fs from 'node:fs';
import * as path from 'node:path';
import { resolveBundleName, resolveInitAnswersRelativePath, NODE_ENGINE_RANGE } from '../core/constants';
import { pathExists } from '../core/fs';
import {
    cleanupStaleTaskEventLocks,
    scanTaskEventLocks,
    type TaskEventLockCleanupResult,
    type TaskEventLockHealth,
    type TaskEventLockScanResult
} from '../gate-runtime/task-events';
import {
    collectTimelineSummaryForDoctor,
    type DoctorTimelineEvidence
} from '../gate-runtime/timeline-summary';
import { validateManifest, formatManifestResult } from './validate-manifest';
import { formatVerifyResult } from './verify';
import { runVerify } from './verify';
import { getBundlePath, detectSourceBundleParity as getSourceBundleParity, detectNestedBundleDuplication, type NestedBundleDuplicationResult } from './workspace-layout';
import {
    scanProviderCompliance,
    formatProviderComplianceDetail,
    type ProviderComplianceResult
} from './provider-compliance';
import {
    evaluateProtectedControlPlaneManifest,
    type ProtectedControlPlaneManifestEvidence
} from '../gates/helpers';
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

interface DoctorOptions {
    targetRoot: string;
    sourceOfTruth: string;
    initAnswersPath?: string;
    cleanupStaleLocks?: boolean;
    dryRun?: boolean;
    activeAgentFiles?: readonly string[];
}

// ---------------------------------------------------------------------------
// Runtime mismatch check
// ---------------------------------------------------------------------------

export interface RuntimeMismatchEvidence {
    passed: boolean;
    current_node_version: string;
    required_range: string;
    violations: string[];
}

/**
 * Parse a `>=X.Y.Z` range and test whether the running Node.js version
 * satisfies it.  Handles optional `v` prefix and missing minor/patch.
 */
export function checkRuntimeMismatch(): RuntimeMismatchEvidence {
    const currentVersion = process.version;
    const requiredRange = NODE_ENGINE_RANGE;
    const violations: string[] = [];

    const rangeMatch = requiredRange.match(/^>=\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
    if (!rangeMatch) {
        violations.push('Unable to parse engine range: ' + requiredRange);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations };
    }

    const requiredMajor = Number(rangeMatch[1]);
    const requiredMinor = rangeMatch[2] !== undefined ? Number(rangeMatch[2]) : 0;
    const requiredPatch = rangeMatch[3] !== undefined ? Number(rangeMatch[3]) : 0;

    const versionMatch = currentVersion.match(/^v?(\d+)\.(\d+)\.(\d+)/);
    if (!versionMatch) {
        violations.push('Unable to parse current Node.js version: ' + currentVersion);
        return { passed: false, current_node_version: currentVersion, required_range: requiredRange, violations };
    }

    const currentMajor = Number(versionMatch[1]);
    const currentMinor = Number(versionMatch[2]);
    const currentPatch = Number(versionMatch[3]);

    const satisfies =
        currentMajor > requiredMajor ||
        (currentMajor === requiredMajor && currentMinor > requiredMinor) ||
        (currentMajor === requiredMajor && currentMinor === requiredMinor && currentPatch >= requiredPatch);

    if (!satisfies) {
        violations.push(
            'Node.js ' + currentVersion + ' does not satisfy required range ' + requiredRange +
            '. Upgrade to ' + NODE_ENGINE_RANGE + ' or later.'
        );
    }

    return {
        passed: violations.length === 0,
        current_node_version: currentVersion,
        required_range: requiredRange,
        violations
    };
}

// ---------------------------------------------------------------------------
// Permission check
// ---------------------------------------------------------------------------

export interface PermissionCheckEvidence {
    passed: boolean;
    checks: PermissionCheckEntry[];
}

export interface PermissionCheckEntry {
    path: string;
    kind: 'read' | 'write';
    exists: boolean;
    accessible: boolean;
    error: string | null;
}

const CRITICAL_WRITABLE_RELATIVE_PATHS: readonly string[] = [
    resolveBundleName() + '/runtime',
    resolveBundleName() + '/live/config'
];

const CRITICAL_READABLE_RELATIVE_PATHS: readonly string[] = [
    resolveBundleName() + '/VERSION',
    resolveBundleName() + '/MANIFEST.md'
];

export function checkPermissions(targetRoot: string): PermissionCheckEvidence {
    const checks: PermissionCheckEntry[] = [];

    for (const relPath of CRITICAL_WRITABLE_RELATIVE_PATHS) {
        const absPath = path.join(targetRoot, relPath);
        const entry: PermissionCheckEntry = {
            path: relPath,
            kind: 'write',
            exists: false,
            accessible: false,
            error: null
        };
        try {
            entry.exists = fs.existsSync(absPath);
            if (entry.exists) {
                fs.accessSync(absPath, fs.constants.W_OK);
                entry.accessible = true;
            } else {
                // Parent must be writable for directory creation
                const parentPath = path.dirname(absPath);
                if (fs.existsSync(parentPath)) {
                    fs.accessSync(parentPath, fs.constants.W_OK);
                    entry.accessible = true;
                } else {
                    entry.error = 'Parent directory does not exist: ' + parentPath;
                }
            }
        } catch (err: unknown) {
            entry.error = getErrorMessage(err);
        }
        checks.push(entry);
    }

    for (const relPath of CRITICAL_READABLE_RELATIVE_PATHS) {
        const absPath = path.join(targetRoot, relPath);
        const entry: PermissionCheckEntry = {
            path: relPath,
            kind: 'read',
            exists: false,
            accessible: false,
            error: null
        };
        try {
            entry.exists = fs.existsSync(absPath);
            if (entry.exists) {
                fs.accessSync(absPath, fs.constants.R_OK);
                entry.accessible = true;
            }
        } catch (err: unknown) {
            entry.error = getErrorMessage(err);
        }
        checks.push(entry);
    }

    const passed = checks.every(function (c) {
        return !c.exists || c.accessible;
    });

    return { passed, checks };
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

// ---------------------------------------------------------------------------
// Profile health check
// ---------------------------------------------------------------------------

export interface ProfileHealthEvidence {
    passed: boolean;
    active_profile: string | null;
    profile_source: 'built_in' | 'user' | null;
    config_path: string;
    config_exists: boolean;
    profile_count: number;
    violations: string[];
}

export function checkProfileHealth(targetRoot: string): ProfileHealthEvidence {
    const bundlePath = getBundlePath(targetRoot);
    const configPath = path.join(bundlePath, 'live', 'config', 'profiles.json');
    const violations: string[] = [];
    let activeProfile: string | null = null;
    let profileSource: 'built_in' | 'user' | null = null;
    let profileCount = 0;
    let configExists = false;

    if (!pathExists(configPath)) {
        violations.push('Profiles config not found: ' + configPath.replace(/\\/g, '/'));
        return { passed: false, active_profile: null, profile_source: null, config_path: configPath.replace(/\\/g, '/'), config_exists: false, profile_count: 0, violations };
    }
    configExists = true;

    try {
        const raw = JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
        const builtIn = raw.built_in_profiles && typeof raw.built_in_profiles === 'object' && !Array.isArray(raw.built_in_profiles)
            ? raw.built_in_profiles as Record<string, unknown> : {};
        const user = raw.user_profiles && typeof raw.user_profiles === 'object' && !Array.isArray(raw.user_profiles)
            ? raw.user_profiles as Record<string, unknown> : {};
        profileCount = Object.keys(builtIn).length + Object.keys(user).length;

        if (typeof raw.active_profile !== 'string' || !raw.active_profile.trim()) {
            violations.push('Profiles config has no active_profile set.');
        } else {
            activeProfile = raw.active_profile.trim();
            if (Object.hasOwn(builtIn, activeProfile)) {
                profileSource = 'built_in';
            } else if (Object.hasOwn(user, activeProfile)) {
                profileSource = 'user';
            } else {
                violations.push('Active profile \'' + activeProfile + '\' does not match any defined profile.');
            }
        }

        if (Object.keys(builtIn).length === 0) {
            violations.push('At least one built-in profile is required.');
        }
    } catch (err: unknown) {
        violations.push('Profiles config is invalid JSON: ' + getErrorMessage(err));
    }

    return {
        passed: violations.length === 0,
        active_profile: activeProfile,
        profile_source: profileSource,
        config_path: configPath.replace(/\\/g, '/'),
        config_exists: configExists,
        profile_count: profileCount,
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

    var manifestPath = path.join(bundlePath, 'MANIFEST.md');
    var manifestResult = null;
    var manifestError = null;

    try { manifestResult = validateManifest(manifestPath, targetRoot); }
    catch (err: unknown) { manifestError = getErrorMessage(err); }

    // Detect stale deployed bundle in self-hosted checkouts.
    var parityResult = getSourceBundleParity(targetRoot);

    // T-002: use aggregate timeline summary for cheap health check (read-only)
    var timelineScan = collectTimelineSummaryForDoctor(bundlePath);
    var lockCleanup = options.cleanupStaleLocks
        ? cleanupStaleTaskEventLocks(bundlePath, { dryRun: options.dryRun === true })
        : null;
    var lockHealth = scanTaskEventLocks(bundlePath);

    // T-1006: provider-control compliance scan
    var providerComplianceResult: ProviderComplianceResult | null = null;
    var activeAgentFiles = options.activeAgentFiles || [];
    if (activeAgentFiles.length > 0) {
        try {
            providerComplianceResult = scanProviderCompliance(targetRoot, activeAgentFiles);
        } catch {
            // compliance scan failure is non-fatal; will show as null in output
        }
    }

    // T-1008: detect nested deployed bundle duplication
    var nestedBundleDuplication = detectNestedBundleDuplication(targetRoot);

    // T-009: protected control-plane manifest early signal
    var protectedManifestEvidence: ProtectedControlPlaneManifestEvidence | null = null;
    try {
        protectedManifestEvidence = evaluateProtectedControlPlaneManifest(targetRoot, null, true);
    } catch {
        // evaluation failure is non-fatal; will show as null in output
    }

    // T-012: runtime mismatch check
    var runtimeMismatchEvidence = checkRuntimeMismatch();

    // T-012: permission checks on critical paths
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
    var passed = verifyResult.passed && manifestPassed && !manifestError && lockHealth.stale_count === 0 && !parityResult.isStale && compliancePassed && !nestedBundleDuplication.duplicatesFound && protectedManifestOk && runtimeMismatchEvidence.passed && permissionEvidence.passed && partialStateEvidence.passed && rollbackHealthEvidence.passed && profileHealthOk;

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

    if (result.passed) { lines.push('Doctor: PASS'); lines.push('Next: Execute task T-001 depth=2'); }
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
