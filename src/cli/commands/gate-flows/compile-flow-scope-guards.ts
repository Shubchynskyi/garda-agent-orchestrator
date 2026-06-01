import {
    getProtectedManifestLifecycleGuard
} from '../../../gates/protected-manifest-guard';
import {
    getCurrentWorkflowConfigChanges,
    getWorkflowConfigChangedFiles,
    getWorkflowConfigControlPlanePaths,
    getWorkflowConfigWorkViolations
} from '../../../gates/workflow-config-work';
import type {
    getTaskModeEvidence
} from '../../../gates/task-mode';
import * as gateHelpers from '../../../gates/helpers';

type TaskModeEvidence = ReturnType<typeof getTaskModeEvidence>;
type WorkflowConfigChanges = ReturnType<typeof getCurrentWorkflowConfigChanges>;
type WorkflowConfigBaseline = WorkflowConfigChanges['baseline_file_hashes'];
type ProtectedManifestEvidence = ReturnType<typeof gateHelpers.evaluateProtectedControlPlaneManifest>;
type ProtectedManifestGuard = ReturnType<typeof getProtectedManifestLifecycleGuard>;

export interface CompileScopeFingerprint {
    changed_files_sha256: string | null;
    changed_lines_total: number;
    detection_source: string;
    scope_sha256: string | null;
}

export interface CompileWorkflowConfigGuardResult {
    baselineFileHashes: WorkflowConfigBaseline;
    changedFiles: string[];
    currentFileHashes: WorkflowConfigChanges['current_file_hashes'];
    scanError: string | null;
    violations: string[];
}

export type BuildCompileRestartCommand = (changedFiles: string[]) => string;

function mergePathLists(...pathLists: string[][]): string[] {
    return [...new Set(pathLists.flat().map((entry) => gateHelpers.normalizePath(entry)).filter(Boolean))].sort();
}

function getDistGeneratedSourceCandidates(filePath: string): string[] {
    const normalized = gateHelpers.normalizePath(filePath);
    const distPayload = normalized.startsWith('dist/')
        ? normalized.slice('dist/'.length)
        : (() => {
            const marker = '/dist/';
            const markerIndex = normalized.indexOf(marker);
            return markerIndex >= 0
                ? `${normalized.slice(0, markerIndex + 1)}${normalized.slice(markerIndex + marker.length)}`
                : '';
        })();
    if (!distPayload) {
        return [];
    }
    const sourceExtensions = ['.ts', '.tsx', '.mts', '.cts'];
    if (distPayload.endsWith('.d.ts')) {
        const base = distPayload.slice(0, -'.d.ts'.length);
        return sourceExtensions.map((extension) => `${base}${extension}`);
    }
    const generatedExtensions = ['.js', '.jsx', '.mjs', '.cjs'];
    const generatedExtension = generatedExtensions.find((extension) => distPayload.endsWith(extension));
    if (!generatedExtension) {
        return [];
    }
    const base = distPayload.slice(0, -generatedExtension.length);
    return sourceExtensions.map((extension) => `${base}${extension}`);
}

export function getTaskOwnedManifestChangedFiles(taskScopeFiles: string[], manifestChangedFiles: string[]): string[] {
    const normalizedTaskScope = new Set(
        taskScopeFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter(Boolean)
    );
    const relevantManifestFiles = new Set<string>();
    for (const manifestFile of manifestChangedFiles) {
        const normalizedManifestFile = gateHelpers.normalizePath(manifestFile);
        if (!normalizedManifestFile) {
            continue;
        }
        if (normalizedTaskScope.has(normalizedManifestFile)) {
            relevantManifestFiles.add(normalizedManifestFile);
            continue;
        }
        if (getDistGeneratedSourceCandidates(normalizedManifestFile).some((candidate) => normalizedTaskScope.has(candidate))) {
            relevantManifestFiles.add(normalizedManifestFile);
        }
    }
    return [...relevantManifestFiles].sort();
}

export function getNewManifestChangedFiles(
    beforeManifestChangedFiles: string[],
    afterManifestChangedFiles: string[]
): string[] {
    const before = new Set(
        beforeManifestChangedFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter(Boolean)
    );
    return [...new Set(
        afterManifestChangedFiles
            .map((entry) => gateHelpers.normalizePath(entry))
            .filter((entry) => entry && !before.has(entry))
    )].sort();
}

export function resolveCompileWorkflowConfigChangedFiles(params: {
    baselineFileHashes: WorkflowConfigBaseline;
    changedFiles: string[];
    preflightChangedFiles?: string[];
    workflowConfigControlPlanePaths: string[];
}): string[] {
    return mergePathLists(
        params.changedFiles,
        params.baselineFileHashes
            ? []
            : getWorkflowConfigChangedFiles(
                params.preflightChangedFiles || [],
                params.workflowConfigControlPlanePaths
            )
    );
}

export function evaluateCompileWorkflowConfigGuard(params: {
    repoRoot: string;
    taskModeEvidence: TaskModeEvidence;
    phaseLabel: string;
    baselineFileHashes: WorkflowConfigBaseline;
    preflightChangedFiles?: string[];
}): CompileWorkflowConfigGuardResult {
    const workflowConfigChanges = getCurrentWorkflowConfigChanges(params.repoRoot, params.baselineFileHashes, {
        allowProtectedManifestFallback: false
    });
    const changedFiles = resolveCompileWorkflowConfigChangedFiles({
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        changedFiles: workflowConfigChanges.changed_files,
        preflightChangedFiles: params.preflightChangedFiles,
        workflowConfigControlPlanePaths: getWorkflowConfigControlPlanePaths(params.repoRoot)
    });
    const violations = getWorkflowConfigWorkViolations({
        changedFiles,
        taskModeEvidence: params.taskModeEvidence,
        phaseLabel: params.phaseLabel,
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        currentFileHashes: workflowConfigChanges.current_file_hashes
    });
    return {
        baselineFileHashes: workflowConfigChanges.baseline_file_hashes,
        changedFiles,
        currentFileHashes: workflowConfigChanges.current_file_hashes,
        scanError: workflowConfigChanges.scan_error || null,
        violations
    };
}

