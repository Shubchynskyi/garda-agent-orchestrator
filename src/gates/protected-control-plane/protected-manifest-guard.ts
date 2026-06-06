import {
    evaluateProtectedControlPlaneManifest,
    isOrchestratorSourceCheckout,
    normalizePath,
    toPlainRecord,
    type ProtectedControlPlaneManifestEvidence
} from '../shared/helpers';

export interface ProtectedManifestLifecycleGuardResult {
    status: 'ALLOW' | 'BLOCK';
    manifest_evidence: ProtectedControlPlaneManifestEvidence;
    violations: string[];
}

export interface ProtectedManifestBaselineAllowanceResult {
    status: 'NOT_APPLICABLE' | 'INHERITED_BASELINE_ONLY' | 'SOURCE_CHECKOUT_INHERITED_DRIFT';
    protected_files: string[];
    manifest_changed_files: string[];
}

interface ProtectedManifestLifecycleGuardOptions {
    repoRoot: string;
    orchestratorWork: boolean;
    phaseLabel: string;
    preflight?: Record<string, unknown> | null;
    manifestEvidence?: ProtectedControlPlaneManifestEvidence | null;
    dirtyWorkspaceProtectionStatus?: string | null;
    dirtyWorkspaceProtectedFiles?: string[] | null;
    restartCommandHint?: string;
}

function buildRemediationSuffix(): string {
    return 'Run next-step for the task to get the exact recovery command. Refresh the trusted lifecycle baseline with setup/update/reinit only for trusted baseline drift, or restart task mode with --orchestrator-work if this task intentionally changes orchestrator control-plane files.';
}

function normalizePathList(values: unknown): string[] {
    if (!Array.isArray(values)) {
        return [];
    }
    return [...new Set(
        values
            .map((entry) => normalizePath(entry))
            .filter(Boolean)
    )].sort();
}

function getPreflightManifestStatus(preflight: Record<string, unknown> | null | undefined): string {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return String(triggers.protected_control_plane_manifest_status || '').trim().toUpperCase();
}

function getPreflightManifestChangedFiles(preflight: Record<string, unknown> | null | undefined): string[] {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return normalizePathList(triggers.protected_control_plane_manifest_changed_files);
}

function getPreflightDirtyWorkspaceProtectionStatus(preflight: Record<string, unknown> | null | undefined): string {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return String(triggers.dirty_workspace_protection_status || '').trim().toUpperCase();
}

function getPreflightDirtyWorkspaceProtectedFiles(preflight: Record<string, unknown> | null | undefined): string[] {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return normalizePathList(triggers.dirty_workspace_protected_files);
}

