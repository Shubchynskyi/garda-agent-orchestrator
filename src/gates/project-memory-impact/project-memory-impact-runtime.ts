import * as path from 'node:path';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    type ProjectMemoryMaintenanceConfig,
    type ProjectMemoryMaintenanceMode
} from '../../core/workflow-config';
import { resolveBundleNameForTarget } from '../../core/constants';
import { resolveRuntimeProjectMemoryDir } from '../../core/project-memory';
import { isPlainObject } from '../../core/config-merge';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import { readJsonFileIfPresent } from './project-memory-impact-common';

export interface ProjectMemoryImpactRuntime {
    repoRoot: string;
    taskId: string;
    bundleRoot: string;
    config: ProjectMemoryMaintenanceConfig;
    mode: ProjectMemoryMaintenanceMode;
    configuredMode: ProjectMemoryMaintenanceMode;
    required: boolean;
    artifactPath: string;
    updateArtifactPath: string;
    preflightPath: string | null;
}

function computeProjectMemoryConfigKeyEditDistance(left: string, right: string): number {
    const rows = left.length + 1;
    const cols = right.length + 1;
    const distances = Array.from({ length: rows }, (_, rowIndex) => (
        Array.from({ length: cols }, (_, colIndex) => (rowIndex === 0 ? colIndex : (colIndex === 0 ? rowIndex : 0)))
    ));

    for (let rowIndex = 1; rowIndex < rows; rowIndex += 1) {
        for (let colIndex = 1; colIndex < cols; colIndex += 1) {
            const substitutionCost = left[rowIndex - 1] === right[colIndex - 1] ? 0 : 1;
            distances[rowIndex][colIndex] = Math.min(
                distances[rowIndex - 1][colIndex] + 1,
                distances[rowIndex][colIndex - 1] + 1,
                distances[rowIndex - 1][colIndex - 1] + substitutionCost
            );
        }
    }

    return distances[left.length][right.length];
}

function readProjectMemoryMaintenanceSection(parsed: Record<string, unknown>, defaultConfig: ProjectMemoryMaintenanceConfig): unknown {
    const exactKey = 'project_memory_maintenance';
    if (parsed[exactKey] !== undefined) {
        return parsed[exactKey];
    }

    for (const key of Object.keys(parsed)) {
        const normalizedKey = key.toLowerCase();
        if (normalizedKey === exactKey) {
            throw new Error(`workflow-config.${key} must use the exact key '${exactKey}'.`);
        }
        const editDistance = computeProjectMemoryConfigKeyEditDistance(normalizedKey, exactKey);
        if (editDistance > 0 && editDistance <= 2) {
            throw new Error(`workflow-config.${key} is not allowed; did you mean '${exactKey}'?`);
        }
    }

    return defaultConfig;
}

export function readWorkflowProjectMemoryConfig(bundleRoot: string): ProjectMemoryMaintenanceConfig {
    const defaultWorkflowConfig = buildDefaultWorkflowConfig();
    const defaultConfig = defaultWorkflowConfig.project_memory_maintenance;
    const configPath = getWorkflowConfigPath(bundleRoot);
    const parsed = readJsonFileIfPresent(configPath);
    if (!parsed) {
        return { ...defaultConfig };
    }
    const workflowConfigForProjectMemory = {
        full_suite_validation: defaultWorkflowConfig.full_suite_validation,
        review_execution_policy: defaultWorkflowConfig.review_execution_policy,
        project_memory_maintenance: isPlainObject(parsed)
            ? readProjectMemoryMaintenanceSection(parsed, defaultConfig)
            : defaultConfig
    };
    const validated = validateWorkflowConfig(workflowConfigForProjectMemory) as { project_memory_maintenance?: ProjectMemoryMaintenanceConfig };
    return {
        ...defaultConfig,
        ...(validated.project_memory_maintenance ?? {})
    };
}

export function normalizeMaintenanceMode(value: unknown, fallback: ProjectMemoryMaintenanceMode): ProjectMemoryMaintenanceMode {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return fallback;
    }
    if (!PROJECT_MEMORY_MAINTENANCE_MODES.includes(normalized as ProjectMemoryMaintenanceMode)) {
        throw new Error(`Project memory mode must be one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}.`);
    }
    return normalized as ProjectMemoryMaintenanceMode;
}

export function resolveDefaultPreflightPath(bundleRoot: string, taskId: string): string {
    return path.join(bundleRoot, 'runtime', 'reviews', `${taskId}-preflight.json`);
}

export function resolveProjectMemoryRuntime(repoRoot: string, taskId: string, input?: {
    preflightPath?: string | null;
    artifactPath?: string | null;
    updateArtifactPath?: string | null;
}): ProjectMemoryImpactRuntime {
    const resolvedRepoRoot = path.resolve(repoRoot || '.');
    const safeTaskId = assertValidTaskId(taskId);
    const bundleName = resolveBundleNameForTarget(resolvedRepoRoot);
    const bundleRoot = path.join(resolvedRepoRoot, bundleName);
    const config = readWorkflowProjectMemoryConfig(bundleRoot);
    const configuredMode = normalizeMaintenanceMode(config.mode, 'check');
    const mode = config.enabled === false ? 'off' : configuredMode;
    const runtimeMemoryDir = resolveRuntimeProjectMemoryDir(bundleRoot);
    return {
        repoRoot: resolvedRepoRoot,
        taskId: safeTaskId,
        bundleRoot,
        config,
        mode,
        configuredMode,
        required: mode !== 'off' && config.run_before_final_closeout === true,
        artifactPath: input?.artifactPath
            ? path.resolve(resolvedRepoRoot, input.artifactPath)
            : path.join(runtimeMemoryDir, `${safeTaskId}-impact.json`),
        updateArtifactPath: input?.updateArtifactPath
            ? path.resolve(resolvedRepoRoot, input.updateArtifactPath)
            : path.join(runtimeMemoryDir, `${safeTaskId}-update.json`),
        preflightPath: input?.preflightPath === null
            ? null
            : path.resolve(resolvedRepoRoot, input?.preflightPath || resolveDefaultPreflightPath(bundleRoot, safeTaskId))
    };
}
