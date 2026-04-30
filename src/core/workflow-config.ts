import * as path from 'node:path';
import { UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND } from './constants';
import { pathExists } from './filesystem';
import { readJsonFile, writeJsonFile } from './json';
import { cloneJsonValue, isPlainObject, mergeConfig } from './config-merge';
import {
    buildDefaultReviewExecutionPolicyConfig,
    type ReviewExecutionPolicyConfig
} from './review-execution-policy';

export interface FullSuiteValidationConfig {
    enabled: boolean;
    command: string;
    timeout_ms: number;
    green_summary_max_lines: number;
    red_failure_chunk_lines: number;
    out_of_scope_failure_policy: string;
    [key: string]: unknown;
}

export interface WorkflowConfigData {
    full_suite_validation: FullSuiteValidationConfig;
    review_execution_policy: ReviewExecutionPolicyConfig;
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
    return Object.keys(record).some((candidate) => candidate.toLowerCase() === expectedKey.toLowerCase());
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
    review_execution_policy: Object.freeze(buildDefaultReviewExecutionPolicyConfig())
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

export function mergeWorkflowConfigWithTemplate(
    templateConfig: WorkflowConfigData,
    existingConfig: Record<string, unknown> | null,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const nextConfig = mergeConfig(templateConfig, existingConfig);
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
