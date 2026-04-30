import * as fs from 'node:fs';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import { writeFileAtomically } from '../core/filesystem';
import {
    ALL_AGENT_ENTRYPOINT_FILES,
    isRecognizedPackageName,
    resolveBundleNameForTarget
} from '../core/constants';
import {
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
    getGitHubSkillBridgeProfileDefinitions,
    getProviderOrchestratorProfileDefinitions
} from '../materialization/common';
import { scanProtectedPathHashesIncremental } from './protected-hash-cache';
import { normalizePath, joinOrchestratorPath } from './path-utils';

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
 * Detect whether repoRoot is the orchestrator source checkout itself.
 */
export function isOrchestratorSourceCheckout(repoRoot: string): boolean {
    const packageJsonPath = path.join(path.resolve(repoRoot), 'package.json');
    if (!fs.existsSync(packageJsonPath) || !fs.statSync(packageJsonPath).isFile()) {
        return false;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8')) as Record<string, unknown>;
        return isRecognizedPackageName(parsed.name);
    } catch {
        return false;
    }
}

/**
 * Return protected control-plane roots for this workspace.
 * Ordinary workspaces protect only the deployed bundle.
 * The orchestrator source checkout additionally protects root-level runtime sources.
 */
export function getProtectedControlPlaneRoots(repoRoot: string): string[] {
    const effectiveName = resolveBundleNameForTarget(repoRoot);
    const roots = [
        `${effectiveName}/src/bin/`,
        `${effectiveName}/src/cli/`,
        `${effectiveName}/src/gates/`,
        `${effectiveName}/src/gate-runtime/`,
        `${effectiveName}/src/lifecycle/`,
        `${effectiveName}/src/materialization/`,
        `${effectiveName}/bin/`,
        `${effectiveName}/dist/`,
        `${effectiveName}/live/docs/agent-rules/`,
        SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
        ...ALL_AGENT_ENTRYPOINT_FILES,
        ...getProviderOrchestratorProfileDefinitions().map((profile) => profile.orchestratorRelativePath),
        ...getGitHubSkillBridgeProfileDefinitions().map((profile) => profile.relativePath)
    ];

    if (isOrchestratorSourceCheckout(repoRoot)) {
        roots.push(
            'src/bin/',
            'src/cli/',
            'src/gates/',
            'src/gate-runtime/',
            'src/lifecycle/',
            'src/materialization/',
            'bin/',
            'dist/',
            'live/docs/agent-rules/'
        );
    }

    return normalizeProtectedControlPlaneRoots(roots);
}

/**
 * Scan protected roots recursively and return a map of path -> sha256 hash.
 * Delegates to the incremental implementation that uses a persisted metadata
 * cache (mtime + size) to skip unchanged files while preserving identical
 * drift-detection semantics.
 */
export function scanProtectedPathHashes(repoRoot: string, protectedRoots: string[], readOnly: boolean = false): Record<string, string> {
    return scanProtectedPathHashesIncremental(repoRoot, protectedRoots, readOnly);
}

/**
 * Resolve the persisted protected control-plane manifest path.
 */
export function resolveProtectedControlPlaneManifestPath(repoRoot: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'protected-control-plane-manifest.json'));
}

/**
 * Build the current trusted protected control-plane manifest from the workspace.
 */
export function buildProtectedControlPlaneManifest(repoRoot: string): ProtectedControlPlaneManifest {
    const normalizedRepoRoot = path.resolve(repoRoot);
    const protectedRoots = getProtectedControlPlaneRoots(normalizedRepoRoot);
    const manifestPath = resolveProtectedControlPlaneManifestPath(normalizedRepoRoot);
    const protectedSnapshot = scanProtectedPathHashes(normalizedRepoRoot, protectedRoots);
    return {
        schema_version: 1,
        event_source: 'refresh-protected-control-plane-manifest',
        timestamp_utc: new Date().toISOString(),
        workspace_root: normalizePath(normalizedRepoRoot),
        orchestrator_root: normalizePath(path.dirname(path.dirname(manifestPath))),
        protected_roots: protectedRoots,
        protected_snapshot: protectedSnapshot,
        protected_snapshot_sha256: computeProtectedSnapshotDigest(protectedSnapshot),
        is_source_checkout: isOrchestratorSourceCheckout(normalizedRepoRoot)
    };
}

