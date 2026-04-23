import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from './constants';
import { pathExists } from './fs';
import { readJsonFile, writeJsonFile } from './json';
import { cloneJsonValue, isPlainObject, mergeConfig } from './config-merge';

const DEFAULT_WORKFLOW_CONFIG = Object.freeze({
    full_suite_validation: Object.freeze({
        enabled: false,
        command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
        timeout_ms: 600_000,
        green_summary_max_lines: 5,
        red_failure_chunk_lines: 50,
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
    })
});

export function buildDefaultWorkflowConfig(): Record<string, unknown> {
    return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG);
}

export function getWorkflowConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
}

function getWorkflowConfigTemplatePath(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'config', 'workflow-config.json');
}

function readWorkflowConfigTemplate(bundleRoot: string): Record<string, unknown> {
    const templatePath = getWorkflowConfigTemplatePath(bundleRoot);
    if (!pathExists(templatePath)) {
        return buildDefaultWorkflowConfig();
    }

    try {
        const parsed = readJsonFile(templatePath);
        if (!isPlainObject(parsed)) {
            return buildDefaultWorkflowConfig();
        }
        return mergeConfig(buildDefaultWorkflowConfig(), parsed);
    } catch {
        return buildDefaultWorkflowConfig();
    }
}

export function syncWorkflowConfigWithTemplate(bundleRoot: string): Record<string, unknown> {
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const templateConfig = readWorkflowConfigTemplate(bundleRoot);
    let existingConfig: Record<string, unknown> | null = null;

    if (pathExists(workflowConfigPath)) {
        try {
            const parsed = readJsonFile(workflowConfigPath);
            existingConfig = isPlainObject(parsed) ? parsed : null;
        } catch {
            existingConfig = null;
        }
    }

    const nextConfig = mergeConfig(templateConfig, existingConfig);
    writeJsonFile(workflowConfigPath, nextConfig);
    return nextConfig;
}
