import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import {
    resolveBundleName,
    UNCONFIGURED_COMPILE_GATE_COMMAND,
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from '../../core/constants';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../core/operator-confirmation';
import {
    REVIEW_EXECUTION_POLICY_MODES,
    buildReviewExecutionPolicySummaryLine,
    describeReviewExecutionPolicy,
    normalizeReviewExecutionPolicyMode,
    resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig,
    type EffectiveReviewExecutionPolicyMode,
    type ReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildDefaultWorkflowConfig,
    hasMaterializedWorkflowConfigBaseline,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES,
    normalizeCompileGateConfig,
    normalizeFullSuiteValidationPlacement,
    type CompileGateConfig,
    type FullSuiteValidationPlacement,
    type ProjectMemoryMaintenanceConfig,
    type ProjectMemoryMaintenanceMode,
    type ProjectMemoryReadStrategy,
    type OrchestratorWorkPolicyConfig,
    type OrchestratorWorkPolicyMode,
    type TaskResetConfig,
    type WorkflowConfigData,
    normalizeOrchestratorWorkPolicyConfig
} from '../../core/workflow-config';
import { buildProjectMemoryMaintenanceSummaryLine } from '../../core/project-memory-rollout';
import {
    SCOPE_BUDGET_GUARD_ACTIONS,
    normalizeScopeBudgetGuardConfig,
    type ScopeBudgetGuardConfig
} from '../../core/scope-budget-guard';
import {
    REVIEW_CYCLE_GUARD_ACTIONS,
    normalizeReviewCycleGuardConfig,
    type ReviewCycleGuardConfig
} from '../../core/review-cycle-guard';
import {
    OUT_OF_SCOPE_FAILURE_POLICIES,
    type OutOfScopeFailurePolicy
} from '../../gates/full-suite-validation';
import { validateCompileGateCommand } from '../../gates/compile-gate';
import { writeProtectedControlPlaneManifest } from '../../gates/protected-control-plane';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    bold,
    buildGuardedCommandHelpText,
    cyan,
    dim,
    green,
    normalizePathValue,
    parseOptions,
    PackageJsonLike,
    red,
    supportsColor,
    yellow
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

type WorkflowFileConfigData = {
    compile_gate?: WorkflowConfigData['compile_gate'];
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy?: WorkflowConfigData['review_execution_policy'];
    scope_budget_guard?: WorkflowConfigData['scope_budget_guard'];
    review_cycle_guard?: WorkflowConfigData['review_cycle_guard'];
    project_memory_maintenance?: WorkflowConfigData['project_memory_maintenance'];
    task_reset?: WorkflowConfigData['task_reset'];
    orchestrator_work_policy?: WorkflowConfigData['orchestrator_work_policy'];
    [key: string]: unknown;
};

type WorkflowReviewExecutionPolicyView = {
    mode: EffectiveReviewExecutionPolicyMode;
    configured: boolean;
    allowed_modes: readonly ReviewExecutionPolicyMode[];
    description: string;
    visible_summary_line: string;
};

interface WorkflowCommandRoots {
    targetRoot: string;
    bundleRoot: string;
    configPath: string;
}

interface ResolvedWorkflowBooleanSetting {
    value: string;
    flagName: string;
}

interface WorkflowConfigState {
    rawConfig: WorkflowFileConfigData | null;
    config: WorkflowFileConfigData;
    exists: boolean;
    missingReviewExecutionPolicyMode: EffectiveReviewExecutionPolicyMode | null;
}

interface WorkflowCommandResultBase {
    scope: 'repo-local';
    target_root: string;
    bundle_root: string;
    config_path: string;
    config_exists: boolean;
    compile_gate: CompileGateConfig;
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy: WorkflowReviewExecutionPolicyView;
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    task_reset: TaskResetConfig;
    orchestrator_work_policy: OrchestratorWorkPolicyConfig;
    visible_summary_line: string;
    compile_gate_summary_line: string;
    review_execution_policy_summary_line: string;
    scope_budget_guard_summary_line: string;
    review_cycle_guard_summary_line: string;
    project_memory_maintenance_summary_line: string;
    task_reset_summary_line: string;
    orchestrator_work_policy_summary_line: string;
}

interface WorkflowShowResult extends WorkflowCommandResultBase {
    action: 'show';
}

interface WorkflowSetResult extends WorkflowCommandResultBase {
    action: 'set';
    status: 'CHANGED' | 'NO_CHANGE';
    changed: boolean;
    requested_fields: string[];
    changed_fields: string[];
    noop_fields: string[];
    audit_path: string | null;
    protected_manifest_path: string | null;
}

interface WorkflowValidateResult extends WorkflowCommandResultBase {
    action: 'validate';
    status: 'PASS';
}

interface WorkflowExplainResult extends WorkflowCommandResultBase {
    action: 'explain';
    topic: 'workflow-guards';
    explanation: string[];
}

const WORKFLOW_SHARED_DEFINITIONS = {
    '--target-root': { key: 'targetRoot', type: 'string' },
    '--bundle-root': { key: 'bundleRoot', type: 'string' },
    '--json': { key: 'json', type: 'boolean' }
};

const WORKFLOW_SET_DEFINITIONS = {
    ...WORKFLOW_SHARED_DEFINITIONS,
    '--full-suite': { key: 'fullSuiteAlias', type: 'string' },
    '--compile-gate-command': { key: 'compileGateCommand', type: 'string' },
    '--full-suite-enabled': { key: 'fullSuiteEnabled', type: 'string' },
    '--full-suite-command': { key: 'fullSuiteCommand', type: 'string' },
    '--full-suite-timeout-ms': { key: 'fullSuiteTimeoutMs', type: 'string' },
    '--full-suite-green-summary-max-lines': { key: 'fullSuiteGreenSummaryMaxLines', type: 'string' },
    '--full-suite-red-failure-chunk-lines': { key: 'fullSuiteRedFailureChunkLines', type: 'string' },
    '--full-suite-out-of-scope-failure-policy': { key: 'fullSuiteOutOfScopeFailurePolicy', type: 'string' },
    '--full-suite-placement': { key: 'fullSuitePlacement', type: 'string' },
    '--review-execution-policy': { key: 'reviewExecutionPolicy', type: 'string' },
    '--scope-budget': { key: 'scopeBudgetAlias', type: 'string' },
    '--scope-budget-enabled': { key: 'scopeBudgetEnabled', type: 'string' },
    '--scope-budget-action': { key: 'scopeBudgetAction', type: 'string' },
    '--scope-budget-profiles': { key: 'scopeBudgetProfiles', type: 'string' },
    '--scope-budget-max-files': { key: 'scopeBudgetMaxFiles', type: 'string' },
    '--scope-budget-max-changed-lines': { key: 'scopeBudgetMaxChangedLines', type: 'string' },
    '--scope-budget-max-required-reviews': { key: 'scopeBudgetMaxRequiredReviews', type: 'string' },
    '--scope-budget-max-review-tokens': { key: 'scopeBudgetMaxReviewTokens', type: 'string' },
    '--review-cycle-enabled': { key: 'reviewCycleEnabled', type: 'string' },
    '--review-cycle-action': { key: 'reviewCycleAction', type: 'string' },
    '--review-cycle-max-failed-non-test-reviews': { key: 'reviewCycleMaxFailedNonTestReviews', type: 'string' },
    '--review-cycle-max-total-non-test-reviews': { key: 'reviewCycleMaxTotalNonTestReviews', type: 'string' },
    '--review-cycle-excluded-review-types': { key: 'reviewCycleExcludedReviewTypes', type: 'string' },
    '--review-cycle': { key: 'reviewCycleAlias', type: 'string' },
    '--review-cycle-auto-split': { key: 'reviewCycleAutoSplitAlias', type: 'string' },
    '--review-cycle-auto-split-enabled': { key: 'reviewCycleAutoSplitEnabled', type: 'string' },
    '--project-memory': { key: 'projectMemoryAlias', type: 'string' },
    '--project-memory-enabled': { key: 'projectMemoryEnabled', type: 'string' },
    '--project-memory-mode': { key: 'projectMemoryMode', type: 'string' },
    '--project-memory-run-before-final-closeout': { key: 'projectMemoryRunBeforeFinalCloseout', type: 'string' },
    '--project-memory-require-user-approval-for-writes': { key: 'projectMemoryRequireUserApprovalForWrites', type: 'string' },
    '--project-memory-max-compact-summary-chars': { key: 'projectMemoryMaxCompactSummaryChars', type: 'string' },
    '--project-memory-read-strategy': { key: 'projectMemoryReadStrategy', type: 'string' },
    '--project-memory-impact-artifact-retention-days': { key: 'projectMemoryImpactArtifactRetentionDays', type: 'string' },
    '--task-reset': { key: 'taskResetAlias', type: 'string' },
    '--task-reset-enabled': { key: 'taskResetEnabled', type: 'string' },
    '--garda-self-guard': { key: 'gardaSelfGuard', type: 'string' },
    '--operator-confirmed': { key: 'operatorConfirmed', type: 'string' },
    '--operator-confirmed-at-utc': { key: 'operatorConfirmedAtUtc', type: 'string' }
};

function resolveWorkflowRoots(options: ParsedOptionsRecord): WorkflowCommandRoots {
    const explicitBundleRoot = typeof options.bundleRoot === 'string'
        ? normalizePathValue(options.bundleRoot)
        : null;
    const targetRoot = typeof options.targetRoot === 'string'
        ? normalizePathValue(options.targetRoot)
        : explicitBundleRoot
            ? path.dirname(explicitBundleRoot)
            : normalizePathValue('.');
    const bundleRoot = explicitBundleRoot ?? path.join(targetRoot, resolveBundleName());
    return {
        targetRoot,
        bundleRoot,
        configPath: path.join(bundleRoot, 'live', 'config', 'workflow-config.json')
    };
}

function cloneProjectMemoryMaintenanceConfig(
    config: ProjectMemoryMaintenanceConfig
): ProjectMemoryMaintenanceConfig {
    return JSON.parse(JSON.stringify(config)) as ProjectMemoryMaintenanceConfig;
}

function cloneTaskResetConfig(config: TaskResetConfig): TaskResetConfig {
    return JSON.parse(JSON.stringify(config)) as TaskResetConfig;
}

function cloneOrchestratorWorkPolicyConfig(
    config: OrchestratorWorkPolicyConfig
): OrchestratorWorkPolicyConfig {
    return JSON.parse(JSON.stringify(config)) as OrchestratorWorkPolicyConfig;
}

function normalizeWorkflowFileConfig(config: WorkflowFileConfigData): WorkflowFileConfigData {
    const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
    return {
        ...config,
        compile_gate: normalizeCompileGateConfig(config.compile_gate ?? defaultConfig.compile_gate),
        full_suite_validation: config.full_suite_validation,
        scope_budget_guard: normalizeScopeBudgetGuardConfig(config.scope_budget_guard ?? defaultConfig.scope_budget_guard),
        review_cycle_guard: normalizeReviewCycleGuardConfig(config.review_cycle_guard ?? defaultConfig.review_cycle_guard),
        project_memory_maintenance: cloneProjectMemoryMaintenanceConfig(
            config.project_memory_maintenance ?? defaultConfig.project_memory_maintenance
        ),
        task_reset: cloneTaskResetConfig(config.task_reset ?? defaultConfig.task_reset),
        orchestrator_work_policy: cloneOrchestratorWorkPolicyConfig(
            normalizeOrchestratorWorkPolicyConfig(config.orchestrator_work_policy ?? defaultConfig.orchestrator_work_policy)
        )
    };
}

function readWorkflowConfigState(configPath: string, bundleRoot: string): WorkflowConfigState {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
        return {
            rawConfig: null,
            config: normalizeWorkflowFileConfig({
                compile_gate: defaultConfig.compile_gate,
                full_suite_validation: defaultConfig.full_suite_validation,
                scope_budget_guard: defaultConfig.scope_budget_guard,
                project_memory_maintenance: defaultConfig.project_memory_maintenance,
                task_reset: defaultConfig.task_reset,
                orchestrator_work_policy: defaultConfig.orchestrator_work_policy
            }),
            exists: false,
            missingReviewExecutionPolicyMode: hasMaterializedWorkflowConfigBaseline(bundleRoot)
                ? 'legacy_test_downstream'
                : defaultConfig.review_execution_policy.mode
        };
    }

    let parsed: unknown;
    try {
        parsed = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is not valid JSON: ${error instanceof Error ? error.message : String(error)}`
        );
    }

    try {
        const validated = normalizeWorkflowFileConfig(validateWorkflowConfig(parsed) as WorkflowFileConfigData);
        return {
            rawConfig: validated,
            config: validated,
            exists: true,
            missingReviewExecutionPolicyMode: null
        };
    } catch (error: unknown) {
        throw new Error(
            `Workflow config at '${configPath}' is invalid: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

function buildMandatoryFullSuiteLine(config: { full_suite_validation: WorkflowConfigData['full_suite_validation'] }): string {
    return `Mandatory full-suite: ${config.full_suite_validation.enabled ? 'true' : 'false'} placement=${config.full_suite_validation.placement}`;
}

function isConfiguredCompileGateCommand(command: unknown): command is string {
    const value = typeof command === 'string' ? command.trim() : '';
    return Boolean(value) && value !== UNCONFIGURED_COMPILE_GATE_COMMAND;
}

function buildCompileGateLine(config: { compile_gate?: CompileGateConfig }): string {
    const command = config.compile_gate?.command || UNCONFIGURED_COMPILE_GATE_COMMAND;
    return isConfiguredCompileGateCommand(command)
        ? `Compile gate command: configured (${command})`
        : 'Compile gate command: legacy 40-commands.md fallback';
}

function buildReviewExecutionPolicyView(state: WorkflowConfigState): WorkflowReviewExecutionPolicyView {
    if (state.missingReviewExecutionPolicyMode) {
        const mode = state.missingReviewExecutionPolicyMode;
        return {
            mode,
            configured: false,
            allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
            description: describeReviewExecutionPolicy(mode),
            visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
        };
    }
    const resolved = resolveEffectiveReviewExecutionPolicyConfigFromWorkflowConfig(
        state.config,
        'legacy_test_downstream'
    );
    const mode = resolved.mode;
    return {
        mode,
        configured: resolved.configured,
        allowed_modes: REVIEW_EXECUTION_POLICY_MODES,
        description: describeReviewExecutionPolicy(mode),
        visible_summary_line: buildReviewExecutionPolicySummaryLine(mode)
    };
}

function buildScopeBudgetGuardLine(config: ScopeBudgetGuardConfig): string {
    return `Scope budget guard: ${config.enabled ? config.action : 'disabled'} profiles=${config.profiles.join(',')} max_files=${config.max_files} max_lines=${config.max_changed_lines} max_reviews=${config.max_required_reviews} max_review_tokens=${config.max_review_tokens}`;
}

function buildReviewCycleGuardLine(config: ReviewCycleGuardConfig): string {
    return `Review cycle guard: ${config.enabled ? config.action : 'disabled'} max_failed_non_test_reviews=${config.max_failed_non_test_reviews} max_total_non_test_reviews=${config.max_total_non_test_reviews} excluded=${config.excluded_review_types.join(',')} auto_split_enabled=${config.auto_split_enabled}`;
}

function buildTaskResetLine(config: TaskResetConfig): string {
    return `Task reset: ${config.enabled ? 'enabled' : 'disabled'}`;
}

function buildOrchestratorWorkPolicyLine(config: OrchestratorWorkPolicyConfig): string {
    const selfGuard = config.mode === 'deny_agent_entry' ? 'on' : 'off';
    return `Garda self-guard: ${selfGuard} (${config.mode})`;
}

function buildWorkflowShowResult(
    roots: WorkflowCommandRoots,
    state: WorkflowConfigState
): WorkflowShowResult {
    const compileGate = normalizeCompileGateConfig(
        state.config.compile_gate ?? buildDefaultWorkflowConfig().compile_gate
    );
    const reviewExecutionPolicy = buildReviewExecutionPolicyView(state);
    const scopeBudgetGuard = normalizeScopeBudgetGuardConfig(state.config.scope_budget_guard);
    const reviewCycleGuard = normalizeReviewCycleGuardConfig(state.config.review_cycle_guard);
    const projectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        state.config.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    const taskReset = cloneTaskResetConfig(
        state.config.task_reset ?? buildDefaultWorkflowConfig().task_reset
    );
    const orchestratorWorkPolicy = cloneOrchestratorWorkPolicyConfig(
        normalizeOrchestratorWorkPolicyConfig(
            state.config.orchestrator_work_policy ?? buildDefaultWorkflowConfig().orchestrator_work_policy
        )
    );
    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        compile_gate: compileGate,
        full_suite_validation: state.config.full_suite_validation,
        review_execution_policy: reviewExecutionPolicy,
        scope_budget_guard: scopeBudgetGuard,
        review_cycle_guard: reviewCycleGuard,
        project_memory_maintenance: projectMemoryMaintenance,
        task_reset: taskReset,
        orchestrator_work_policy: orchestratorWorkPolicy,
        visible_summary_line: buildMandatoryFullSuiteLine(state.config),
        compile_gate_summary_line: buildCompileGateLine({ compile_gate: compileGate }),
        review_execution_policy_summary_line: reviewExecutionPolicy.visible_summary_line,
        scope_budget_guard_summary_line: buildScopeBudgetGuardLine(scopeBudgetGuard),
        review_cycle_guard_summary_line: buildReviewCycleGuardLine(reviewCycleGuard),
        project_memory_maintenance_summary_line: buildProjectMemoryMaintenanceSummaryLine(projectMemoryMaintenance),
        task_reset_summary_line: buildTaskResetLine(taskReset),
        orchestrator_work_policy_summary_line: buildOrchestratorWorkPolicyLine(orchestratorWorkPolicy)
    };
}

function colorWorkflowValue(key: string, value: string): string {
    const normalized = value.trim().toUpperCase();
    if (key === 'Status') {
        if (normalized === 'CHANGED' || normalized === 'PASS') return green(value);
        if (normalized === 'NO_CHANGE') return yellow(value);
        return red(value);
    }
    if (value === 'true' || value === 'enabled') return green(value);
    if (value === 'false' || value === 'disabled' || value === 'none' || value === 'n/a') return dim(value);
    return value;
}

function colorizeWorkflowLine(line: string): string {
    if (!supportsColor() || !line.trim()) return line;
    if (line === 'GARDA_WORKFLOW') return bold(cyan(line));
    if (!line.includes(':')) return bold(line);
    const match = line.match(/^([A-Za-z][A-Za-z0-9]*):(.*)$/u);
    if (!match) return line;
    const [, key, rest] = match;
    const spacing = rest.match(/^\s*/u)?.[0] ?? ' ';
    const value = rest.slice(spacing.length);
    return `${bold(`${key}:`)}${spacing}${colorWorkflowValue(key, value)}`;
}

function colorizeWorkflowHumanOutput(rendered: string): string {
    return rendered.split('\n').map((line) => colorizeWorkflowLine(line)).join('\n');
}

function formatWorkflowFieldList(fields: readonly string[]): string {
    return fields.length > 0 ? fields.join(', ') : 'none';
}

function formatWorkflowShowOutput(result: WorkflowCommandResultBase & { action: 'show' | 'set' }, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const compileGate = result.compile_gate;
    const fullSuiteValidation = result.full_suite_validation;
    const reviewExecutionPolicy = result.review_execution_policy;
    const scopeBudgetGuard = result.scope_budget_guard;
    const reviewCycleGuard = result.review_cycle_guard;
    const projectMemoryMaintenance = result.project_memory_maintenance;
    const taskReset = result.task_reset;
    const orchestratorWorkPolicy = result.orchestrator_work_policy;
    const lines: string[] = [];
    lines.push('GARDA_WORKFLOW');
    lines.push(`Action: ${result.action}`);
    lines.push('');
    lines.push('Target');
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push('');
    lines.push('Settings summary');
    lines.push(result.compile_gate_summary_line);
    lines.push(result.visible_summary_line);
    lines.push(result.review_execution_policy_summary_line);
    lines.push(result.scope_budget_guard_summary_line);
    lines.push(result.review_cycle_guard_summary_line);
    lines.push(result.project_memory_maintenance_summary_line);
    lines.push(result.task_reset_summary_line);
    lines.push(result.orchestrator_work_policy_summary_line);
    lines.push('');
    lines.push('Compile gate');
    lines.push(`CompileGateCommand: ${compileGate.command}`);
    lines.push(`CompileGateCommandSource: ${isConfiguredCompileGateCommand(compileGate.command) ? 'workflow-config' : 'legacy-40-commands-fallback'}`);
    lines.push('');
    lines.push('Full suite validation');
    lines.push(`FullSuiteEnabled: ${fullSuiteValidation.enabled}`);
    lines.push(`FullSuiteCommand: ${fullSuiteValidation.command}`);
    lines.push(`FullSuiteTimeoutMs: ${fullSuiteValidation.timeout_ms}`);
    lines.push(`FullSuiteGreenSummaryMaxLines: ${fullSuiteValidation.green_summary_max_lines}`);
    lines.push(`FullSuiteRedFailureChunkLines: ${fullSuiteValidation.red_failure_chunk_lines}`);
    lines.push(`FullSuiteOutOfScopeFailurePolicy: ${fullSuiteValidation.out_of_scope_failure_policy}`);
    lines.push(`FullSuitePlacement: ${fullSuiteValidation.placement}`);
    lines.push('');
    lines.push('Review execution');
    lines.push(`ReviewExecutionPolicy: ${reviewExecutionPolicy.mode}`);
    lines.push(`ReviewExecutionPolicyConfigured: ${reviewExecutionPolicy.configured}`);
    lines.push(`ReviewExecutionPolicyDescription: ${reviewExecutionPolicy.description}`);
    lines.push(`ReviewExecutionPolicyAllowedModes: ${reviewExecutionPolicy.allowed_modes.join(', ')}`);
    lines.push('');
    lines.push('Scope budget guard');
    lines.push(`ScopeBudgetGuardEnabled: ${scopeBudgetGuard.enabled}`);
    lines.push(`ScopeBudgetGuardProfiles: ${scopeBudgetGuard.profiles.join(', ')}`);
    lines.push(`ScopeBudgetGuardAction: ${scopeBudgetGuard.action}`);
    lines.push(`ScopeBudgetGuardMaxFiles: ${scopeBudgetGuard.max_files}`);
    lines.push(`ScopeBudgetGuardMaxChangedLines: ${scopeBudgetGuard.max_changed_lines}`);
    lines.push(`ScopeBudgetGuardMaxRequiredReviews: ${scopeBudgetGuard.max_required_reviews}`);
    lines.push(`ScopeBudgetGuardMaxReviewTokens: ${scopeBudgetGuard.max_review_tokens}`);
    lines.push('');
    lines.push('Review cycle guard');
    lines.push(`ReviewCycleGuardEnabled: ${reviewCycleGuard.enabled}`);
    lines.push(`ReviewCycleGuardAction: ${reviewCycleGuard.action}`);
    lines.push(`ReviewCycleGuardMaxFailedNonTestReviews: ${reviewCycleGuard.max_failed_non_test_reviews}`);
    lines.push(`ReviewCycleGuardMaxTotalNonTestReviews: ${reviewCycleGuard.max_total_non_test_reviews}`);
    lines.push(`ReviewCycleGuardExcludedReviewTypes: ${reviewCycleGuard.excluded_review_types.join(', ')}`);
    lines.push(`ReviewCycleGuardAutoSplitEnabled: ${reviewCycleGuard.auto_split_enabled}`);
    lines.push('');
    lines.push('Project memory maintenance');
    lines.push(`ProjectMemoryMaintenanceEnabled: ${projectMemoryMaintenance.enabled}`);
    lines.push(`ProjectMemoryMaintenanceMode: ${projectMemoryMaintenance.mode}`);
    lines.push(`ProjectMemoryMaintenanceRunBeforeFinalCloseout: ${projectMemoryMaintenance.run_before_final_closeout}`);
    lines.push(`ProjectMemoryMaintenanceRequireUserApprovalForWrites: ${projectMemoryMaintenance.require_user_approval_for_writes}`);
    lines.push(`ProjectMemoryMaintenanceMaxCompactSummaryChars: ${projectMemoryMaintenance.max_compact_summary_chars}`);
    lines.push(`ProjectMemoryMaintenanceReadStrategy: ${projectMemoryMaintenance.read_strategy}`);
    lines.push(`ProjectMemoryMaintenanceImpactArtifactRetentionDays: ${projectMemoryMaintenance.impact_artifact_retention_days}`);
    lines.push('');
    lines.push('Task reset and self-guard');
    lines.push(`TaskResetEnabled: ${taskReset.enabled}`);
    lines.push(`GardaSelfGuard: ${orchestratorWorkPolicy.mode === 'deny_agent_entry' ? 'on' : 'off'}`);
    lines.push(`OrchestratorWorkPolicy: ${orchestratorWorkPolicy.mode}`);
    lines.push('');
    lines.push('Hints');
    lines.push('Tip: run "workflow set --full-suite on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the repo-local mode after operator approval.');
    lines.push(`Tip: run "workflow set --review-execution-policy <${REVIEW_EXECUTION_POLICY_MODES.join('|')}> --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change review launch ordering after operator approval.`);
    lines.push('Tip: run "workflow set --scope-budget on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the scope budget guard after operator approval.');
    lines.push('Tip: run "workflow set --review-cycle on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change the review cycle guard after operator approval.');
    lines.push('Tip: run "workflow set --project-memory on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change project memory maintenance checks after operator approval.');
    lines.push('Tip: run "workflow set --task-reset on|off --operator-confirmed yes --operator-confirmed-at-utc <ISO-8601 timestamp>" to change confirmed task-reset availability after operator approval.');
    lines.push('Tip: run "workflow set --garda-self-guard on|off" to control agent self-entry into protected orchestrator work; off requires explicit operator approval.');
    return colorizeWorkflowHumanOutput(lines.join('\n'));
}

function getWorkflowConfigField(config: WorkflowFileConfigData, fieldPath: string): unknown {
    return fieldPath.split('.').reduce<unknown>((current, segment) => {
        if (current && typeof current === 'object' && segment in current) {
            return (current as Record<string, unknown>)[segment];
        }
        return undefined;
    }, config);
}

function workflowConfigValuesEqual(left: unknown, right: unknown): boolean {
    return JSON.stringify(left) === JSON.stringify(right);
}

function resolveActualChangedFields(
    requestedFields: readonly string[],
    currentConfig: WorkflowFileConfigData,
    nextConfig: WorkflowFileConfigData,
    configExists: boolean
): string[] {
    if (!configExists) {
        return [...requestedFields];
    }
    return requestedFields.filter((field) => !workflowConfigValuesEqual(
        getWorkflowConfigField(currentConfig, field),
        getWorkflowConfigField(nextConfig, field)
    ));
}

function formatWorkflowSetSummaryOutput(result: WorkflowSetResult): string {
    const lines = [
        `Status: ${result.status}`,
        `RequestedFields: ${formatWorkflowFieldList(result.requested_fields)}`,
        `ChangedFields: ${formatWorkflowFieldList(result.changed_fields)}`,
        `NoOpFields: ${formatWorkflowFieldList(result.noop_fields)}`
    ];
    if (result.audit_path) {
        lines.push(`AuditPath: ${result.audit_path}`);
    }
    if (result.protected_manifest_path) {
        lines.push(`ProtectedManifestPath: ${result.protected_manifest_path}`);
    }
    if (result.status === 'NO_CHANGE') {
        lines.push('Hint: requested workflow settings already matched the current config; no audit record was written.');
    }
    return colorizeWorkflowHumanOutput(lines.join('\n'));
}

function parseBooleanText(value: string, flagName: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', '0', 'off'].includes(normalized)) {
        return false;
    }
    throw new Error(`${flagName} must be one of: true, false, yes, no, 1, 0, on, off.`);
}

