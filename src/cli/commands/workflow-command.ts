import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    resolveBundleName
} from '../../core/constants';
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
    type ProjectMemoryMaintenanceConfig,
    type ProjectMemoryMaintenanceMode,
    type ProjectMemoryReadStrategy,
    type WorkflowConfigData
} from '../../core/workflow-config';
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
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    buildGuardedCommandHelpText,
    normalizePathValue,
    parseOptions,
    PackageJsonLike
} from './cli-helpers';

type ParsedOptionsRecord = Record<string, string | boolean | string[] | undefined>;

type WorkflowFileConfigData = {
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy?: WorkflowConfigData['review_execution_policy'];
    scope_budget_guard?: WorkflowConfigData['scope_budget_guard'];
    review_cycle_guard?: WorkflowConfigData['review_cycle_guard'];
    project_memory_maintenance?: WorkflowConfigData['project_memory_maintenance'];
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
    full_suite_validation: WorkflowConfigData['full_suite_validation'];
    review_execution_policy: WorkflowReviewExecutionPolicyView;
    scope_budget_guard: ScopeBudgetGuardConfig;
    review_cycle_guard: ReviewCycleGuardConfig;
    project_memory_maintenance: ProjectMemoryMaintenanceConfig;
    visible_summary_line: string;
    review_execution_policy_summary_line: string;
    scope_budget_guard_summary_line: string;
    review_cycle_guard_summary_line: string;
    project_memory_maintenance_summary_line: string;
}

interface WorkflowShowResult extends WorkflowCommandResultBase {
    action: 'show';
}

