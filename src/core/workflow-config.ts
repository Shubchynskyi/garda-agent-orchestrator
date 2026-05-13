import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from './constants';
import { pathExists } from './filesystem';
import { readJsonFile, writeJsonFile } from './json';
import { cloneJsonValue, isPlainObject, mergeConfig } from './config-merge';
import {
    buildDefaultReviewExecutionPolicyConfig,
    type ReviewExecutionPolicyConfig
} from './review-execution-policy';
import {
    DEFAULT_SCOPE_BUDGET_GUARD_CONFIG,
    type ScopeBudgetGuardConfig
} from './scope-budget-guard';
import {
    DEFAULT_REVIEW_CYCLE_GUARD_CONFIG,
    type ReviewCycleGuardConfig
} from './review-cycle-guard';

export interface FullSuiteValidationConfig {
    enabled: boolean;
    command: string;
    timeout_ms: number;
    green_summary_max_lines: number;
    red_failure_chunk_lines: number;
    out_of_scope_failure_policy: string;
    [key: string]: unknown;
}

export const PROJECT_MEMORY_MAINTENANCE_MODES = Object.freeze(['off', 'check', 'update', 'strict'] as const);
export type ProjectMemoryMaintenanceMode = typeof PROJECT_MEMORY_MAINTENANCE_MODES[number];

export const PROJECT_MEMORY_READ_STRATEGIES = Object.freeze(['index_first'] as const);
export type ProjectMemoryReadStrategy = typeof PROJECT_MEMORY_READ_STRATEGIES[number];

export interface ProjectMemoryMaintenanceConfig {
    enabled: boolean;
    mode: ProjectMemoryMaintenanceMode;
    run_before_final_closeout: boolean;
    require_user_approval_for_writes: boolean;
    max_compact_summary_chars: number;
    read_strategy: ProjectMemoryReadStrategy;
    impact_artifact_retention_days: number;
    [key: string]: unknown;
}

export interface TaskResetConfig {
    enabled: boolean;
    [key: string]: unknown;
}

export interface WorkflowConfigData {
    full_suite_validation: FullSuiteValidationConfig;
    review_execution_policy: ReviewExecutionPolicyConfig;
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    task_reset: TaskResetConfig;
    [key: string]: unknown;
}

export interface WorkflowConfigMergeOptions {
    preserveLegacyReviewExecutionPolicyOmission?: boolean;
}

export type WorkflowConfigReadStatus = 'present' | 'missing' | 'invalid_json' | 'non_object';

export interface WorkflowConfigReadResult {
    status: WorkflowConfigReadStatus;
    config: Record<string, unknown> | null;
}

function hasOwnCaseInsensitiveKey(record: Record<string, unknown>, expectedKey: string): boolean {
    return findOwnCaseInsensitiveKey(record, expectedKey) !== undefined;
}

function findOwnCaseInsensitiveKey(record: Record<string, unknown>, expectedKey: string): string | undefined {
    return Object.keys(record).find((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase());
}

const DEFAULT_WORKFLOW_CONFIG: WorkflowConfigData = Object.freeze({
    full_suite_validation: Object.freeze({
        enabled: false,
        command: UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND,
        timeout_ms: 600_000,
        green_summary_max_lines: 5,
        red_failure_chunk_lines: 50,
        out_of_scope_failure_policy: 'AUDIT_AND_BLOCK'
    }),
    review_execution_policy: Object.freeze(buildDefaultReviewExecutionPolicyConfig()),
    scope_budget_guard: DEFAULT_SCOPE_BUDGET_GUARD_CONFIG,
    review_cycle_guard: DEFAULT_REVIEW_CYCLE_GUARD_CONFIG,
    project_memory_maintenance: Object.freeze({
        enabled: true,
        mode: 'update',
        run_before_final_closeout: true,
        require_user_approval_for_writes: true,
        max_compact_summary_chars: 12000,
        read_strategy: 'index_first',
        impact_artifact_retention_days: 30
    }),
    task_reset: Object.freeze({
        enabled: false
    })
});

const LEGACY_PROJECT_MEMORY_MAINTENANCE_GENERATED_DEFAULT: ProjectMemoryMaintenanceConfig = Object.freeze({
    enabled: false,
    mode: 'check',
    run_before_final_closeout: true,
    require_user_approval_for_writes: true,
    max_compact_summary_chars: 12000,
    read_strategy: 'index_first',
    impact_artifact_retention_days: 30
});

export function buildDefaultWorkflowConfig(): WorkflowConfigData {
    return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG);
}

