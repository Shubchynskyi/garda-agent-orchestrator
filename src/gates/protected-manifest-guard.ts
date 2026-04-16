import {
    evaluateProtectedControlPlaneManifest,
    normalizePath,
    toPlainRecord,
    type ProtectedControlPlaneManifestEvidence
} from './helpers';

export interface ProtectedManifestLifecycleGuardResult {
    status: 'ALLOW' | 'BLOCK';
    manifest_evidence: ProtectedControlPlaneManifestEvidence;
    violations: string[];
}

export interface ProtectedManifestBaselineAllowanceResult {
    status: 'NOT_APPLICABLE' | 'INHERITED_BASELINE_ONLY';
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
}

function buildRemediationSuffix(): string {
    return 'Run setup/update/reinit to refresh the trusted lifecycle baseline, or restart the task with --orchestrator-work if it intentionally changes orchestrator control-plane files.';
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
        dirtyWorkspaceProtectedFiles
    });
    const currentManifestAllowance = evaluateProtectedManifestBaselineAllowance({
        orchestratorWork: options.orchestratorWork,
        manifestStatus: manifestEvidence.status,
        manifestChangedFiles: manifestEvidence.changed_files,
        dirtyWorkspaceProtectionStatus,
        dirtyWorkspaceProtectedFiles
    });
    if (preflightManifestStatus === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already invalid before task start: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (preflightManifestStatus === 'DRIFT' && preflightManifestAllowance.status !== 'INHERITED_BASELINE_ONLY') {
        const driftFiles = preflightManifestChangedFiles.length > 0
            ? preflightManifestChangedFiles
            : manifestEvidence.changed_files;
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already drifted before task start: ${driftFiles.join(', ') || 'unknown protected files'}. ${buildRemediationSuffix()}`
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
    if (manifestEvidence.status === 'DRIFT' && currentManifestAllowance.status !== 'INHERITED_BASELINE_ONLY') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest drift detected before ${options.phaseLabel}: ${manifestEvidence.changed_files.join(', ') || 'unknown protected files'}. ${buildRemediationSuffix()}`
            ]
        };
    }

    return {
        status: 'ALLOW',
        manifest_evidence: manifestEvidence,
        violations: []
    };
}