export function evaluateCompileProtectedManifestGuard(params: {
    repoRoot: string;
    taskModeEvidence: TaskModeEvidence;
    phaseLabel: string;
    preflight: Record<string, unknown>;
    preflightChangedFiles: string[];
    buildRestartCommand: BuildCompileRestartCommand;
}): {
    guard: ProtectedManifestGuard;
    manifestEvidence: ProtectedManifestEvidence;
    taskOwnedManifestFiles: string[];
} {
    const manifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(params.repoRoot, null, true);
    const taskOwnedManifestFiles = getTaskOwnedManifestChangedFiles(
        params.preflightChangedFiles,
        manifestEvidence.changed_files
    );
    const restartCommandHint = params.taskModeEvidence.orchestrator_work !== true
        ? params.buildRestartCommand([...params.preflightChangedFiles, ...taskOwnedManifestFiles])
        : undefined;
    const guard = getProtectedManifestLifecycleGuard({
        repoRoot: params.repoRoot,
        orchestratorWork: params.taskModeEvidence.orchestrator_work === true,
        phaseLabel: params.phaseLabel,
        preflight: params.preflight,
        manifestEvidence,
        restartCommandHint
    });
    return { guard, manifestEvidence, taskOwnedManifestFiles };
}

export function evaluatePostCompileProtectedManifestGuard(params: {
    repoRoot: string;
    taskModeEvidence: TaskModeEvidence;
    phaseLabel: string;
    preflight: Record<string, unknown> | null | undefined;
    preflightChangedFiles: string[];
    preCompileManifestEvidence: ProtectedManifestEvidence;
    preCompileTaskOwnedManifestFiles: string[];
    buildRestartCommand: BuildCompileRestartCommand;
}): {
    generatedManifestFiles: string[];
    guard: ProtectedManifestGuard | null;
    manifestEvidence: ProtectedManifestEvidence;
} | null {
    if (params.taskModeEvidence.orchestrator_work === true) {
        return null;
    }
    const manifestEvidence = gateHelpers.evaluateProtectedControlPlaneManifest(params.repoRoot, null, true);
    if (manifestEvidence.status !== 'DRIFT') {
        return {
            generatedManifestFiles: [],
            guard: null,
            manifestEvidence
        };
    }
    const generatedManifestFiles = getNewManifestChangedFiles(
        params.preCompileManifestEvidence.changed_files,
        manifestEvidence.changed_files
    );
    const guard = getProtectedManifestLifecycleGuard({
        repoRoot: params.repoRoot,
        orchestratorWork: false,
        phaseLabel: params.phaseLabel,
        preflight: params.preflight,
        manifestEvidence,
        restartCommandHint: params.buildRestartCommand([
            ...params.preflightChangedFiles,
            ...params.preCompileTaskOwnedManifestFiles,
            ...generatedManifestFiles
        ])
    });
    return { generatedManifestFiles, guard, manifestEvidence };
}

export function getCompileScopeDriftViolations(params: {
    preflightContext: CompileScopeFingerprint;
    workspaceSnapshot: CompileScopeFingerprint;
}): string[] {
    const violations: string[] = [];
    if (params.workspaceSnapshot.changed_files_sha256 !== params.preflightContext.changed_files_sha256) {
        violations.push('Preflight changed_files differ from current workspace snapshot.');
    }
    if (params.workspaceSnapshot.changed_lines_total !== params.preflightContext.changed_lines_total) {
        violations.push(
            `Preflight changed_lines_total=${params.preflightContext.changed_lines_total} differs from current snapshot changed_lines_total=${params.workspaceSnapshot.changed_lines_total}.`
        );
    }
    if (
        params.preflightContext.scope_sha256
        && params.workspaceSnapshot.scope_sha256 !== params.preflightContext.scope_sha256
    ) {
        violations.push(
            `Preflight scope_sha256=${params.preflightContext.scope_sha256} differs from current snapshot scope_sha256=${params.workspaceSnapshot.scope_sha256}.`
        );
    }
    return violations;
}

export function buildCompileScopeDriftMessage(params: {
    preflightContext: CompileScopeFingerprint;
    workspaceSnapshot: CompileScopeFingerprint;
}): string | null {
    const violations = getCompileScopeDriftViolations(params);
    if (violations.length === 0) {
        return null;
    }
    const scopeRecoveryHint = params.preflightContext.detection_source === 'explicit_changed_files'
        ? 'Refresh preflight for the real diff: rerun classify-change for the current scope, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate. If the original preflight used planned --changed-file inputs in a clean workspace before implementation, this drift is expected once the real diff exists.'
        : 'Refresh preflight for the current scope before compile: rerun classify-change, rerun load-rule-pack --stage POST_PREFLIGHT, and then rerun compile-gate.';
    return `Preflight scope drift detected. ${scopeRecoveryHint} ${violations.join(' ')}`;
}