interface WorkflowSetResult extends WorkflowCommandResultBase {
    action: 'set';
    status: 'CHANGED' | 'NO_CHANGE';
    changed: boolean;
    changed_fields: string[];
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
    '--full-suite-enabled': { key: 'fullSuiteEnabled', type: 'string' },
    '--full-suite-command': { key: 'fullSuiteCommand', type: 'string' },
    '--full-suite-timeout-ms': { key: 'fullSuiteTimeoutMs', type: 'string' },
    '--full-suite-green-summary-max-lines': { key: 'fullSuiteGreenSummaryMaxLines', type: 'string' },
    '--full-suite-red-failure-chunk-lines': { key: 'fullSuiteRedFailureChunkLines', type: 'string' },
    '--full-suite-out-of-scope-failure-policy': { key: 'fullSuiteOutOfScopeFailurePolicy', type: 'string' },
    '--review-execution-policy': { key: 'reviewExecutionPolicy', type: 'string' },
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
    '--review-cycle-auto-split-enabled': { key: 'reviewCycleAutoSplitEnabled', type: 'string' },
    '--project-memory-enabled': { key: 'projectMemoryEnabled', type: 'string' },
    '--project-memory-mode': { key: 'projectMemoryMode', type: 'string' },
    '--project-memory-run-before-final-closeout': { key: 'projectMemoryRunBeforeFinalCloseout', type: 'string' },
    '--project-memory-require-user-approval-for-writes': { key: 'projectMemoryRequireUserApprovalForWrites', type: 'string' },
    '--project-memory-max-compact-summary-chars': { key: 'projectMemoryMaxCompactSummaryChars', type: 'string' },
    '--project-memory-read-strategy': { key: 'projectMemoryReadStrategy', type: 'string' },
    '--project-memory-impact-artifact-retention-days': { key: 'projectMemoryImpactArtifactRetentionDays', type: 'string' }
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

function normalizeWorkflowFileConfig(config: WorkflowFileConfigData): WorkflowFileConfigData {
    const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
    return {
        ...config,
        full_suite_validation: config.full_suite_validation,
        scope_budget_guard: normalizeScopeBudgetGuardConfig(config.scope_budget_guard ?? defaultConfig.scope_budget_guard),
        review_cycle_guard: normalizeReviewCycleGuardConfig(config.review_cycle_guard ?? defaultConfig.review_cycle_guard),
        project_memory_maintenance: cloneProjectMemoryMaintenanceConfig(
            config.project_memory_maintenance ?? defaultConfig.project_memory_maintenance
        )
    };
}

function readWorkflowConfigState(configPath: string, bundleRoot: string): WorkflowConfigState {
    if (!fs.existsSync(configPath) || !fs.statSync(configPath).isFile()) {
        const defaultConfig = buildDefaultWorkflowConfig() as WorkflowConfigData;
        return {
            rawConfig: null,
            config: normalizeWorkflowFileConfig({
                full_suite_validation: defaultConfig.full_suite_validation,
                scope_budget_guard: defaultConfig.scope_budget_guard,
                project_memory_maintenance: defaultConfig.project_memory_maintenance
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
    return `Mandatory full-suite: ${config.full_suite_validation.enabled ? 'true' : 'false'}`;
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

function buildProjectMemoryMaintenanceLine(config: ProjectMemoryMaintenanceConfig): string {
    return `Project memory maintenance: ${config.enabled ? config.mode : 'disabled'} read_strategy=${config.read_strategy} max_compact_summary_chars=${config.max_compact_summary_chars} require_user_approval_for_writes=${config.require_user_approval_for_writes}`;
}

function buildWorkflowShowResult(
    roots: WorkflowCommandRoots,
    state: WorkflowConfigState
): WorkflowShowResult {
    const reviewExecutionPolicy = buildReviewExecutionPolicyView(state);
    const scopeBudgetGuard = normalizeScopeBudgetGuardConfig(state.config.scope_budget_guard);
    const reviewCycleGuard = normalizeReviewCycleGuardConfig(state.config.review_cycle_guard);
    const projectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        state.config.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    return {
        action: 'show',
        scope: 'repo-local',
        target_root: roots.targetRoot,
        bundle_root: roots.bundleRoot,
        config_path: roots.configPath,
        config_exists: state.exists,
        full_suite_validation: state.config.full_suite_validation,
        review_execution_policy: reviewExecutionPolicy,
        scope_budget_guard: scopeBudgetGuard,
        review_cycle_guard: reviewCycleGuard,
        project_memory_maintenance: projectMemoryMaintenance,
        visible_summary_line: buildMandatoryFullSuiteLine(state.config),
        review_execution_policy_summary_line: reviewExecutionPolicy.visible_summary_line,
        scope_budget_guard_summary_line: buildScopeBudgetGuardLine(scopeBudgetGuard),
        review_cycle_guard_summary_line: buildReviewCycleGuardLine(reviewCycleGuard),
        project_memory_maintenance_summary_line: buildProjectMemoryMaintenanceLine(projectMemoryMaintenance)
    };
}

function formatWorkflowShowOutput(result: WorkflowCommandResultBase & { action: 'show' | 'set' }, jsonMode: boolean): string {
    if (jsonMode) {
        return JSON.stringify(result, null, 2);
    }

    const fullSuiteValidation = result.full_suite_validation;
    const reviewExecutionPolicy = result.review_execution_policy;
    const scopeBudgetGuard = result.scope_budget_guard;
    const reviewCycleGuard = result.review_cycle_guard;
    const projectMemoryMaintenance = result.project_memory_maintenance;
    const lines: string[] = [];
    lines.push('GARDA_WORKFLOW');
    lines.push(`Action: ${result.action}`);
    lines.push(`Scope: ${result.scope}`);
    lines.push(`TargetRoot: ${result.target_root}`);
    lines.push(`Bundle: ${result.bundle_root}`);
    lines.push(`ConfigPath: ${result.config_path}`);
    lines.push(`ConfigExists: ${result.config_exists}`);
    lines.push(result.visible_summary_line);
    lines.push(result.review_execution_policy_summary_line);
    lines.push(result.scope_budget_guard_summary_line);
    lines.push(result.review_cycle_guard_summary_line);
    lines.push(result.project_memory_maintenance_summary_line);
    lines.push(`FullSuiteEnabled: ${fullSuiteValidation.enabled}`);
    lines.push(`FullSuiteCommand: ${fullSuiteValidation.command}`);
    lines.push(`FullSuiteTimeoutMs: ${fullSuiteValidation.timeout_ms}`);
    lines.push(`FullSuiteGreenSummaryMaxLines: ${fullSuiteValidation.green_summary_max_lines}`);
    lines.push(`FullSuiteRedFailureChunkLines: ${fullSuiteValidation.red_failure_chunk_lines}`);
    lines.push(`FullSuiteOutOfScopeFailurePolicy: ${fullSuiteValidation.out_of_scope_failure_policy}`);
    lines.push(`ReviewExecutionPolicy: ${reviewExecutionPolicy.mode}`);
    lines.push(`ReviewExecutionPolicyConfigured: ${reviewExecutionPolicy.configured}`);
    lines.push(`ReviewExecutionPolicyDescription: ${reviewExecutionPolicy.description}`);
    lines.push(`ReviewExecutionPolicyAllowedModes: ${reviewExecutionPolicy.allowed_modes.join(', ')}`);
    lines.push(`ScopeBudgetGuardEnabled: ${scopeBudgetGuard.enabled}`);
    lines.push(`ScopeBudgetGuardProfiles: ${scopeBudgetGuard.profiles.join(', ')}`);
    lines.push(`ScopeBudgetGuardAction: ${scopeBudgetGuard.action}`);
    lines.push(`ScopeBudgetGuardMaxFiles: ${scopeBudgetGuard.max_files}`);
    lines.push(`ScopeBudgetGuardMaxChangedLines: ${scopeBudgetGuard.max_changed_lines}`);
    lines.push(`ScopeBudgetGuardMaxRequiredReviews: ${scopeBudgetGuard.max_required_reviews}`);
    lines.push(`ScopeBudgetGuardMaxReviewTokens: ${scopeBudgetGuard.max_review_tokens}`);
    lines.push(`ReviewCycleGuardEnabled: ${reviewCycleGuard.enabled}`);
    lines.push(`ReviewCycleGuardAction: ${reviewCycleGuard.action}`);
    lines.push(`ReviewCycleGuardMaxFailedNonTestReviews: ${reviewCycleGuard.max_failed_non_test_reviews}`);
    lines.push(`ReviewCycleGuardMaxTotalNonTestReviews: ${reviewCycleGuard.max_total_non_test_reviews}`);
    lines.push(`ReviewCycleGuardExcludedReviewTypes: ${reviewCycleGuard.excluded_review_types.join(', ')}`);
    lines.push(`ReviewCycleGuardAutoSplitEnabled: ${reviewCycleGuard.auto_split_enabled}`);
    lines.push(`ProjectMemoryMaintenanceEnabled: ${projectMemoryMaintenance.enabled}`);
    lines.push(`ProjectMemoryMaintenanceMode: ${projectMemoryMaintenance.mode}`);
    lines.push(`ProjectMemoryMaintenanceRunBeforeFinalCloseout: ${projectMemoryMaintenance.run_before_final_closeout}`);
    lines.push(`ProjectMemoryMaintenanceRequireUserApprovalForWrites: ${projectMemoryMaintenance.require_user_approval_for_writes}`);
    lines.push(`ProjectMemoryMaintenanceMaxCompactSummaryChars: ${projectMemoryMaintenance.max_compact_summary_chars}`);
    lines.push(`ProjectMemoryMaintenanceReadStrategy: ${projectMemoryMaintenance.read_strategy}`);
    lines.push(`ProjectMemoryMaintenanceImpactArtifactRetentionDays: ${projectMemoryMaintenance.impact_artifact_retention_days}`);
    lines.push('Tip: run "workflow set --full-suite-enabled true|false" to change the repo-local mode.');
    lines.push(`Tip: run "workflow set --review-execution-policy <${REVIEW_EXECUTION_POLICY_MODES.join('|')}>" to change review launch ordering.`);
    lines.push('Tip: run "workflow set --scope-budget-enabled true|false" to change the scope budget guard.');
    lines.push('Tip: run "workflow set --review-cycle-enabled true|false" to change the review cycle guard.');
    lines.push('Tip: run "workflow set --project-memory-enabled true|false" to change project memory maintenance checks.');
    return lines.join('\n');
}

function parseBooleanText(value: string, flagName: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', '0', 'off'].includes(normalized)) {
        return false;
    }
    throw new Error(`${flagName} must be true or false.`);
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
    const changedFields: string[] = [];

    if (typeof options.fullSuiteEnabled === 'string') {
        nextFullSuiteValidation.enabled = parseBooleanText(options.fullSuiteEnabled, '--full-suite-enabled');
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
    if (typeof options.scopeBudgetEnabled === 'string') {
        nextScopeBudgetGuard.enabled = parseBooleanText(options.scopeBudgetEnabled, '--scope-budget-enabled');
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
    if (typeof options.reviewCycleEnabled === 'string') {
        nextReviewCycleGuard.enabled = parseBooleanText(options.reviewCycleEnabled, '--review-cycle-enabled');
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
    if (typeof options.reviewCycleAutoSplitEnabled === 'string') {
        nextReviewCycleGuard.auto_split_enabled = parseBooleanText(
            options.reviewCycleAutoSplitEnabled,
            '--review-cycle-auto-split-enabled'
        );
        changedFields.push('review_cycle_guard.auto_split_enabled');
    }
    nextConfig.review_cycle_guard = nextReviewCycleGuard;

    const nextProjectMemoryMaintenance = cloneProjectMemoryMaintenanceConfig(
        nextConfig.project_memory_maintenance ?? buildDefaultWorkflowConfig().project_memory_maintenance
    );
    if (typeof options.projectMemoryEnabled === 'string') {
        nextProjectMemoryMaintenance.enabled = parseBooleanText(
            options.projectMemoryEnabled,
            '--project-memory-enabled'
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

    if (changedFields.length === 0) {
        throw new Error(
            "Workflow setting flags are required for 'workflow set'. "
            + 'Use --full-suite-enabled, --full-suite-command, --full-suite-timeout-ms, '
            + '--full-suite-green-summary-max-lines, --full-suite-red-failure-chunk-lines, '
            + '--full-suite-out-of-scope-failure-policy, --review-execution-policy, '
            + '--scope-budget-* flags, --review-cycle-* flags, or --project-memory-* flags.'
        );
    }

    const currentSerialized = JSON.stringify(
        normalizeWorkflowFileConfig(validateWorkflowConfig(state.rawConfig ?? {
            full_suite_validation: state.config.full_suite_validation,
            scope_budget_guard: state.config.scope_budget_guard,
            review_cycle_guard: state.config.review_cycle_guard,
            project_memory_maintenance: state.config.project_memory_maintenance
        }) as WorkflowFileConfigData),
        null,
        2
    ) + '\n';
    const nextValidated = normalizeWorkflowFileConfig(validateWorkflowConfig(nextConfig) as WorkflowFileConfigData);
    const nextSerialized = JSON.stringify(nextValidated, null, 2) + '\n';
    const changed = !state.exists || nextSerialized !== currentSerialized;

    if (changed) {
        writeWorkflowConfig(roots.configPath, nextValidated);
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
        changed_fields: changedFields
    };
    console.log(formatWorkflowShowOutput(result, options.json === true));
    if (options.json !== true) {
        console.log(`Status: ${result.status}`);
        console.log(`ChangedFields: ${result.changed_fields.join(', ')}`);
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
        console.log('GARDA_WORKFLOW');
        console.log('Action: validate');
        console.log('Status: PASS');
        console.log(`ConfigPath: ${roots.configPath}`);
        console.log(result.scope_budget_guard_summary_line);
        console.log(result.review_cycle_guard_summary_line);
        console.log(result.project_memory_maintenance_summary_line);
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
            'Scope budget guard: stops large configured-profile tasks before compile/review loops.',
            'Scope budget guard compares changed file count, changed line count, required review lanes, and estimated review tokens against workflow-config.json limits.',
            'Required review lanes means the number of review types required by the current preflight, not the number of completed review attempts.',
            'Estimated review tokens are a heuristic forecast from review type base cost plus changed file and changed line costs; they are not measured model tokenizer output.',
            'When scope_budget_guard.action is BLOCK_FOR_SPLIT, next-step blocks ordinary continuation and asks the operator to split or decompose the task.',
            'Review cycle guard: stops runaway non-test review cycles after the configured failed or total review-attempt thresholds are exceeded.',
            'Review cycle attempts are deduplicated only when review type, reviewer identity, and review context hash all match; otherwise each timeline event is counted separately.',
            'Review cycle guard excluded_review_types are not counted; the default excludes test reviews because reaching test review means code-facing review lanes have already been handled.',
            'When review_cycle_guard.action is BLOCK_FOR_OPERATOR_DECISION, next-step blocks compile, review, and full-suite continuation until the operator changes config, splits work, or otherwise decides the recovery path.',
            'When review_cycle_guard.auto_split_enabled is false, next-step tells the agent to wait for operator direction after a blocking review-cycle violation.',
            'When review_cycle_guard.auto_split_enabled is true, next-step emits a dedicated auto-split prompt artifact for the agent instead of waiting for operator input.',
            'When review_cycle_guard.action is WARN_ONLY, next-step continues to the next gate but prints the review-cycle violation under Warnings.'
        ]
    };
    if (options.json === true) {
        console.log(JSON.stringify(result, null, 2));
    } else {
        console.log('GARDA_WORKFLOW');
        console.log('Action: explain');
        console.log('Topic: workflow-guards');
        console.log(result.scope_budget_guard_summary_line);
        console.log(result.review_cycle_guard_summary_line);
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
