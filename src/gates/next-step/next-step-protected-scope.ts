import * as fs from 'node:fs';
import * as path from 'node:path';
import * as childProcess from 'node:child_process';

import {
    evaluateProtectedControlPlaneManifest,
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    normalizePath,
    resolveProtectedControlPlaneManifestPath,
    testPathPrefix
} from '../shared/helpers';
import {
    splitGeneratedRuntimeControlPlaneArtifacts
} from '../shared/generated-runtime-artifacts';
import {
    isOrchestratorSourceCheckout
} from '../protected-control-plane/protected-control-plane';

export interface CurrentGitWorkspaceSnapshotLike {
    changed_files: string[];
}

export interface CurrentProtectedScope {
    changedFiles: string[];
    protectedFiles: string[];
    workflowConfigFiles: string[];
}

function readWorkflowConfigProtectedManifestCandidates(repoRoot: string): string[] {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const protectedSnapshot = parsed.protected_snapshot
            && typeof parsed.protected_snapshot === 'object'
            && !Array.isArray(parsed.protected_snapshot)
            ? parsed.protected_snapshot as Record<string, unknown>
            : {};
        const protectedRoots = Array.isArray(parsed.protected_roots)
            ? parsed.protected_roots.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        return [...new Set([
            ...Object.keys(protectedSnapshot).map((entry) => normalizePath(entry)).filter(Boolean),
            ...protectedRoots.filter((entry) => isWorkflowConfigControlPlanePath(entry))
        ])]
            .filter((entry) => isWorkflowConfigControlPlanePath(entry))
            .sort();
    } catch {
        return [];
    }
}

function readChangedWorkflowConfigProtectedManifestFiles(
    repoRoot: string,
    gitChangedFiles: readonly string[],
    gitIgnoredFiles: ReadonlySet<string>
): string[] {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath)) {
        return [];
    }
    try {
        const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
        const requireCurrentWorkspaceSignal = repoHasGitMetadata(repoRoot);
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
        const protectedSnapshot = parsed.protected_snapshot
            && typeof parsed.protected_snapshot === 'object'
            && !Array.isArray(parsed.protected_snapshot)
            ? parsed.protected_snapshot as Record<string, unknown>
            : {};
        const protectedRoots = Array.isArray(parsed.protected_roots)
            ? parsed.protected_roots.map((entry) => normalizePath(entry)).filter(Boolean)
            : [];
        const workflowConfigCandidates = [...new Set([
            ...Object.keys(protectedSnapshot).map((entry) => normalizePath(entry)).filter(Boolean),
            ...protectedRoots.filter((entry) => isWorkflowConfigControlPlanePath(entry))
        ])].sort();
        return workflowConfigCandidates
            .map((protectedPath) => ({
                protectedPath: normalizePath(protectedPath),
                expectedHash: String(protectedSnapshot[protectedPath] || '').trim().toLowerCase()
            }))
            .filter(({ protectedPath }) => protectedPath && isWorkflowConfigControlPlanePath(protectedPath))
            .filter(({ protectedPath, expectedHash }) => (
                expectedHash
                    ? String(fileSha256(path.join(repoRoot, protectedPath)) || '').trim().toLowerCase() !== expectedHash
                    : fs.existsSync(path.join(repoRoot, protectedPath))
            ))
            .filter(({ protectedPath }) => (
                !requireCurrentWorkspaceSignal
                || gitChangedFileSet.has(protectedPath)
                || gitIgnoredFiles.has(protectedPath)
            ))
            .map(({ protectedPath }) => protectedPath)
            .sort();
    } catch {
        return [];
    }
}

function readGitIgnoredPathSet(repoRoot: string, candidatePaths: readonly string[]): ReadonlySet<string> {
    const normalizedCandidates = [...new Set(
        candidatePaths.map((entry) => normalizePath(entry)).filter(Boolean)
    )].sort();
    if (normalizedCandidates.length === 0 || !repoHasGitMetadata(repoRoot)) {
        return new Set<string>();
    }
    try {
        const result = childProcess.spawnSync('git', ['check-ignore', '--no-index', '--stdin'], {
            cwd: repoRoot,
            input: `${normalizedCandidates.join('\n')}\n`,
            encoding: 'utf8',
            timeout: 5000,
            windowsHide: true
        });
        if (result.status !== 0 || !result.stdout) {
            return new Set<string>();
        }
        return new Set(
            result.stdout
                .split(/\r?\n/u)
                .map((entry) => normalizePath(entry))
                .filter(Boolean)
        );
    } catch {
        return new Set<string>();
    }
}