export function getWorkflowConfigPath(bundleRoot: string): string {
    return path.join(bundleRoot, 'live', 'config', 'workflow-config.json');
}

export function hasMaterializedWorkflowConfigBaseline(bundleRoot: string): boolean {
    return pathExists(path.join(bundleRoot, 'live', 'version.json'));
}

function getWorkflowConfigTemplatePath(bundleRoot: string): string {
    return path.join(bundleRoot, 'template', 'config', 'workflow-config.json');
}

function readWorkflowConfigTemplate(bundleRoot: string): WorkflowConfigData {
    const templatePath = getWorkflowConfigTemplatePath(bundleRoot);
    if (!pathExists(templatePath)) {
        return buildDefaultWorkflowConfig();
    }

    try {
        const parsed = readJsonFile(templatePath);
        if (!isPlainObject(parsed)) {
            return buildDefaultWorkflowConfig();
        }
        return mergeConfig(buildDefaultWorkflowConfig(), parsed) as WorkflowConfigData;
    } catch {
        return buildDefaultWorkflowConfig();
    }
}

export function isExactLegacyProjectMemoryGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }

    const expected = LEGACY_PROJECT_MEMORY_MAINTENANCE_GENERATED_DEFAULT as Record<string, unknown>;
    const actualKeys = Object.keys(input).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        return false;
    }

    return expectedKeys.every((key, index) => actualKeys[index] === key && input[key] === expected[key]);
}

function migrateLegacyProjectMemoryGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const projectMemoryKey = findOwnCaseInsensitiveKey(existingConfig, 'project_memory_maintenance');
    if (
        projectMemoryKey === undefined
        || !isExactLegacyProjectMemoryGeneratedDefault(existingConfig[projectMemoryKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    delete migrated[projectMemoryKey];
    return migrated;
}

export function mergeWorkflowConfigWithTemplate(
    templateConfig: WorkflowConfigData,
    existingConfig: Record<string, unknown> | null,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const existingConfigForMerge = migrateLegacyProjectMemoryGeneratedDefault(existingConfig);
    const nextConfig = mergeConfig(templateConfig, existingConfigForMerge);
    const existingConfigOmittedReviewExecutionPolicy = isPlainObject(existingConfig)
        && !hasOwnCaseInsensitiveKey(existingConfig, 'review_execution_policy');
    const preserveMissingConfigLegacyOmission = existingConfig === null
        && options.preserveLegacyReviewExecutionPolicyOmission === true;

    if (existingConfigOmittedReviewExecutionPolicy || preserveMissingConfigLegacyOmission) {
        delete nextConfig.review_execution_policy;
    }
    return nextConfig;
}

export function readWorkflowConfigForMerge(workflowConfigPath: string): WorkflowConfigReadResult {
    if (!pathExists(workflowConfigPath)) {
        return { status: 'missing', config: null };
    }

    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return { status: 'non_object', config: null };
        }
        return { status: 'present', config: parsed };
    } catch {
        return { status: 'invalid_json', config: null };
    }
}

export function syncWorkflowConfigWithTemplate(
    bundleRoot: string,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    const templateConfig = readWorkflowConfigTemplate(bundleRoot);
    const existingConfig = readWorkflowConfigForMerge(workflowConfigPath).config;

    const nextConfig = mergeWorkflowConfigWithTemplate(templateConfig, existingConfig, options);
    writeJsonFile(workflowConfigPath, nextConfig);
    return nextConfig;
}
