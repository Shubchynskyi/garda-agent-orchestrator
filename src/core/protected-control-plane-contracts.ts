import * as crypto from 'node:crypto';
import * as path from 'node:path';

import { joinOrchestratorPath, normalizePath } from './orchestrator-paths';

export interface ProtectedControlPlaneManifest {
    schema_version: 1;
    event_source: 'refresh-protected-control-plane-manifest';
    timestamp_utc: string;
    workspace_root: string;
    orchestrator_root: string;
    protected_roots: string[];
    protected_snapshot: Record<string, string>;
    protected_snapshot_sha256?: string;
    is_source_checkout: boolean;
}

export interface ProtectedControlPlaneManifestEvidence {
    status: 'MISSING' | 'INVALID' | 'MATCH' | 'DRIFT';
    manifest_path: string;
    changed_files: string[];
    manifest: ProtectedControlPlaneManifest | null;
}

/**
 * Resolve the persisted protected control-plane manifest without depending on a gate module.
 */
export function resolveProtectedControlPlaneManifestPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'protected-control-plane-manifest.json'));
}

/**
 * Build the stable aggregate digest used by protected control-plane evidence.
 */
export function computeProtectedSnapshotDigest(snapshot: Record<string, string> | null | undefined): string {
    const normalizedEntries = Object.entries(snapshot || {})
        .map(([protectedPath, sha256]) => [normalizePath(protectedPath), String(sha256 || '').trim().toLowerCase()] as const)
        .filter(([protectedPath]) => protectedPath !== '')
        .sort(([a], [b]) => a.localeCompare(b));
    return crypto
        .createHash('sha256')
        .update(JSON.stringify(normalizedEntries), 'utf8')
        .digest('hex')
        .toLowerCase();
}