function resolveBooleanSettingOption(options: {
    parsedOptions: ParsedOptionsRecord;
    canonicalKey: string;
    aliasKey: string;
    canonicalFlag: string;
    aliasFlag: string;
}): ResolvedWorkflowBooleanSetting | null {
    const canonicalValue = options.parsedOptions[options.canonicalKey];
    const aliasValue = options.parsedOptions[options.aliasKey];
    const canonicalText = typeof canonicalValue === 'string' ? canonicalValue : null;
    const aliasText = typeof aliasValue === 'string' ? aliasValue : null;
    if (canonicalText !== null && aliasText !== null) {
        const canonicalBoolean = parseBooleanText(canonicalText, options.canonicalFlag);
        const aliasBoolean = parseBooleanText(aliasText, options.aliasFlag);
        if (canonicalBoolean !== aliasBoolean) {
            throw new Error(
                `${options.aliasFlag} conflicts with ${options.canonicalFlag}; pass only one value or make both values match.`
            );
        }
        return {
            value: canonicalText,
            flagName: options.canonicalFlag
        };
    }
    if (canonicalText !== null) {
        return {
            value: canonicalText,
            flagName: options.canonicalFlag
        };
    }
    if (aliasText !== null) {
        return {
            value: aliasText,
            flagName: options.aliasFlag
        };
    }
    return null;
}

