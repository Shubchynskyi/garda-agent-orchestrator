import {
    cloneUnknownProperties,
    ensurePlainObject,
    normalizeBooleanLike,
    normalizeInteger,
    normalizeNonEmptyString,
    normalizeStringArray
} from './shared';
import { normalizeReviewExecutionPolicyMode } from '../core/review-execution-policy';
import {
    SCOPE_BUDGET_GUARD_ACTIONS,
    normalizeScopeBudgetGuardConfig
} from '../core/scope-budget-guard';
import {
    REVIEW_CYCLE_GUARD_ACTIONS,
    normalizeReviewCycleGuardConfig
} from '../core/review-cycle-guard';
import {
    ORCHESTRATOR_WORK_POLICY_MODES,
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES,
    FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX,
    buildDefaultWorkflowConfig,
    normalizeFullSuiteValidationPlacement,
    type OrchestratorWorkPolicyMode
} from '../core/workflow-config';
import {
    assertNoCaseMismatchedKnownKeys,
    assertNoLikelyTypoKeys,
    assertNoUnknownKeys
} from './config-artifacts-shared';

const VALID_WORKFLOW_FULL_SUITE_FAILURE_POLICIES = new Set(['AUDIT_AND_BLOCK', 'AUDIT_AND_WARN']);


