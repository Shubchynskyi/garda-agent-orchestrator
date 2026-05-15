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
    normalizeReviewCycleGuardConfig,
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

export const ORCHESTRATOR_WORK_POLICY_MODES = Object.freeze([
    'deny_agent_entry',
    'require_operator_confirmation'
] as const);
export type OrchestratorWorkPolicyMode = typeof ORCHESTRATOR_WORK_POLICY_MODES[number];

const GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS = [
    '--garda-self-guard off',
    '--operator-confirmed yes',
    '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
] as const;

export interface OrchestratorWorkPolicyConfig {
    mode: OrchestratorWorkPolicyMode;
    [key: string]: unknown;
}

export interface WorkflowConfigData {
    full_suite_validation: FullSuiteValidationConfig;
    review_execution_policy: ReviewExecutionPolicyConfig;
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    task_reset: TaskResetConfig;
    orchestrator_work_policy: OrchestratorWorkPolicyConfig;
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
    }),
    orchestrator_work_policy: Object.freeze({
        mode: 'deny_agent_entry'
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

const LEGACY_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT: ReviewCycleGuardConfig = Object.freeze({
    enabled: true,
    action: 'BLOCK_FOR_OPERATOR_DECISION',
    max_failed_non_test_reviews: 15,
    max_total_non_test_reviews: 15,
    excluded_review_types: ['test'],
    auto_split_enabled: false
});

export function buildDefaultWorkflowConfig(): WorkflowConfigData {
    return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG);
}

export function normalizeOrchestratorWorkPolicyConfig(input: unknown): OrchestratorWorkPolicyConfig {
    if (!isPlainObject(input)) {
        return cloneJsonValue(DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy);
    }
    const rawMode = typeof input.mode === 'string'
        ? input.mode.trim().toLowerCase()
        : DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    const mode = ORCHESTRATOR_WORK_POLICY_MODES.includes(rawMode as OrchestratorWorkPolicyMode)
        ? rawMode as OrchestratorWorkPolicyMode
        : DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    return {
        ...cloneJsonValue(input),
        mode
    };
}

export function readOrchestratorWorkPolicyModeForBundle(bundleRoot: string): OrchestratorWorkPolicyMode {
    const workflowConfigPath = getWorkflowConfigPath(bundleRoot);
    if (!pathExists(workflowConfigPath)) {
        return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    }
    try {
        const parsed = readJsonFile(workflowConfigPath);
        if (!isPlainObject(parsed)) {
            return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
        }
        return normalizeOrchestratorWorkPolicyConfig(parsed.orchestrator_work_policy).mode;
    } catch {
        return DEFAULT_WORKFLOW_CONFIG.orchestrator_work_policy.mode;
    }
}

export function buildGardaSelfGuardPolicyChangeCommand(cliPrefix: string, includeTargetRoot = true): string {
    return [
        `${cliPrefix} workflow set`,
        ...GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS,
        ...(includeTargetRoot ? ['--target-root "."'] : [])
    ].join(' ');
}

export function buildGardaSelfGuardPolicyChangeReference(): string {
    return [
        'workflow set',
        ...GARDA_SELF_GUARD_POLICY_CHANGE_ARGUMENTS
    ].join(' ');
}

export function formatGardaSelfGuardProtectedControlPlaneGuidance(options: {
    protectedFiles?: readonly string[];
    includeWorkflowConfigWork?: boolean;
    policyChangeReference?: string;
} = {}): string {
    const protectedFiles = options.protectedFiles || [];
    const protectedFileText = protectedFiles.length > 0
        ? ` Planned protected files: ${protectedFiles.join(', ')}.`
        : '';
    const protectedModes = options.includeWorkflowConfigWork
        ? '--orchestrator-work or --workflow-config-work'
        : '--orchestrator-work';
    const policyChangeReference = options.policyChangeReference || buildGardaSelfGuardPolicyChangeReference();

    return (
        `Garda self-guard is on for this application workspace: agents cannot enter ${protectedModes} for protected Garda control-plane edits.` +
        protectedFileText +
        ` Route this to an operator-owned update, repair, or maintenance flow, or have the operator deliberately relax the policy with ${policyChangeReference}.`
    );
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

export function isExactLegacyReviewCycleGuardGeneratedDefault(input: unknown): boolean {
    if (!isPlainObject(input)) {
        return false;
    }

    const expected = LEGACY_REVIEW_CYCLE_GUARD_GENERATED_DEFAULT as unknown as Record<string, unknown>;
    const actualKeys = Object.keys(input).sort();
    const expectedKeys = Object.keys(expected).sort();
    if (actualKeys.length !== expectedKeys.length) {
        return false;
    }
    if (!expectedKeys.every((key, index) => actualKeys[index] === key)) {
        return false;
    }

    return input.enabled === expected.enabled
        && input.action === expected.action
        && input.max_failed_non_test_reviews === expected.max_failed_non_test_reviews
        && input.max_total_non_test_reviews === expected.max_total_non_test_reviews
        && Array.isArray(input.excluded_review_types)
        && input.excluded_review_types.length === 1
        && input.excluded_review_types[0] === 'test'
        && input.auto_split_enabled === expected.auto_split_enabled;
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

function migrateLegacyReviewCycleGuardGeneratedDefault(
    existingConfig: Record<string, unknown> | null
): Record<string, unknown> | null {
    if (!isPlainObject(existingConfig)) {
        return existingConfig;
    }

    const reviewCycleKey = findOwnCaseInsensitiveKey(existingConfig, 'review_cycle_guard');
    if (
        reviewCycleKey === undefined
        || !isExactLegacyReviewCycleGuardGeneratedDefault(existingConfig[reviewCycleKey])
    ) {
        return existingConfig;
    }

    const migrated = cloneJsonValue(existingConfig);
    delete migrated[reviewCycleKey];
    return migrated;
}

export function buildWorkflowConfigReviewCycleLimitDiagnostic(
    readStatus: WorkflowConfigReadStatus,
    existingConfig: Record<string, unknown> | null,
    materializedConfig: Record<string, unknown>
): string {
    const reviewCycleGuard = normalizeReviewCycleGuardConfig(materializedConfig.review_cycle_guard);
    let limitStatus = 'template_default_applied';
    if (readStatus === 'present' && isPlainObject(existingConfig)) {
        const reviewCycleKey = findOwnCaseInsensitiveKey(existingConfig, 'review_cycle_guard');
        if (reviewCycleKey === undefined) {
            limitStatus = 'missing_keys_filled_from_template';
        } else if (isExactLegacyReviewCycleGuardGeneratedDefault(existingConfig[reviewCycleKey])) {
            limitStatus = 'migrated_from_old_default';
        } else {
            limitStatus = 'custom_preserved';
        }
    }

    return [
        `review_cycle_guard.max_failed_non_test_reviews=${reviewCycleGuard.max_failed_non_test_reviews}`,
        `review_cycle_guard.max_total_non_test_reviews=${reviewCycleGuard.max_total_non_test_reviews}`,
        `review_cycle_guard.limit_status=${limitStatus}`
    ].join(' ');
}

export function mergeWorkflowConfigWithTemplate(
    templateConfig: WorkflowConfigData,
    existingConfig: Record<string, unknown> | null,
    options: WorkflowConfigMergeOptions = {}
): Record<string, unknown> {
    const existingConfigForMerge = migrateLegacyReviewCycleGuardGeneratedDefault(
        migrateLegacyProjectMemoryGeneratedDefault(existingConfig)
    );
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
