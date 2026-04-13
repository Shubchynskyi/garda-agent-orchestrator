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

interface ProtectedManifestLifecycleGuardOptions {
    repoRoot: string;
    orchestratorWork: boolean;
    phaseLabel: string;
    preflight?: Record<string, unknown> | null;
    manifestEvidence?: ProtectedControlPlaneManifestEvidence | null;
}

function buildRemediationSuffix(): string {
    return 'Run setup/update/reinit to refresh the trusted lifecycle baseline, or restart the task with --orchestrator-work if it intentionally changes orchestrator control-plane files.';
}

function getPreflightManifestStatus(preflight: Record<string, unknown> | null | undefined): string {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return String(triggers.protected_control_plane_manifest_status || '').trim().toUpperCase();
}

function getPreflightManifestChangedFiles(preflight: Record<string, unknown> | null | undefined): string[] {
    const triggers = toPlainRecord(preflight?.triggers) || {};
    return Array.isArray(triggers.protected_control_plane_manifest_changed_files)
        ? triggers.protected_control_plane_manifest_changed_files.map((entry) => String(entry)).filter(Boolean)
        : [];
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
    if (preflightManifestStatus === 'INVALID') {
        return {
            status: 'BLOCK',
            manifest_evidence: manifestEvidence,
            violations: [
                `Trusted protected control-plane manifest was already invalid before task start: ${normalizePath(manifestEvidence.manifest_path)}. ${buildRemediationSuffix()}`
            ]
        };
    }
    if (preflightManifestStatus === 'DRIFT') {
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
    if (manifestEvidence.status === 'DRIFT') {
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