function parseIntegerText(value: string, flagName: string, minimum: number): number {
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${flagName} must be an integer.`);
    }
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed < minimum) {
        throw new Error(`${flagName} must be >= ${minimum}.`);
    }
    return parsed;
}

function parseOutOfScopeFailurePolicy(value: string): OutOfScopeFailurePolicy {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!OUT_OF_SCOPE_FAILURE_POLICIES.includes(normalized as OutOfScopeFailurePolicy)) {
        throw new Error(
            '--full-suite-out-of-scope-failure-policy must be one of: '
            + OUT_OF_SCOPE_FAILURE_POLICIES.join(', ')
            + '.'
        );
    }
    return normalized as OutOfScopeFailurePolicy;
}

function parseFullSuitePlacement(value: string): FullSuiteValidationPlacement {
    return normalizeFullSuiteValidationPlacement(value, {
        rejectInvalidExplicit: true,
        errorPath: '--full-suite-placement'
    });
}

function normalizeFullSuiteCommandForCompileGateValidation(command: unknown): string | null {
    const value = typeof command === 'string' ? command.trim() : '';
    if (!value || value === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        return null;
    }
    return value;
}

function validateWorkflowCompileGateCommand(command: string, fullSuiteCommand: unknown): void {
    validateCompileGateCommand(command, '--compile-gate-command', {
        fullSuiteCommand: normalizeFullSuiteCommandForCompileGateValidation(fullSuiteCommand)
    });
}

function parseScopeBudgetAction(value: string): ScopeBudgetGuardConfig['action'] {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!SCOPE_BUDGET_GUARD_ACTIONS.includes(normalized as ScopeBudgetGuardConfig['action'])) {
        throw new Error(`--scope-budget-action must be one of: ${SCOPE_BUDGET_GUARD_ACTIONS.join(', ')}.`);
    }
    return normalized as ScopeBudgetGuardConfig['action'];
}

function parseReviewCycleAction(value: string): ReviewCycleGuardConfig['action'] {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!REVIEW_CYCLE_GUARD_ACTIONS.includes(normalized as ReviewCycleGuardConfig['action'])) {
        throw new Error(`--review-cycle-action must be one of: ${REVIEW_CYCLE_GUARD_ACTIONS.join(', ')}.`);
    }
    return normalized as ReviewCycleGuardConfig['action'];
}

function parseProjectMemoryMaintenanceMode(value: string): ProjectMemoryMaintenanceMode {
    const normalized = value.trim().toLowerCase();
    if (!PROJECT_MEMORY_MAINTENANCE_MODES.includes(normalized as ProjectMemoryMaintenanceMode)) {
        throw new Error(`--project-memory-mode must be one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}.`);
    }
    return normalized as ProjectMemoryMaintenanceMode;
}

function parseProjectMemoryReadStrategy(value: string): ProjectMemoryReadStrategy {
    const normalized = value.trim().toLowerCase();
    if (!PROJECT_MEMORY_READ_STRATEGIES.includes(normalized as ProjectMemoryReadStrategy)) {
        throw new Error(`--project-memory-read-strategy must be one of: ${PROJECT_MEMORY_READ_STRATEGIES.join(', ')}.`);
    }
    return normalized as ProjectMemoryReadStrategy;
}

function parseGardaSelfGuardMode(value: string): OrchestratorWorkPolicyMode {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'on' || normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return 'deny_agent_entry';
    }
    if (normalized === 'off' || normalized === 'false' || normalized === '0' || normalized === 'no') {
        return 'require_operator_confirmation';
    }
    throw new Error('--garda-self-guard must be on or off.');
}

function parseProfileList(value: string): string[] {
    const profiles = [...new Set(value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean))];
    if (profiles.length === 0) {
        throw new Error('--scope-budget-profiles must contain at least one profile.');
    }
    return profiles;
}

function parseReviewTypeList(value: string, flagName: string): string[] {
    const reviewTypes = [...new Set(value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean))];
    if (reviewTypes.length === 0) {
        throw new Error(`${flagName} must contain at least one review type.`);
    }
    return reviewTypes;
}

function writeWorkflowConfig(configPath: string, config: WorkflowFileConfigData): void {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    const validated = validateWorkflowConfig(config) as WorkflowFileConfigData;
    fs.writeFileSync(configPath, JSON.stringify(validated, null, 2) + '\n', 'utf8');
}

function sha256Text(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

function normalizeOutputPath(value: string): string {
    return path.normalize(value).replace(/\\/g, '/');
}

function writeWorkflowConfigAuditRecord(
    bundleRoot: string,
    configPath: string,
    changedFields: string[],
    beforeText: string,
    afterText: string
): string {
    const auditPath = path.join(bundleRoot, 'runtime', 'workflow-config-audit.jsonl');
    fs.mkdirSync(path.dirname(auditPath), { recursive: true });
    fs.appendFileSync(auditPath, JSON.stringify({
        schema_version: 1,
        event_source: 'workflow-config-set',
        timestamp_utc: new Date().toISOString(),
        actor: 'operator_command',
        command: 'workflow set',
        config_path: normalizeOutputPath(configPath),
        changed_fields: changedFields,
        before_sha256: sha256Text(beforeText),
        after_sha256: sha256Text(afterText)
    }) + '\n', 'utf8');
    return auditPath;
}

function requireWorkflowSetOperatorConfirmation(options: ParsedOptionsRecord): void {
    const rawConfirmation = String(options.operatorConfirmed || '').trim();
    const confirmed = rawConfirmation ? parseOperatorConfirmationYes(rawConfirmation) : false;
    validateFreshOperatorConfirmation({
        actionLabel: 'workflow set',
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Ask the operator to approve this workflow-config mutation, then rerun with --operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". ' +
            'Agents must not approve workflow-config changes for themselves.'
    });
}

function handleShow(options: ParsedOptionsRecord): WorkflowShowResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result = buildWorkflowShowResult(roots, state);
    console.log(formatWorkflowShowOutput(result, options.json === true));
    return result;
}

function handleSet(options: ParsedOptionsRecord): WorkflowSetResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const preserveLegacyMissingReviewExecutionPolicy = !state.exists
        && hasMaterializedWorkflowConfigBaseline(roots.bundleRoot)
        && typeof options.reviewExecutionPolicy !== 'string';
    const mutableBaseConfig = state.rawConfig
        ?? (preserveLegacyMissingReviewExecutionPolicy
            ? { full_suite_validation: state.config.full_suite_validation }
            : buildDefaultWorkflowConfig());
    const nextConfig = normalizeWorkflowFileConfig(JSON.parse(JSON.stringify(
        mutableBaseConfig
    )) as WorkflowFileConfigData);
    const nextFullSuiteValidation = JSON.parse(
        JSON.stringify(state.config.full_suite_validation)
    ) as WorkflowConfigData['full_suite_validation'];
    const nextCompileGate = normalizeCompileGateConfig(nextConfig.compile_gate);
    const changedFields: string[] = [];
    const fullSuiteEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'fullSuiteEnabled',
        aliasKey: 'fullSuiteAlias',
        canonicalFlag: '--full-suite-enabled',
        aliasFlag: '--full-suite'
    });
    const scopeBudgetEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'scopeBudgetEnabled',
        aliasKey: 'scopeBudgetAlias',
        canonicalFlag: '--scope-budget-enabled',
        aliasFlag: '--scope-budget'
    });
    const reviewCycleEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'reviewCycleEnabled',
        aliasKey: 'reviewCycleAlias',
        canonicalFlag: '--review-cycle-enabled',
        aliasFlag: '--review-cycle'
    });
    const reviewCycleAutoSplitSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'reviewCycleAutoSplitEnabled',
        aliasKey: 'reviewCycleAutoSplitAlias',
        canonicalFlag: '--review-cycle-auto-split-enabled',
        aliasFlag: '--review-cycle-auto-split'
    });
    const projectMemoryEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'projectMemoryEnabled',
        aliasKey: 'projectMemoryAlias',
        canonicalFlag: '--project-memory-enabled',
        aliasFlag: '--project-memory'
    });
    const taskResetEnabledSetting = resolveBooleanSettingOption({
        parsedOptions: options,
        canonicalKey: 'taskResetEnabled',
        aliasKey: 'taskResetAlias',
        canonicalFlag: '--task-reset-enabled',
        aliasFlag: '--task-reset'
    });

    if (fullSuiteEnabledSetting) {
        nextFullSuiteValidation.enabled = parseBooleanText(
            fullSuiteEnabledSetting.value,
            fullSuiteEnabledSetting.flagName
        );
        changedFields.push('full_suite_validation.enabled');
    }
    if (typeof options.fullSuiteCommand === 'string') {
        const command = options.fullSuiteCommand.trim();
        if (!command) {
            throw new Error('--full-suite-command must not be empty.');
        }
        nextFullSuiteValidation.command = command;
        changedFields.push('full_suite_validation.command');
    }
    if (typeof options.compileGateCommand === 'string') {
        const command = options.compileGateCommand.trim();
        if (!command) {
            throw new Error('--compile-gate-command must not be empty.');
        }
        validateWorkflowCompileGateCommand(command, nextFullSuiteValidation.command);
        nextCompileGate.command = command;
        changedFields.push('compile_gate.command');
    }
    if (typeof options.fullSuiteTimeoutMs === 'string') {
        nextFullSuiteValidation.timeout_ms = parseIntegerText(
            options.fullSuiteTimeoutMs,
            '--full-suite-timeout-ms',
            1000
        );
        changedFields.push('full_suite_validation.timeout_ms');
    }
    if (typeof options.fullSuiteGreenSummaryMaxLines === 'string') {
        nextFullSuiteValidation.green_summary_max_lines = parseIntegerText(
            options.fullSuiteGreenSummaryMaxLines,
            '--full-suite-green-summary-max-lines',
            1
        );
        changedFields.push('full_suite_validation.green_summary_max_lines');
    }
    if (typeof options.fullSuiteRedFailureChunkLines === 'string') {
        nextFullSuiteValidation.red_failure_chunk_lines = parseIntegerText(
            options.fullSuiteRedFailureChunkLines,
            '--full-suite-red-failure-chunk-lines',
            10
        );
        changedFields.push('full_suite_validation.red_failure_chunk_lines');
    }
    if (typeof options.fullSuiteOutOfScopeFailurePolicy === 'string') {
        nextFullSuiteValidation.out_of_scope_failure_policy = parseOutOfScopeFailurePolicy(
            options.fullSuiteOutOfScopeFailurePolicy
        );
        changedFields.push('full_suite_validation.out_of_scope_failure_policy');
    }
    if (typeof options.fullSuitePlacement === 'string') {
        nextFullSuiteValidation.placement = parseFullSuitePlacement(options.fullSuitePlacement);
        changedFields.push('full_suite_validation.placement');
    }
    if (isConfiguredCompileGateCommand(nextCompileGate.command)) {
        validateWorkflowCompileGateCommand(nextCompileGate.command, nextFullSuiteValidation.command);
    }
    nextConfig.compile_gate = nextCompileGate;
    nextConfig.full_suite_validation = nextFullSuiteValidation;
    if (typeof options.reviewExecutionPolicy === 'string') {
        nextConfig.review_execution_policy = {
            mode: normalizeReviewExecutionPolicyMode(
                options.reviewExecutionPolicy,
                '--review-execution-policy'
            )
        };
        changedFields.push('review_execution_policy.mode');
    }
    const nextScopeBudgetGuard = normalizeScopeBudgetGuardConfig(nextConfig.scope_budget_guard);
    if (scopeBudgetEnabledSetting) {
        nextScopeBudgetGuard.enabled = parseBooleanText(
            scopeBudgetEnabledSetting.value,
            scopeBudgetEnabledSetting.flagName
        );
        changedFields.push('scope_budget_guard.enabled');
    }
    if (typeof options.scopeBudgetAction === 'string') {
        nextScopeBudgetGuard.action = parseScopeBudgetAction(options.scopeBudgetAction);
        changedFields.push('scope_budget_guard.action');
    }
    if (typeof options.scopeBudgetProfiles === 'string') {
        nextScopeBudgetGuard.profiles = parseProfileList(options.scopeBudgetProfiles);
        changedFields.push('scope_budget_guard.profiles');
    }
    if (typeof options.scopeBudgetMaxFiles === 'string') {
        nextScopeBudgetGuard.max_files = parseIntegerText(options.scopeBudgetMaxFiles, '--scope-budget-max-files', 1);
        changedFields.push('scope_budget_guard.max_files');
    }
    if (typeof options.scopeBudgetMaxChangedLines === 'string') {
        nextScopeBudgetGuard.max_changed_lines = parseIntegerText(options.scopeBudgetMaxChangedLines, '--scope-budget-max-changed-lines', 1);
        changedFields.push('scope_budget_guard.max_changed_lines');
    }
    if (typeof options.scopeBudgetMaxRequiredReviews === 'string') {
        nextScopeBudgetGuard.max_required_reviews = parseIntegerText(options.scopeBudgetMaxRequiredReviews, '--scope-budget-max-required-reviews', 1);
        changedFields.push('scope_budget_guard.max_required_reviews');
    }
    if (typeof options.scopeBudgetMaxReviewTokens === 'string') {
        nextScopeBudgetGuard.max_review_tokens = parseIntegerText(options.scopeBudgetMaxReviewTokens, '--scope-budget-max-review-tokens', 1);
        changedFields.push('scope_budget_guard.max_review_tokens');
    }
    nextConfig.scope_budget_guard = nextScopeBudgetGuard;
    const nextReviewCycleGuard = normalizeReviewCycleGuardConfig(nextConfig.review_cycle_guard);
    if (reviewCycleEnabledSetting) {
        nextReviewCycleGuard.enabled = parseBooleanText(
            reviewCycleEnabledSetting.value,
            reviewCycleEnabledSetting.flagName
        );
        changedFields.push('review_cycle_guard.enabled');
    }
    if (typeof options.reviewCycleAction === 'string') {
        nextReviewCycleGuard.action = parseReviewCycleAction(options.reviewCycleAction);
        changedFields.push('review_cycle_guard.action');
    }
    if (typeof options.reviewCycleMaxFailedNonTestReviews === 'string') {
        nextReviewCycleGuard.max_failed_non_test_reviews = parseIntegerText(
            options.reviewCycleMaxFailedNonTestReviews,
            '--review-cycle-max-failed-non-test-reviews',
            1
        );
        changedFields.push('review_cycle_guard.max_failed_non_test_reviews');
    }
    if (typeof options.reviewCycleMaxTotalNonTestReviews === 'string') {
        nextReviewCycleGuard.max_total_non_test_reviews = parseIntegerText(
            options.reviewCycleMaxTotalNonTestReviews,
            '--review-cycle-max-total-non-test-reviews',
            1
        );
        changedFields.push('review_cycle_guard.max_total_non_test_reviews');
    }
    if (typeof options.reviewCycleExcludedReviewTypes === 'string') {
        nextReviewCycleGuard.excluded_review_types = parseReviewTypeList(
            options.reviewCycleExcludedReviewTypes,
            '--review-cycle-excluded-review-types'
        );
        changedFields.push('review_cycle_guard.excluded_review_types');
    }
    if (reviewCycleAutoSplitSetting) {
        nextReviewCycleGuard.auto_split_enabled = parseBooleanText(
            reviewCycleAutoSplitSetting.value,
            reviewCycleAutoSplitSetting.flagName
        );
        changedFields.push('review_cycle_guard.auto_split_enabled');
    }
    nextConfig.review_cycle_guard = nextReviewCycleGuard;

    const nextProjectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        nextConfig.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    if (projectMemoryEnabledSetting) {
        nextProjectMemoryMaintenance.enabled = parseBooleanText(
            projectMemoryEnabledSetting.value,
            projectMemoryEnabledSetting.flagName
        );
        changedFields.push('project_memory_maintenance.enabled');
    }
    if (typeof options.projectMemoryMode === 'string') {
        nextProjectMemoryMaintenance.mode = parseProjectMemoryMaintenanceMode(options.projectMemoryMode);
        changedFields.push('project_memory_maintenance.mode');
    }
    if (typeof options.projectMemoryRunBeforeFinalCloseout === 'string') {
        nextProjectMemoryMaintenance.run_before_final_closeout = parseBooleanText(
            options.projectMemoryRunBeforeFinalCloseout,
            '--project-memory-run-before-final-closeout'
        );
        changedFields.push('project_memory_maintenance.run_before_final_closeout');
    }
    if (typeof options.projectMemoryRequireUserApprovalForWrites === 'string') {
        nextProjectMemoryMaintenance.require_user_approval_for_writes = parseBooleanText(
            options.projectMemoryRequireUserApprovalForWrites,
            '--project-memory-require-user-approval-for-writes'
        );
        changedFields.push('project_memory_maintenance.require_user_approval_for_writes');
    }
    if (typeof options.projectMemoryMaxCompactSummaryChars === 'string') {
        nextProjectMemoryMaintenance.max_compact_summary_chars = parseIntegerText(
            options.projectMemoryMaxCompactSummaryChars,
            '--project-memory-max-compact-summary-chars',
            2000
        );
        changedFields.push('project_memory_maintenance.max_compact_summary_chars');
    }
    if (typeof options.projectMemoryReadStrategy === 'string') {
        nextProjectMemoryMaintenance.read_strategy = parseProjectMemoryReadStrategy(options.projectMemoryReadStrategy);
        changedFields.push('project_memory_maintenance.read_strategy');
    }
    if (typeof options.projectMemoryImpactArtifactRetentionDays === 'string') {
        nextProjectMemoryMaintenance.impact_artifact_retention_days = parseIntegerText(
            options.projectMemoryImpactArtifactRetentionDays,
            '--project-memory-impact-artifact-retention-days',
            1
        );
        changedFields.push('project_memory_maintenance.impact_artifact_retention_days');
    }
    nextConfig.project_memory_maintenance = nextProjectMemoryMaintenance;

    const nextTaskReset = cloneTaskResetConfig(
        nextConfig.task_reset ?? buildDefaultWorkflowConfig().task_reset
    );
    if (taskResetEnabledSetting) {
        nextTaskReset.enabled = parseBooleanText(
            taskResetEnabledSetting.value,
            taskResetEnabledSetting.flagName
        );
        changedFields.push('task_reset.enabled');
    }
    nextConfig.task_reset = nextTaskReset;

    const nextOrchestratorWorkPolicy = cloneOrchestratorWorkPolicyConfig(
        normalizeOrchestratorWorkPolicyConfig(
            nextConfig.orchestrator_work_policy ?? buildDefaultWorkflowConfig().orchestrator_work_policy
        )
    );
    if (typeof options.gardaSelfGuard === 'string') {
        nextOrchestratorWorkPolicy.mode = parseGardaSelfGuardMode(options.gardaSelfGuard);
        changedFields.push('orchestrator_work_policy.mode');
    }
    nextConfig.orchestrator_work_policy = nextOrchestratorWorkPolicy;

    if (changedFields.length === 0) {
        throw new Error(
            "Workflow setting flags are required for 'workflow set'. "
            + 'Use --compile-gate-command, --full-suite-enabled, --full-suite-command, --full-suite-timeout-ms, '
            + '--full-suite-green-summary-max-lines, --full-suite-red-failure-chunk-lines, '
            + '--full-suite-out-of-scope-failure-policy, --full-suite-placement, --review-execution-policy, '
            + '--scope-budget-* flags, --review-cycle-* flags, --project-memory-* flags, '
            + '--task-reset-enabled, their short on/off aliases, or --garda-self-guard.'
        );
    }

    const currentValidated = normalizeWorkflowFileConfig(validateWorkflowConfig(state.rawConfig ?? {
            compile_gate: state.config.compile_gate,
            full_suite_validation: state.config.full_suite_validation,
            scope_budget_guard: state.config.scope_budget_guard,
            review_cycle_guard: state.config.review_cycle_guard,
            project_memory_maintenance: state.config.project_memory_maintenance,
            task_reset: state.config.task_reset,
            orchestrator_work_policy: state.config.orchestrator_work_policy
        }) as WorkflowFileConfigData);
    const currentSerialized = JSON.stringify(currentValidated, null, 2) + '\n';
    const nextValidated = normalizeWorkflowFileConfig(validateWorkflowConfig(nextConfig) as WorkflowFileConfigData);
    const nextSerialized = JSON.stringify(nextValidated, null, 2) + '\n';
    const changed = !state.exists || nextSerialized !== currentSerialized;
    const requestedFields = [...changedFields];
    const actualChangedFields = changed
        ? resolveActualChangedFields(requestedFields, currentValidated, nextValidated, state.exists)
        : [];
    const actualChangedFieldSet = new Set(actualChangedFields);
    const noopFields = requestedFields.filter((field) => !actualChangedFieldSet.has(field));

    let auditPath: string | null = null;
    let protectedManifestPath: string | null = null;
    if (changed) {
        const safeSelfGuardHardening = requestedFields.length === 1
            && requestedFields[0] === 'orchestrator_work_policy.mode'
            && nextValidated.orchestrator_work_policy?.mode === 'deny_agent_entry';
        if (!safeSelfGuardHardening) {
            requireWorkflowSetOperatorConfirmation(options);
        }
        writeWorkflowConfig(roots.configPath, nextValidated);
        auditPath = writeWorkflowConfigAuditRecord(
            roots.bundleRoot,
            roots.configPath,
            actualChangedFields,
            currentSerialized,
            nextSerialized
        );
        protectedManifestPath = writeProtectedControlPlaneManifest(roots.targetRoot);
    }

    const result: WorkflowSetResult = {
        ...buildWorkflowShowResult(roots, {
            rawConfig: nextValidated,
            config: nextValidated,
            exists: state.exists || changed,
            missingReviewExecutionPolicyMode: null
        }),
        action: 'set',
        status: changed ? 'CHANGED' : 'NO_CHANGE',
        changed,
        requested_fields: requestedFields,
        changed_fields: actualChangedFields,
        noop_fields: noopFields,
        audit_path: auditPath ? normalizeOutputPath(auditPath) : null,
        protected_manifest_path: protectedManifestPath ? normalizeOutputPath(protectedManifestPath) : null
    };
    console.log(formatWorkflowShowOutput(result, options.json === true));
    if (options.json !== true) {
        console.log(formatWorkflowSetSummaryOutput(result));
    }
    return result;
}

function handleValidate(options: ParsedOptionsRecord): WorkflowValidateResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result: WorkflowValidateResult = {
        ...buildWorkflowShowResult(roots, state),
        action: 'validate',
        status: 'PASS'
    };
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log(colorizeWorkflowHumanOutput([
            'GARDA_WORKFLOW',
            'Action: validate',
            'Status: PASS',
            `ConfigPath: ${roots.configPath}`,
            result.compile_gate_summary_line,
            result.scope_budget_guard_summary_line,
            result.review_cycle_guard_summary_line,
            result.project_memory_maintenance_summary_line,
            result.task_reset_summary_line
        ].join('\n')));
    }
    return result;
}

function handleExplain(options: ParsedOptionsRecord): WorkflowExplainResult {
    const roots = resolveWorkflowRoots(options);
    const state = readWorkflowConfigState(roots.configPath, roots.bundleRoot);
    const result: WorkflowExplainResult = {
        ...buildWorkflowShowResult(roots, state),
        action: 'explain',
        topic: 'workflow-guards',
        explanation: [
            'Compile gate command: workflow-config compile_gate.command is used when configured; otherwise compile-gate falls back to the legacy 40-commands.md Compile Gate block.',
            'Compile gate command changes are validated as compile/build/type-check commands and must not match the configured full-suite validation command.',
            'Scope budget guard: stops large configured-profile tasks before compile/review loops.',
            'Scope budget guard compares changed file count, changed line count, required review lanes, and estimated review tokens against workflow-config.json limits.',
            'Required review lanes means the number of review types required by the current preflight, not the number of completed review attempts.',
            'Estimated review tokens are a heuristic forecast from review type base cost plus changed file and changed line costs; they are not measured model tokenizer output.',
            'When scope_budget_guard.action is BLOCK_FOR_SPLIT, next-step blocks ordinary continuation and asks the operator to split or decompose the task.',
            'Review cycle guard: stops runaway non-test review cycles after the configured failed or total review-attempt thresholds are exceeded.',
            'The fresh default review-cycle limits are 15 failed non-test reviews and 30 total non-test reviews; the guard triggers only when a count is greater than its configured limit.',
            'Review cycle attempts are deduplicated only when review type, reviewer identity, and review context hash all match; otherwise each timeline event is counted separately.',
            'Review cycle guard excluded_review_types are not counted; the default excludes test reviews because reaching test review means code-facing review lanes have already been handled.',
            'When review_cycle_guard.action is BLOCK_FOR_OPERATOR_DECISION, next-step blocks compile, review, and full-suite continuation until the operator chooses a recovery path; allow_one_more_cycle is a task-scoped runtime approval, while raise_limits is a permanent repo-local workflow-config change through workflow set.',
            'When review_cycle_guard.auto_split_enabled is false, next-step tells the agent to wait for operator direction after a blocking review-cycle violation.',
            'When review_cycle_guard.auto_split_enabled is true, next-step emits a dedicated auto-split prompt artifact for the agent instead of waiting for operator input.',
            'When review_cycle_guard.action is WARN_ONLY, next-step continues to the next gate but prints the review-cycle violation under Warnings.',
            'Task reset: confirmed reset mutations are disabled by default and require audited opt-in with workflow set --task-reset on --operator-confirmed yes --operator-confirmed-at-utc "<ISO-8601 timestamp>".',
            'workflow set requires explicit operator approval with --operator-confirmed yes and --operator-confirmed-at-utc; agents must not approve workflow-config mutations for themselves.',
            'Task reset dry-run remains available while disabled because it only reports reset scope and does not mutate task status or artifacts.'
        ]
    };
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log('GARDA_WORKFLOW');
        console.log('Action: explain');
        console.log('Topic: workflow-guards');
        console.log(result.compile_gate_summary_line);
        console.log(result.scope_budget_guard_summary_line);
        console.log(result.review_cycle_guard_summary_line);
        console.log(result.task_reset_summary_line);
        for (const line of result.explanation) {
            console.log(`- ${line}`);
        }
    }
    return result;
}

export function handleWorkflow(
    commandArgv: string[],
    packageJson: PackageJsonLike
): WorkflowShowResult | WorkflowSetResult | WorkflowValidateResult | WorkflowExplainResult | null {
    const firstArg = String(commandArgv[0] || '').trim();
    const hasExplicitSubcommand = firstArg.length > 0 && !firstArg.startsWith('-');
    const subcommand = hasExplicitSubcommand ? firstArg : 'show';
    const subcommandArgv = hasExplicitSubcommand ? commandArgv.slice(1) : commandArgv;
    const optionDefinitions = subcommand === 'set'
        ? WORKFLOW_SET_DEFINITIONS
        : WORKFLOW_SHARED_DEFINITIONS;
    const { options } = parseOptions(subcommandArgv, optionDefinitions);

    if (options.help) { console.log(buildGuardedCommandHelpText('workflow')); return null; }
    if (options.version) { console.log(packageJson.version); return null; }

    switch (subcommand) {
        case 'show':
            return handleShow(options as ParsedOptionsRecord);
        case 'set':
            return handleSet(options as ParsedOptionsRecord);
        case 'validate':
            return handleValidate(options as ParsedOptionsRecord);
        case 'explain':
            return handleExplain(options as ParsedOptionsRecord);
        default:
            throw new Error(`Unknown workflow action: ${subcommand}. Allowed values: show, set, validate, explain.`);
    }
}