/**
 * Persist the trusted protected control-plane manifest after a lifecycle action.
 */
export function writeProtectedControlPlaneManifest(repoRoot: string): string {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const manifest = buildProtectedControlPlaneManifest(repoRoot);
    writeFileAtomically(manifestPath, JSON.stringify(manifest, null, 2), { encoding: 'utf8' });
    return manifestPath;
}

/**
 * Compare the current protected snapshot with the last trusted lifecycle manifest.
 */
export function evaluateProtectedControlPlaneManifest(
    repoRoot: string,
    currentSnapshot?: Record<string, string> | null,
    readOnly: boolean = false
): ProtectedControlPlaneManifestEvidence {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    const normalizedManifestPath = normalizePath(manifestPath);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return {
            status: 'MISSING',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    let manifestObject: ProtectedControlPlaneManifest;
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        if (
            !parsed
            || typeof parsed !== 'object'
            || Array.isArray(parsed)
            || !parsed.protected_snapshot
            || typeof parsed.protected_snapshot !== 'object'
            || Array.isArray(parsed.protected_snapshot)
        ) {
            return {
                status: 'INVALID',
                manifest_path: normalizedManifestPath,
                changed_files: [],
                manifest: null
            };
        }
        manifestObject = parsed as unknown as ProtectedControlPlaneManifest;
    } catch {
        return {
            status: 'INVALID',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: null
        };
    }

    const snapshot = currentSnapshot || scanProtectedPathHashes(repoRoot, getProtectedControlPlaneRoots(repoRoot), readOnly);
    const snapshotDigest = computeProtectedSnapshotDigest(snapshot);
    const manifestSnapshot = manifestObject.protected_snapshot || {};
    const manifestDigest = typeof manifestObject.protected_snapshot_sha256 === 'string'
        ? String(manifestObject.protected_snapshot_sha256).trim().toLowerCase()
        : '';
    if (manifestDigest && snapshotDigest === manifestDigest) {
        return {
            status: 'MATCH',
            manifest_path: normalizedManifestPath,
            changed_files: [],
            manifest: manifestObject
        };
    }
    const changedFiles: string[] = [];
    const allProtectedPaths = new Set([...Object.keys(manifestSnapshot), ...Object.keys(snapshot)]);
    for (const protectedPath of allProtectedPaths) {
        if (manifestSnapshot[protectedPath] !== snapshot[protectedPath]) {
            changedFiles.push(protectedPath);
        }
    }

    return {
        status: changedFiles.length > 0 ? 'DRIFT' : 'MATCH',
        manifest_path: normalizedManifestPath,
        changed_files: changedFiles.sort(),
        manifest: manifestObject
    };
}

/**
 * Normalize protected control-plane roots.
 * Directory roots should end with `/`; file targets should not.
 */
export function normalizeProtectedControlPlaneRoots(roots: unknown[] | null | undefined): string[] {
    const set = new Set<string>();
    for (const root of (roots || [])) {
        const original = String(root == null ? '' : root).replace(/\\/g, '/');
        const isDirectoryLike = /\/$/.test(original);
        let value = normalizePath(root);
        if (!value) continue;
        value = value.replace(/\/+$/, '');
        if (!value) continue;
        if (isDirectoryLike) value += '/';
        set.add(value);
    }
    return [...set].sort();
}

/**
 * Build a deterministic aggregate digest for a protected snapshot.
 * Used as a compact pre/post-task integrity token.
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
