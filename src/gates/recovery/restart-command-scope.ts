import * as fs from 'node:fs';

import {
    normalizePath,
    resolvePathInsideRepo,
    toPlainRecord
} from '../shared/helpers';
import {
    getWorkflowConfigChangedFiles,
    normalizeWorkflowConfigFileHashes
} from '../workflow-config/workflow-config-work';

function readJsonRecord(filePath: string): Record<string, unknown> | null {
    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        return toPlainRecord(parsed);
    } catch {
        return null;
    }
}

function toNormalizedPathList(value: unknown): string[] {
    if (!Array.isArray(value)) {
        return [];
    }
    return [...new Set(
        value
            .map((entry) => normalizePath(String(entry || '').trim()))
            .filter(Boolean)
    )].sort();
}

function resolvePreflightPath(repoRoot: string, preflightPath: string): string | null {
    try {
        return resolvePathInsideRepo(preflightPath, repoRoot, { enforceInside: true });
    } catch {
        return null;
    }
}

export function resolveRestartCommandChangedFiles(
    repoRoot: string,
    preflightPath: string
): string[] {
    const resolvedPreflightPath = resolvePreflightPath(repoRoot, preflightPath);
    if (!resolvedPreflightPath) {
        return [];
    }
    const preflight = readJsonRecord(resolvedPreflightPath);
    if (!preflight) {
        return [];
    }

    const triggers = toPlainRecord(preflight.triggers);
    const workflowConfigFiles = getWorkflowConfigChangedFiles(
        toNormalizedPathList(triggers?.changed_workflow_config_files)
    );
    if (workflowConfigFiles.length === 0) {
        return [];
    }

    const workflowConfigHashes = normalizeWorkflowConfigFileHashes(triggers?.workflow_config_file_hashes);
    if (!workflowConfigHashes) {
        return [];
    }

    const attributedWorkflowConfigFiles = workflowConfigFiles.filter((relativePath) =>
        Object.prototype.hasOwnProperty.call(workflowConfigHashes, relativePath)
    );
    if (attributedWorkflowConfigFiles.length !== workflowConfigFiles.length) {
        return [];
    }

    return [...new Set([
        ...toNormalizedPathList(preflight.changed_files),
        ...attributedWorkflowConfigFiles
    ])].sort();
}