export function evaluateProtectedManifestBaselineAllowance(options: {
    orchestratorWork?: boolean;
    manifestStatus: string;
    manifestChangedFiles: string[];
    dirtyWorkspaceProtectionStatus?: string | null;
    dirtyWorkspaceProtectedFiles?: string[] | null;
    sourceCheckoutInheritedDrift?: boolean;
}): ProtectedManifestBaselineAllowanceResult {
    const manifestStatus = String(options.manifestStatus || '').trim().toUpperCase();
    const manifestChangedFiles = normalizePathList(options.manifestChangedFiles);
    const dirtyWorkspaceProtectionStatus = String(options.dirtyWorkspaceProtectionStatus || '').trim().toUpperCase();
    const dirtyWorkspaceProtectedFiles = normalizePathList(options.dirtyWorkspaceProtectedFiles);

    if (options.orchestratorWork || manifestStatus !== 'DRIFT') {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (options.sourceCheckoutInheritedDrift && dirtyWorkspaceProtectedFiles.length === 0) {
        return {
            status: 'SOURCE_CHECKOUT_INHERITED_DRIFT',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (dirtyWorkspaceProtectionStatus !== 'PASS') {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    if (
        dirtyWorkspaceProtectedFiles.length === 0
        || manifestChangedFiles.length === 0
        || !manifestChangedFiles.every((entry) => dirtyWorkspaceProtectedFiles.includes(entry))
    ) {
        return {
            status: 'NOT_APPLICABLE',
            protected_files: dirtyWorkspaceProtectedFiles,
            manifest_changed_files: manifestChangedFiles
        };
    }
    return {
        status: 'INHERITED_BASELINE_ONLY',
        protected_files: dirtyWorkspaceProtectedFiles,
        manifest_changed_files: manifestChangedFiles
    };
}

export function getProtectedManifestLifecycleGuard(
    options: ProtectedManifestLifecycleGuardOptions
): ProtectedManifestLifecycleGuardResult {
    const manifestEvidence = options.manifestEvidence || evaluateProtectedControlPlaneManifest(options.repoRoot, null, true);
    const sourceCheckoutInheritedDrift = manifestEvidence.status === 'DRIFT'
        && manifestEvidence.manifest?.is_source_checkout === true
        && isOrchestratorSourceCheckout(options.repoRoot);
    if (options.orchestratorWork) {
        return {
            status: 'ALLOW',
            manifest_evidence: manifestEvidence,
            violations: []
        };
    }

    const preflightManifestStatus = getPreflightManifestStatus(options.preflight);
    const preflightManifestChangedFiles = getPreflightManifestChangedFiles(options.preflight);
    const dirtyWorkspaceProtectionStatus = String(
        options.dirtyWorkspaceProtectionStatus || getPreflightDirtyWorkspaceProtectionStatus(options.preflight)
    ).trim().toUpperCase();
    const dirtyWorkspaceProtectedFiles = normalizePathList(
        options.dirtyWorkspaceProtectedFiles || getPreflightDirtyWorkspaceProtectedFiles(options.preflight)
    );
    const preflightManifestAllowance = evaluateProtectedManifestBaselineAllowance({
        orchestratorWork: options.orchestratorWork,
        manifestStatus: preflightManifestStatus,
        manifestChangedFiles: preflightManifestChangedFiles.length > 0
            ? preflightManifestChangedFiles
            : manifestEvidence.changed_files,
        dirtyWorkspaceProtectionStatus,
        dirtyWorkspaceProtectedFiles,
        sourceCheckoutInheritedDrift
    });
    const currentManifestAllowance = evaluateProtectedManifestBaselineAllowance({
        orchestratorWork: options.orchestratorWork,
        manifestStatus: manifestEvidence.status,
        manifestChangedFiles: manifestEvidence.changed_files,
        dirtyWorkspaceProtectionStatus,
        dirtyWorkspaceProtectedFiles,
        sourceCheckoutInheritedDrift: sourceCheckoutInheritedDrift && (
            preflightManifestStatus !== 'DRIFT'
            || manifestEvidence.changed_files.every((entry) => preflightManifestChangedFiles.includes(entry))
        )
    });
    const preflightManifestAllowed = preflightManifestAllowance.status === 'INHERITED_BASELINE_ONLY'
        || preflightManifestAllowance.status === 'SOURCE_CHECKOUT_INHERITED_DRIFT';
    const currentManifestAllowed = currentManifestAllowance.status === 'INHERITED_BASELINE_ONLY'
        || currentManifestAllowance.status === 'SOURCE_CHECKOUT_INHERITED_DRIFT';
    if (preflightManifestStatus === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already invalid before task start: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (preflightManifestStatus === 'DRIFT' && !preflightManifestAllowed) {
        const driftFiles = preflightManifestChangedFiles.length > 0
            ? preflightManifestChangedFiles
            : manifestEvidence.changed_files;
        const remediation = options.restartCommandHint
            ? `Restart task mode with: ${options.restartCommandHint}`
            : buildRemediationSuffix();
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already drifted before task start: ${driftFiles.join(', ') || 'unknown protected files'}. ${remediation}`
            ]
        };
    }

    if (manifestEvidence.status === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest is invalid before ${options.phaseLabel}: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (manifestEvidence.status === 'DRIFT' && !currentManifestAllowed) {
        const driftFiles = manifestEvidence.changed_files.join(', ') || 'unknown protected files';
        const remediation = options.restartCommandHint
            ? `Restart task mode with: ${options.restartCommandHint}`
            : buildRemediationSuffix();
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest drift detected before ${options.phaseLabel}: ${driftFiles}. ${remediation}`
            ]
        };
    }

    return {
        status: 'ALLOW',
        manifest_evidence: manifestEvidence,
        violations: []
    };
}
