import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getWorkspaceSnapshotCached } from './workspace-snapshot-cache';
import {
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    isWorkflowConfigControlPlanePathShape,
    normalizePath,
    resolveProtectedControlPlaneManifestPath,
    toPlainRecord
} from './helpers';
import { DEFAULT_GIT_TIMEOUT_MS, spawnSyncWithTimeout } from '../core/subprocess';

export interface WorkflowConfigWorkEvidence {
    workflow_config_work?: boolean | null;
    orchestrator_work?: boolean | null;
    workflow_config_file_hashes?: Record<string, string | null> | null;
}

export interface CurrentWorkflowConfigChanges {
    changed_files: string[];
    current_file_hashes: Record<string, string | null>;
    scan_error: string | null;
}

export interface WorkflowConfigPreTaskBaselineState {
    changed_files: string[];
}

export function getWorkflowConfigControlPlanePaths(repoRoot: string): string[] {
    return getProtectedControlPlaneRoots(repoRoot)
        .map((entry) => normalizePath(entry))
        .filter(isWorkflowConfigControlPlanePathShape)
        .sort();
}

export function getCurrentWorkflowConfigFileHashes(repoRoot: string): Record<string, string | null> {
    const hashes: Record<string, string | null> = {};
    for (const relativePath of getWorkflowConfigControlPlanePaths(repoRoot)) {
        hashes[relativePath] = fileSha256(path.join(repoRoot, ...relativePath.split('/')));
    }
    return hashes;
}

export function normalizeWorkflowConfigFileHashes(value: unknown): Record<string, string | null> | null {
    const record = toPlainRecord(value);
    if (!record) {
        return null;
    }
    const normalized: Record<string, string | null> = {};
    for (const [rawPath, rawHash] of Object.entries(record)) {
        const relativePath = normalizePath(rawPath);
        if (!relativePath || !isWorkflowConfigControlPlanePathShape(relativePath)) {
            continue;
        }
        const hashText = rawHash == null ? '' : String(rawHash || '').trim().toLowerCase();
        normalized[relativePath] = /^[a-f0-9]{64}$/.test(hashText) ? hashText : null;
    }
    return Object.keys(normalized).length > 0 ? normalized : null;
}

function normalizeSha256(value: unknown): string | null {
    const text = value == null ? '' : String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
}

function readProtectedManifestWorkflowConfigHashes(
    repoRoot: string,
    workflowConfigPaths: readonly string[]
): Record<string, string | null> | null {
    const manifestPath = resolveProtectedControlPlaneManifestPath(repoRoot);
    if (!fs.existsSync(manifestPath) || !fs.statSync(manifestPath).isFile()) {
        return null;
    }

    try {
        const parsed = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        const snapshot = toPlainRecord(toPlainRecord(parsed)?.protected_snapshot);
        if (!snapshot) {
            return null;
        }
        const manifestHashes: Record<string, string | null> = {};
        for (const relativePath of workflowConfigPaths) {
            if (!Object.prototype.hasOwnProperty.call(snapshot, relativePath)) {
                continue;
            }
            manifestHashes[relativePath] = normalizeSha256(snapshot[relativePath]);
        }
        return manifestHashes;
    } catch {
        return null;
    }
}

