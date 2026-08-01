import * as path from 'node:path';

import {
    fileSha256,
    getProtectedControlPlaneRoots,
    isWorkflowConfigControlPlanePath,
    isWorkflowConfigControlPlanePathShape,
    normalizePath,
    toPlainRecord
} from '../shared/helpers';

export const WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE = 'workflow-config policy changes';

export interface WorkflowConfigTaskMetadata {
    area?: string | null;
    title?: string | null;
    notes?: string | null;
}

export function taskMetadataAllowsWorkflowConfigWork(taskMetadata: WorkflowConfigTaskMetadata | null): boolean {
    if (!taskMetadata) {
        return false;
    }
    const trustedTaskText = [
        taskMetadata.area,
        taskMetadata.title,
        taskMetadata.notes
    ].filter(Boolean).join(' ').toLowerCase();
    return trustedTaskText.includes(WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE);
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

export function normalizeWorkflowConfigSha256(value: unknown): string | null {
    const text = value == null ? '' : String(value || '').trim().toLowerCase();
    return /^[a-f0-9]{64}$/.test(text) ? text : null;
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
