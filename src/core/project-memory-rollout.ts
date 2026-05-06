import * as path from 'node:path';
import { pathExists } from './filesystem';
import { readJsonFile } from './json';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    type ProjectMemoryMaintenanceConfig
} from './workflow-config';
import { isPlainObject } from './config-merge';

export const PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT =
    'Refresh Garda project memory after this update. Inspect the repository through the normal orchestrator workflow, update only `garda-agent-orchestrator/live/docs/project-memory/*.md` files that are stale or still template placeholders, keep `compact.md` concise, and record project-memory update evidence when the workflow asks for it. Do not overwrite user-authored memory without preserving its facts.';

export interface ProjectMemoryMaintenanceRolloutSummary {
    enabled: boolean;
    mode: string;
    summary_line: string;
    refresh_handoff_prompt: string;
}

function cloneDefaultProjectMemoryMaintenance(): ProjectMemoryMaintenanceConfig {
    return buildDefaultWorkflowConfig().project_memory_maintenance;
}

export function normalizeProjectMemoryMaintenanceForDisplay(input: unknown): ProjectMemoryMaintenanceConfig {
    const defaults = cloneDefaultProjectMemoryMaintenance();
    if (!isPlainObject(input)) {
        return defaults;
    }

    return {
        ...defaults,
        ...input
    } as ProjectMemoryMaintenanceConfig;
}

export function buildProjectMemoryMaintenanceSummaryLine(config: ProjectMemoryMaintenanceConfig): string {
    return `Project memory maintenance: ${config.enabled ? config.mode : 'disabled'} read_strategy=${config.read_strategy} max_compact_summary_chars=${config.max_compact_summary_chars} require_user_approval_for_writes=${config.require_user_approval_for_writes}`;
}

export function buildProjectMemoryMaintenanceRolloutSummary(
    config: ProjectMemoryMaintenanceConfig
): ProjectMemoryMaintenanceRolloutSummary {
    return {
        enabled: config.enabled,
        mode: config.enabled ? config.mode : 'off',
        summary_line: buildProjectMemoryMaintenanceSummaryLine(config),
        refresh_handoff_prompt: PROJECT_MEMORY_REFRESH_HANDOFF_PROMPT
    };
}

export function readProjectMemoryMaintenanceFromBundle(bundleRoot: string): ProjectMemoryMaintenanceConfig {
    const defaults = cloneDefaultProjectMemoryMaintenance();
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    if (!pathExists(workflowConfigPath)) {
        return defaults;
    }

    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return defaults;
        }
        return normalizeProjectMemoryMaintenanceForDisplay(parsed.project_memory_maintenance);
    } catch {
        return defaults;
    }
}

export function readProjectMemoryMaintenanceRolloutSummaryFromBundle(
    bundleRoot: string
): ProjectMemoryMaintenanceRolloutSummary {
    return buildProjectMemoryMaintenanceRolloutSummary(readProjectMemoryMaintenanceFromBundle(path.resolve(bundleRoot)));
}