export function validateWorkflowConfig(input: unknown): Record<string, unknown> {
    const raw = ensurePlainObject(input, 'workflow-config');
    const knownKeyList = ['compile_gate', 'full_suite_validation', 'review_execution_policy', 'scope_budget_guard', 'review_cycle_guard', 'project_memory_maintenance', 'task_reset', 'auto_backup', 'orchestrator_work_policy'] as const;
    const knownKeys = new Set(knownKeyList);
    assertNoCaseMismatchedKnownKeys(
        raw,
        knownKeyList,
        'workflow-config'
    );
    assertNoLikelyTypoKeys(raw, knownKeyList, 'workflow-config');
    const normalized = cloneUnknownProperties(raw, knownKeys);

    const section = ensurePlainObject(raw.full_suite_validation, 'workflow-config.full_suite_validation');
    const sectionKnownKeys = new Set([
        'enabled',
        'command',
        'timeout_ms',
        'timeout_blocker',
        'timeout_retry_count',
        'green_summary_max_lines',
        'red_failure_chunk_lines',
        'out_of_scope_failure_policy',
        'placement'
    ]);
    assertNoCaseMismatchedKnownKeys(
        section,
        [
            'enabled',
            'command',
            'timeout_ms',
            'timeout_blocker',
            'timeout_retry_count',
            'green_summary_max_lines',
            'red_failure_chunk_lines',
            'out_of_scope_failure_policy',
            'placement'
        ],
        'workflow-config.full_suite_validation'
    );
    const normalizedSection = cloneUnknownProperties(section, sectionKnownKeys);

    normalizedSection.enabled = normalizeBooleanLike(
        section.enabled,
        'workflow-config.full_suite_validation.enabled'
    );
    normalizedSection.command = normalizeNonEmptyString(
        section.command,
        'workflow-config.full_suite_validation.command'
    );
    normalizedSection.timeout_ms = normalizeInteger(
        section.timeout_ms,
        'workflow-config.full_suite_validation.timeout_ms',
        { minimum: 1000 }
    );
    normalizedSection.timeout_blocker = normalizeBooleanLike(
        section.timeout_blocker ?? buildDefaultWorkflowConfig().full_suite_validation.timeout_blocker,
        'workflow-config.full_suite_validation.timeout_blocker'
    );
    normalizedSection.timeout_retry_count = normalizeInteger(
        section.timeout_retry_count ?? buildDefaultWorkflowConfig().full_suite_validation.timeout_retry_count,
        'workflow-config.full_suite_validation.timeout_retry_count',
        { minimum: 0, maximum: FULL_SUITE_TIMEOUT_RETRY_COUNT_MAX }
    );
    normalizedSection.green_summary_max_lines = normalizeInteger(
        section.green_summary_max_lines,
        'workflow-config.full_suite_validation.green_summary_max_lines',
        { minimum: 1 }
    );
    normalizedSection.red_failure_chunk_lines = normalizeInteger(
        section.red_failure_chunk_lines,
        'workflow-config.full_suite_validation.red_failure_chunk_lines',
        { minimum: 10 }
    );
    const policy = normalizeNonEmptyString(
        section.out_of_scope_failure_policy,
        'workflow-config.full_suite_validation.out_of_scope_failure_policy'
    ).toUpperCase();
    if (!VALID_WORKFLOW_FULL_SUITE_FAILURE_POLICIES.has(policy)) {
        throw new Error(
            'workflow-config.full_suite_validation.out_of_scope_failure_policy must be one of: '
            + `${[...VALID_WORKFLOW_FULL_SUITE_FAILURE_POLICIES].join(', ')}.`
        );
    }
    normalizedSection.out_of_scope_failure_policy = policy;
    normalizedSection.placement = normalizeFullSuiteValidationPlacement(section.placement, {
        rejectInvalidExplicit: true,
        errorPath: 'workflow-config.full_suite_validation.placement'
    });

    normalized.full_suite_validation = normalizedSection;
    if (raw.compile_gate !== undefined) {
        normalized.compile_gate = validateCompileGateSection(raw.compile_gate);
    }
    if (raw.review_execution_policy === undefined) {
        if (raw.scope_budget_guard !== undefined) {
            normalized.scope_budget_guard = validateScopeBudgetGuardSection(raw.scope_budget_guard);
        }
        if (raw.review_cycle_guard !== undefined) {
            normalized.review_cycle_guard = validateReviewCycleGuardSection(raw.review_cycle_guard);
        }
        if (raw.project_memory_maintenance !== undefined) {
            normalized.project_memory_maintenance = validateProjectMemoryMaintenanceSection(raw.project_memory_maintenance);
        }
        if (raw.task_reset !== undefined) {
            normalized.task_reset = validateTaskResetSection(raw.task_reset);
        }
        if (raw.auto_backup !== undefined) {
            normalized.auto_backup = validateAutoBackupSection(raw.auto_backup);
        }
        if (raw.orchestrator_work_policy !== undefined) {
            normalized.orchestrator_work_policy = validateOrchestratorWorkPolicySection(raw.orchestrator_work_policy);
        }
        return normalized;
    }

    const reviewExecutionPolicy = ensurePlainObject(
        raw.review_execution_policy,
        'workflow-config.review_execution_policy'
    );
    assertNoCaseMismatchedKnownKeys(
        reviewExecutionPolicy,
        ['mode'],
        'workflow-config.review_execution_policy'
    );
    assertNoUnknownKeys(
        reviewExecutionPolicy,
        ['mode'],
        'workflow-config.review_execution_policy'
    );
    const normalizedReviewExecutionPolicy: Record<string, unknown> = {};
    normalizedReviewExecutionPolicy.mode = normalizeReviewExecutionPolicyMode(
        reviewExecutionPolicy.mode,
        'workflow-config.review_execution_policy.mode'
    );
    normalized.review_execution_policy = normalizedReviewExecutionPolicy;
    if (raw.scope_budget_guard !== undefined) {
        normalized.scope_budget_guard = validateScopeBudgetGuardSection(raw.scope_budget_guard);
    }
    if (raw.review_cycle_guard !== undefined) {
        normalized.review_cycle_guard = validateReviewCycleGuardSection(raw.review_cycle_guard);
    }
    if (raw.project_memory_maintenance !== undefined) {
        normalized.project_memory_maintenance = validateProjectMemoryMaintenanceSection(raw.project_memory_maintenance);
    }
    if (raw.task_reset !== undefined) {
        normalized.task_reset = validateTaskResetSection(raw.task_reset);
    }
    if (raw.auto_backup !== undefined) {
        normalized.auto_backup = validateAutoBackupSection(raw.auto_backup);
    }
    if (raw.orchestrator_work_policy !== undefined) {
        normalized.orchestrator_work_policy = validateOrchestratorWorkPolicySection(raw.orchestrator_work_policy);
    }
    return normalized;
}

function validateCompileGateSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.compile_gate');
    assertNoCaseMismatchedKnownKeys(
        section,
        ['command'],
        'workflow-config.compile_gate'
    );
    assertNoUnknownKeys(
        section,
        ['command'],
        'workflow-config.compile_gate'
    );
    return {
        command: normalizeNonEmptyString(section.command, 'workflow-config.compile_gate.command')
    };
}

function validateOrchestratorWorkPolicySection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.orchestrator_work_policy');
    assertNoCaseMismatchedKnownKeys(
        section,
        ['mode'],
        'workflow-config.orchestrator_work_policy'
    );
    assertNoUnknownKeys(
        section,
        ['mode'],
        'workflow-config.orchestrator_work_policy'
    );
    const defaults = buildDefaultWorkflowConfig().orchestrator_work_policy as unknown as Record<string, unknown>;
    const normalizedInput = {
        ...defaults,
        ...section
    };
    const mode = normalizeNonEmptyString(
        normalizedInput.mode,
        'workflow-config.orchestrator_work_policy.mode'
    ).toLowerCase();
    if (!ORCHESTRATOR_WORK_POLICY_MODES.includes(mode as OrchestratorWorkPolicyMode)) {
        throw new Error(
            `workflow-config.orchestrator_work_policy.mode must be one of: ${ORCHESTRATOR_WORK_POLICY_MODES.join(', ')}.`
        );
    }
    return {
        ...normalizedInput,
        mode
    };
}

function validateTaskResetSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.task_reset');
    assertNoCaseMismatchedKnownKeys(
        section,
        ['enabled'],
        'workflow-config.task_reset'
    );
    assertNoUnknownKeys(
        section,
        ['enabled'],
        'workflow-config.task_reset'
    );

    const defaults = buildDefaultWorkflowConfig().task_reset as unknown as Record<string, unknown>;
    const normalizedInput = {
        ...defaults,
        ...section
    };
    normalizedInput.enabled = normalizeBooleanLike(
        normalizedInput.enabled,
        'workflow-config.task_reset.enabled'
    );
    return normalizedInput;
}

function validateAutoBackupSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.auto_backup');
    const sectionKnownKeys = ['enabled', 'interval_days', 'keep_latest'];
    assertNoCaseMismatchedKnownKeys(
        section,
        sectionKnownKeys,
        'workflow-config.auto_backup'
    );
    assertNoUnknownKeys(
        section,
        sectionKnownKeys,
        'workflow-config.auto_backup'
    );

    const defaults = buildDefaultWorkflowConfig().auto_backup as unknown as Record<string, unknown>;
    const normalizedInput = {
        ...defaults,
        ...section
    };
    normalizedInput.enabled = normalizeBooleanLike(
        normalizedInput.enabled,
        'workflow-config.auto_backup.enabled'
    );
    normalizedInput.interval_days = normalizeInteger(
        normalizedInput.interval_days,
        'workflow-config.auto_backup.interval_days',
        { minimum: 1 }
    );
    normalizedInput.keep_latest = normalizeInteger(
        normalizedInput.keep_latest,
        'workflow-config.auto_backup.keep_latest',
        { minimum: 1 }
    );
    return normalizedInput;
}

function validateProjectMemoryMaintenanceSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.project_memory_maintenance');
    const sectionKnownKeys = [
        'enabled',
        'mode',
        'run_before_final_closeout',
        'require_user_approval_for_writes',
        'max_compact_summary_chars',
        'read_strategy',
        'impact_artifact_retention_days'
    ];
    assertNoCaseMismatchedKnownKeys(
        section,
        sectionKnownKeys,
        'workflow-config.project_memory_maintenance'
    );
    assertNoUnknownKeys(
        section,
        sectionKnownKeys,
        'workflow-config.project_memory_maintenance'
    );

    const defaults = buildDefaultWorkflowConfig().project_memory_maintenance as unknown as Record<string, unknown>;
    const normalizedInput = {
        ...defaults,
        ...section
    };

    normalizedInput.enabled = normalizeBooleanLike(
        normalizedInput.enabled,
        'workflow-config.project_memory_maintenance.enabled'
    );
    const mode = normalizeNonEmptyString(
        normalizedInput.mode,
        'workflow-config.project_memory_maintenance.mode'
    ).toLowerCase();
    if (!PROJECT_MEMORY_MAINTENANCE_MODES.includes(mode as typeof PROJECT_MEMORY_MAINTENANCE_MODES[number])) {
        throw new Error(
            'workflow-config.project_memory_maintenance.mode must be one of: '
            + `${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}.`
        );
    }
    normalizedInput.mode = mode;
    normalizedInput.run_before_final_closeout = normalizeBooleanLike(
        normalizedInput.run_before_final_closeout,
        'workflow-config.project_memory_maintenance.run_before_final_closeout'
    );
    normalizedInput.require_user_approval_for_writes = normalizeBooleanLike(
        normalizedInput.require_user_approval_for_writes,
        'workflow-config.project_memory_maintenance.require_user_approval_for_writes'
    );
    normalizedInput.max_compact_summary_chars = normalizeInteger(
        normalizedInput.max_compact_summary_chars,
        'workflow-config.project_memory_maintenance.max_compact_summary_chars',
        { minimum: 2000 }
    );
    const readStrategy = normalizeNonEmptyString(
        normalizedInput.read_strategy,
        'workflow-config.project_memory_maintenance.read_strategy'
    ).toLowerCase();
    if (!PROJECT_MEMORY_READ_STRATEGIES.includes(readStrategy as typeof PROJECT_MEMORY_READ_STRATEGIES[number])) {
        throw new Error(
            'workflow-config.project_memory_maintenance.read_strategy must be one of: '
            + `${PROJECT_MEMORY_READ_STRATEGIES.join(', ')}.`
        );
    }
    normalizedInput.read_strategy = readStrategy;
    normalizedInput.impact_artifact_retention_days = normalizeInteger(
        normalizedInput.impact_artifact_retention_days,
        'workflow-config.project_memory_maintenance.impact_artifact_retention_days',
        { minimum: 1 }
    );

    return normalizedInput;
}

function validateScopeBudgetGuardSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.scope_budget_guard');
    const normalizedInput = { ...section };
    assertNoCaseMismatchedKnownKeys(
        section,
        ['enabled', 'profiles', 'action', 'max_files', 'max_changed_lines', 'max_required_reviews', 'max_review_tokens'],
        'workflow-config.scope_budget_guard'
    );
    assertNoUnknownKeys(
        section,
        ['enabled', 'profiles', 'action', 'max_files', 'max_changed_lines', 'max_required_reviews', 'max_review_tokens'],
        'workflow-config.scope_budget_guard'
    );
    if (section.enabled !== undefined) {
        normalizedInput.enabled = normalizeBooleanLike(
            section.enabled,
            'workflow-config.scope_budget_guard.enabled'
        );
    }
    if (section.action !== undefined) {
        const normalizedAction = normalizeNonEmptyString(
            section.action,
            'workflow-config.scope_budget_guard.action'
        ).toUpperCase().replace(/[\s-]+/g, '_');
        if (!SCOPE_BUDGET_GUARD_ACTIONS.includes(normalizedAction as typeof SCOPE_BUDGET_GUARD_ACTIONS[number])) {
            throw new Error(
                'workflow-config.scope_budget_guard.action must be one of: '
                + `${SCOPE_BUDGET_GUARD_ACTIONS.join(', ')}.`
            );
        }
        normalizedInput.action = normalizedAction;
    }
    if (section.profiles !== undefined) {
        normalizedInput.profiles = normalizeStringArray(
            section.profiles,
            'workflow-config.scope_budget_guard.profiles'
        );
    }
    for (const key of ['max_files', 'max_changed_lines', 'max_required_reviews', 'max_review_tokens']) {
        if (section[key] !== undefined) {
            normalizedInput[key] = normalizeInteger(section[key], `workflow-config.scope_budget_guard.${key}`, { minimum: 1 });
        }
    }
    const normalized = normalizeScopeBudgetGuardConfig(normalizedInput) as unknown as Record<string, unknown>;
    return normalized;
}

function validateReviewCycleGuardSection(input: unknown): Record<string, unknown> {
    const section = ensurePlainObject(input, 'workflow-config.review_cycle_guard');
    const normalizedInput = { ...section };
    assertNoCaseMismatchedKnownKeys(
        section,
        ['enabled', 'action', 'max_failed_non_test_reviews', 'max_total_non_test_reviews', 'excluded_review_types', 'auto_split_enabled'],
        'workflow-config.review_cycle_guard'
    );
    assertNoUnknownKeys(
        section,
        ['enabled', 'action', 'max_failed_non_test_reviews', 'max_total_non_test_reviews', 'excluded_review_types', 'auto_split_enabled'],
        'workflow-config.review_cycle_guard'
    );
    if (section.enabled !== undefined) {
        normalizedInput.enabled = normalizeBooleanLike(
            section.enabled,
            'workflow-config.review_cycle_guard.enabled'
        );
    }
    if (section.action !== undefined) {
        const normalizedAction = normalizeNonEmptyString(
            section.action,
            'workflow-config.review_cycle_guard.action'
        ).toUpperCase().replace(/[\s-]+/g, '_');
        if (!REVIEW_CYCLE_GUARD_ACTIONS.includes(normalizedAction as typeof REVIEW_CYCLE_GUARD_ACTIONS[number])) {
            throw new Error(
                'workflow-config.review_cycle_guard.action must be one of: '
                + `${REVIEW_CYCLE_GUARD_ACTIONS.join(', ')}.`
            );
        }
        normalizedInput.action = normalizedAction;
    }
    if (section.excluded_review_types !== undefined) {
        normalizedInput.excluded_review_types = normalizeStringArray(
            section.excluded_review_types,
            'workflow-config.review_cycle_guard.excluded_review_types'
        );
    }
    if (section.auto_split_enabled !== undefined) {
        normalizedInput.auto_split_enabled = normalizeBooleanLike(
            section.auto_split_enabled,
            'workflow-config.review_cycle_guard.auto_split_enabled'
        );
    }
    for (const key of ['max_failed_non_test_reviews', 'max_total_non_test_reviews']) {
        if (section[key] !== undefined) {
            normalizedInput[key] = normalizeInteger(section[key], `workflow-config.review_cycle_guard.${key}`, { minimum: 1 });
        }
    }
    return normalizeReviewCycleGuardConfig(normalizedInput) as unknown as Record<string, unknown>;
}
