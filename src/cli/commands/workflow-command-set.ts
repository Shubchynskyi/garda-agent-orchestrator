import {
    buildDefaultWorkflowConfig,
    hasMaterializedWorkflowConfigBaseline,
    normalizeCompileGateConfig,
    normalizeOrchestratorWorkPolicyConfig,
    type WorkflowConfigData
} from '../../core/workflow-config';
import { normalizeReviewExecutionPolicyMode } from '../../core/review-execution-policy';
import { normalizeScopeBudgetGuardConfig } from '../../core/scope-budget-guard';
import { normalizeReviewCycleGuardConfig } from '../../core/review-cycle-guard';
import { validateWorkflowConfig } from '../../schemas/config-artifacts';
import {
    cloneOrchestratorWorkPolicyConfig,
    cloneProjectMemoryMaintenanceConfig,
    cloneTaskResetConfig,
    normalizeWorkflowFileConfig,
    readWorkflowConfigState,
    resolveWorkflowRoots
} from './workflow-command-state';
import {
    buildWorkflowShowResult,
    formatWorkflowSetSummaryOutput,
    formatWorkflowShowOutput,
    isConfiguredCompileGateCommand
} from './workflow-command-rendering';
import {
    parseBooleanText,
    parseFullSuitePlacement,
    parseIntegerText,
    parseOutOfScopeFailurePolicy,
    parseProfileList,
    parseProjectMemoryMaintenanceMode,
    parseProjectMemoryReadStrategy,
    parseReviewCycleAction,
    parseReviewTypeList,
    parseScopeBudgetAction,
    parseGardaSelfGuardMode,
    requireWorkflowSetOperatorConfirmation,
    resolveBooleanSettingOption,
    validateWorkflowCompileGateCommand
} from './workflow-command-parsing';
import {
    normalizeOutputPath,
    refreshWorkflowProtectedManifest,
    resolveActualChangedFields,
    writeWorkflowConfig,
    writeWorkflowConfigAuditRecord
} from './workflow-command-mutation';
import type {
    ParsedOptionsRecord,
    WorkflowFileConfigData,
    WorkflowSetResult
} from './workflow-command-types';

export function handleSet(options: ParsedOptionsRecord): WorkflowSetResult {
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
        protectedManifestPath = refreshWorkflowProtectedManifest(roots.targetRoot);
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