function readGitHeadFileSha256(repoRoot: string, relativePath: string): string | undefined {
    try {
        const result = spawnSyncWithTimeout('git', ['-C', repoRoot, 'show', `HEAD:${relativePath}`], {
            stdio: ['pipe', 'pipe', 'pipe'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
            maxBuffer: 20 * 1024 * 1024
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return undefined;
        }
        const stdout = Buffer.isBuffer(result.stdout)
            ? result.stdout
            : Buffer.from(String(result.stdout || ''), 'utf8');
        return crypto.createHash('sha256').update(stdout).digest('hex').toLowerCase();
    } catch {
        return undefined;
    }
}

function hasGitIndexOrWorktreeStatus(repoRoot: string, relativePath: string): boolean {
    try {
        const result = spawnSyncWithTimeout('git', [
            '-C',
            repoRoot,
            'status',
            '--porcelain=v1',
            '--untracked-files=all',
            '--ignored=matching',
            '--',
            relativePath
        ], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
            timeoutMs: DEFAULT_GIT_TIMEOUT_MS
        });
        if (result.status !== 0 || result.timedOut || result.error) {
            return false;
        }
        return String(result.stdout || '')
            .split(/\r?\n/)
            .map((line) => line.trimEnd())
            .filter(Boolean)
            .length > 0;
    } catch {
        return false;
    }
}

export function getWorkflowConfigPreTaskBaselineState(
    repoRoot: string,
    currentFileHashes: Record<string, string | null> = getCurrentWorkflowConfigFileHashes(repoRoot)
): WorkflowConfigPreTaskBaselineState {
    const workflowConfigPaths = [...new Set([
        ...getWorkflowConfigControlPlanePaths(repoRoot),
        ...Object.keys(currentFileHashes)
    ])].sort();
    const manifestHashes = readProtectedManifestWorkflowConfigHashes(repoRoot, workflowConfigPaths);
    const changedFiles = new Set<string>();

    for (const relativePath of workflowConfigPaths) {
        const currentHash = Object.prototype.hasOwnProperty.call(currentFileHashes, relativePath)
            ? currentFileHashes[relativePath]
            : null;
        const gitHeadHash = readGitHeadFileSha256(repoRoot, relativePath);
        const hasManifestHash = !!manifestHashes
            && Object.prototype.hasOwnProperty.call(manifestHashes, relativePath);
        const manifestHash = hasManifestHash ? manifestHashes[relativePath] : undefined;

        if (gitHeadHash !== undefined && gitHeadHash !== currentHash) {
            changedFiles.add(relativePath);
        }
        if (hasManifestHash && manifestHash !== currentHash) {
            changedFiles.add(relativePath);
        }
        if (
            gitHeadHash === undefined
            && !hasManifestHash
            && (
                currentHash !== null
                || hasGitIndexOrWorktreeStatus(repoRoot, relativePath)
            )
        ) {
            changedFiles.add(relativePath);
        }
    }

    return {
        changed_files: [...changedFiles].sort()
    };
}

function getWorkflowConfigChangedFilesFromBaseline(
    currentFileHashes: Record<string, string | null>,
    baselineFileHashes: Record<string, string | null> | null | undefined
): string[] {
    if (!baselineFileHashes || Object.keys(baselineFileHashes).length === 0) {
        return [];
    }
    const changedFiles: string[] = [];
    const allPaths = new Set([...Object.keys(baselineFileHashes), ...Object.keys(currentFileHashes)]);
    for (const relativePath of allPaths) {
        if (
            isWorkflowConfigControlPlanePathShape(relativePath)
            && baselineFileHashes[relativePath] !== currentFileHashes[relativePath]
        ) {
            changedFiles.push(relativePath);
        }
    }
    return changedFiles.sort();
}

function hasWorkflowConfigHashEvidence(value: Record<string, string | null> | null | undefined): boolean {
    return !!value
        && Object.keys(value).some((relativePath) => isWorkflowConfigControlPlanePathShape(relativePath));
}

export function getCurrentWorkflowConfigChanges(
    repoRoot: string,
    baselineFileHashes?: Record<string, string | null> | null
): CurrentWorkflowConfigChanges {
    const currentFileHashes = getCurrentWorkflowConfigFileHashes(repoRoot);
    const baselineChangedFiles = getWorkflowConfigChangedFilesFromBaseline(currentFileHashes, baselineFileHashes);
    const hasBaselineFileHashes = !!baselineFileHashes && Object.keys(baselineFileHashes).length > 0;
    const workflowConfigControlPlanePaths = [
        ...new Set([
            ...Object.keys(currentFileHashes),
            ...Object.keys(baselineFileHashes || {})
        ])
    ];
    try {
        const snapshot = getWorkspaceSnapshotCached(repoRoot, 'git_auto', true, [], { noCache: true });
        return {
            changed_files: getWorkflowConfigChangedFiles([
                ...(hasBaselineFileHashes ? [] : snapshot.changed_files),
                ...baselineChangedFiles
            ], workflowConfigControlPlanePaths),
            current_file_hashes: currentFileHashes,
            scan_error: null
        };
    } catch (error: unknown) {
        return {
            changed_files: getWorkflowConfigChangedFiles(
                baselineChangedFiles,
                workflowConfigControlPlanePaths
            ),
            current_file_hashes: currentFileHashes,
            scan_error: error instanceof Error ? error.message : String(error)
        };
    }
}

export function getWorkflowConfigChangedFiles(
    changedFiles: readonly string[],
    allowedPaths?: readonly string[] | null
): string[] {
    const allowedPathSet = allowedPaths
        ? new Set(allowedPaths.map((entry) => normalizePath(entry)).filter(Boolean))
        : null;
    return [...new Set(
        changedFiles
            .map((entry) => String(entry || '').trim().replace(/\\/g, '/'))
            .filter((entry) => entry.length > 0)
            .filter((entry) => {
                const normalized = normalizePath(entry);
                return allowedPathSet
                    ? allowedPathSet.has(normalized)
                    : isWorkflowConfigControlPlanePath(normalized);
            })
    )].sort();
}

export function getWorkflowConfigWorkViolations(options: {
    changedFiles: readonly string[];
    taskModeEvidence: WorkflowConfigWorkEvidence;
    phaseLabel: string;
    baselineFileHashes?: Record<string, string | null> | null;
    currentFileHashes?: Record<string, string | null> | null;
}): string[] {
    const workflowConfigPathFilter = options.baselineFileHashes || options.currentFileHashes
        ? [
            ...Object.keys(options.baselineFileHashes || {}),
            ...Object.keys(options.currentFileHashes || {})
        ]
        : null;
    const changedWorkflowConfigFiles = getWorkflowConfigChangedFiles(options.changedFiles, workflowConfigPathFilter);
    if (
        !hasWorkflowConfigHashEvidence(options.baselineFileHashes)
        && hasWorkflowConfigHashEvidence(options.currentFileHashes)
    ) {
        return [
            `Workflow config baseline hashes are missing before ${options.phaseLabel}. ` +
            'Re-enter task mode so workflow_config_file_hashes are captured before guarded workflow-config checks continue.'
        ];
    }

    if (changedWorkflowConfigFiles.length === 0) {
        return [];
    }

    if (
        options.taskModeEvidence.workflow_config_work === true
        && options.taskModeEvidence.orchestrator_work !== true
    ) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with inconsistent task-mode evidence: ` +
            `--workflow-config-work requires --orchestrator-work: ${changedWorkflowConfigFiles.join(', ')}. ` +
            'Re-enter task mode with --orchestrator-work --workflow-config-work.'
        ];
    }

    if (
        options.taskModeEvidence.orchestrator_work === true
        && options.taskModeEvidence.workflow_config_work === true
    ) {
        return [];
    }

    if (options.taskModeEvidence.workflow_config_work === true) {
        return [
            `Workflow config files changed before ${options.phaseLabel} with --workflow-config-work but without --orchestrator-work: ` +
            `${changedWorkflowConfigFiles.join(', ')}. Re-enter task mode with --orchestrator-work --workflow-config-work.`
        ];
    }

    const flagHint = options.taskModeEvidence.orchestrator_work === true
        ? '--workflow-config-work'
        : '--orchestrator-work --workflow-config-work';
    return [
        `Workflow config files changed before ${options.phaseLabel} without task-mode ${flagHint}: ${changedWorkflowConfigFiles.join(', ')}. ` +
        `Re-enter task mode with ${flagHint} only for tasks that intentionally change workflow-config.json; workflow set audit logs do not grant task-mode permission.`
    ];
}
