import { formatManifestResult } from './validate-manifest';
import { formatVerifyResult } from './verify';
import { getBundlePath } from './workspace-layout';
import {
    formatProviderComplianceDetail
} from './provider-compliance';
import { buildProfileAwareNextLine } from './task-command';
import type { DoctorResult } from './doctor';

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

    // Protected control-plane manifest early signal
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
            if (result.protectedManifestAssessment?.code === 'INFO_SOURCE_CHECKOUT') {
                lines.push('  Assessment: INFO_SOURCE_CHECKOUT');
                lines.push('  Impact: Informational in a self-hosted source checkout while protected source and generated bundle files evolve together.');
                lines.push('  Fix: Optional: re-run setup/update/reinit after intentional control-plane changes settle and you want to refresh the trusted manifest.');
            } else if (result.protectedManifestAssessment?.code === 'INFO_TASK_CONTEXT_ALLOWED_DRIFT') {
                lines.push('  Assessment: INFO_TASK_CONTEXT_ALLOWED_DRIFT');
                lines.push('  Impact: Informational because the current task context already explains this inherited protected drift.');
            } else {
                lines.push('  Fix: Re-run setup/update/reinit to refresh the trusted manifest, or verify changes are intentional.');
            }
        } else if (result.protectedManifestEvidence.status === 'INVALID') {
            lines.push('  Fix: Re-run setup/update/reinit to regenerate the trusted manifest.');
        }
        lines.push('');
    }

    // Timeline evidence summary
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

    // Provider control compliance detail
    if (result.providerComplianceResult) {
        var complianceLines = formatProviderComplianceDetail(result.providerComplianceResult);
        for (const cl of complianceLines) {
            lines.push(cl);
        }
        lines.push('');
    }

    // Nested bundle duplication warning
    if (result.nestedBundleDuplication.duplicatesFound) {
        lines.push('Nested Bundle Duplication (IDE Index Risk)');
        lines.push('  Status: DUPLICATES_FOUND');
        for (const dp of result.nestedBundleDuplication.duplicatePaths) {
            lines.push('  Duplicate: ' + dp);
        }
        lines.push('  Fix: Remove nested copies or ensure .vscode/settings.json excludes them from indexing.');
        lines.push('');
    }

    // Runtime mismatch
    lines.push('Runtime Compatibility');
    lines.push('  Node: ' + result.runtimeMismatchEvidence.current_node_version);
    lines.push('  Required: ' + result.runtimeMismatchEvidence.required_range);
    lines.push('  Status: ' + (result.runtimeMismatchEvidence.passed ? 'OK' : 'MISMATCH'));
    for (const rv of result.runtimeMismatchEvidence.violations) {
        lines.push('  - ' + rv);
    }
    lines.push('');

    // Permission checks
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

    // Partial-state detection
    if (!result.partialStateEvidence.passed) {
        lines.push('Partial State');
        lines.push('  Status: DETECTED');
        for (const pv of result.partialStateEvidence.violations) {
            lines.push('  - ' + pv);
        }
        lines.push('');
    }

    // Rollback health
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

    // Profile health
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
        lines.push('Doctor: PASSED');
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
        ? (result.manifestResult.passed ? 'PASSED' : 'FAIL')
        : (result.manifestError ? 'ERROR' : 'SKIPPED');
    const profileSuffix = result.profileHealthEvidence && result.profileHealthEvidence.active_profile
        ? ` | profile=${result.profileHealthEvidence.active_profile}`
        : '';
    return `Doctor: PASSED | verify=PASSED | manifest=${manifestStatus}${profileSuffix}`;
}

export function formatDoctorResultJson(result: DoctorResult): string {
    return JSON.stringify(result, null, 2);
}