function repoHasGitMetadata(repoRoot: string): boolean {
    return fs.existsSync(path.join(repoRoot, '.git'));
}

function filterGeneratedRuntimeControlPlaneArtifacts(
    changedFiles: readonly string[],
    isSourceCheckout: boolean
): string[] {
    return splitGeneratedRuntimeControlPlaneArtifacts(
        changedFiles.map((entry) => normalizePath(entry)).filter(Boolean),
        { isSourceCheckout }
    ).reviewableFiles.sort();
}

export function filterProtectedRestartScopeGeneratedRuntimeArtifacts(
    repoRoot: string,
    changedFiles: readonly string[]
): string[] {
    return filterGeneratedRuntimeControlPlaneArtifacts(changedFiles, isOrchestratorSourceCheckout(repoRoot));
}

function selectCurrentScopeManifestChangedFiles(
    gitChangedFiles: readonly string[],
    manifestChangedFiles: readonly string[]
): string[] {
    const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    return [...new Set(
        manifestChangedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => gitChangedFileSet.has(entry))
    )].sort();
}

function selectCurrentScopeWorkflowConfigManifestFiles(
    repoRoot: string,
    gitChangedFiles: readonly string[],
    manifestChangedFiles: readonly string[],
    gitIgnoredFiles: ReadonlySet<string>
): string[] {
    const gitChangedFileSet = new Set(gitChangedFiles.map((entry) => normalizePath(entry)).filter(Boolean));
    return [...new Set(
        manifestChangedFiles
            .map((entry) => normalizePath(entry))
            .filter((entry) => isWorkflowConfigControlPlanePath(entry))
            .filter((entry) => !repoHasGitMetadata(repoRoot) || gitChangedFileSet.has(entry) || gitIgnoredFiles.has(entry))
    )].sort();
}

export function readCurrentProtectedScopeBeforePreflight(
    repoRoot: string,
    workspaceSnapshot: CurrentGitWorkspaceSnapshotLike | null,
    readWorkspaceSnapshot: () => CurrentGitWorkspaceSnapshotLike | null
): CurrentProtectedScope | null {
    const snapshot = workspaceSnapshot ?? readWorkspaceSnapshot();
    const protectedRoots = getProtectedControlPlaneRoots(repoRoot);
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const gitChangedFiles = snapshot
        ? snapshot.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const gitProtectedFiles = gitChangedFiles.filter((entry) => testPathPrefix(entry, protectedRoots));
    const protectedManifestEvidence = gitProtectedFiles.length > 0
        ? evaluateProtectedControlPlaneManifest(repoRoot, null, true)
        : null;
    const fullManifestChangedProtectedFiles = protectedManifestEvidence?.status === 'DRIFT'
        ? protectedManifestEvidence.changed_files.map((entry) => normalizePath(entry)).filter(Boolean)
        : [];
    const workflowConfigManifestCandidates = fullManifestChangedProtectedFiles
        .filter((entry) => isWorkflowConfigControlPlanePath(entry));
    const standaloneWorkflowConfigCandidates = gitProtectedFiles.length === 0
        ? readWorkflowConfigProtectedManifestCandidates(repoRoot)
        : [];
    const gitIgnoredFiles = readGitIgnoredPathSet(repoRoot, [
        ...workflowConfigManifestCandidates,
        ...standaloneWorkflowConfigCandidates
    ]);
    const manifestChangedProtectedFiles = gitProtectedFiles.length > 0
        ? [
            ...selectCurrentScopeManifestChangedFiles(gitChangedFiles, fullManifestChangedProtectedFiles),
            ...selectCurrentScopeWorkflowConfigManifestFiles(
                repoRoot,
                gitChangedFiles,
                fullManifestChangedProtectedFiles,
                gitIgnoredFiles
            )
        ]
        : readChangedWorkflowConfigProtectedManifestFiles(repoRoot, gitChangedFiles, gitIgnoredFiles);
    const changedFiles = filterGeneratedRuntimeControlPlaneArtifacts([
        ...gitChangedFiles,
        ...manifestChangedProtectedFiles
    ], isSourceCheckout);
    if (changedFiles.length === 0) {
        return null;
    }
    const protectedFiles = filterGeneratedRuntimeControlPlaneArtifacts([
        ...gitProtectedFiles,
        ...manifestChangedProtectedFiles.filter((entry) => testPathPrefix(entry, protectedRoots))
    ], isSourceCheckout);
    if (protectedFiles.length === 0) {
        return null;
    }
    return {
        changedFiles,
        protectedFiles,
        workflowConfigFiles: protectedFiles.filter((entry) => isWorkflowConfigControlPlanePath(entry))
    };
}
