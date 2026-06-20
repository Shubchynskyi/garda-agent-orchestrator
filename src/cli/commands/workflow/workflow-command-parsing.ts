import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../core/operator-confirmation';
import {
    UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND
} from '../../../core/constants';
import {
    PROJECT_MEMORY_MAINTENANCE_MODES,
    PROJECT_MEMORY_READ_STRATEGIES,
    normalizeFullSuiteValidationPlacement,
    type FullSuiteValidationPlacement,
    type OrchestratorWorkPolicyMode,
    type ProjectMemoryMaintenanceMode,
    type ProjectMemoryReadStrategy
} from '../../../core/workflow-config';
import {
    SCOPE_BUDGET_GUARD_ACTIONS,
    type ScopeBudgetGuardConfig
} from '../../../core/scope-budget-guard';
import {
    REVIEW_CYCLE_GUARD_ACTIONS,
    type ReviewCycleGuardConfig
} from '../../../core/review-cycle-guard';
import {
    OUT_OF_SCOPE_FAILURE_POLICIES,
    type OutOfScopeFailurePolicy
} from '../../../gates/full-suite/full-suite-validation';
import { validateCompileGateCommand } from '../../../gates/compile/compile-gate';
import type {
    ParsedOptionsRecord,
    ResolvedWorkflowBooleanSetting
} from './workflow-command-types';

export function parseBooleanText(value: string, flagName: string): boolean {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on'].includes(normalized)) {
        return true;
    }
    if (['false', 'no', '0', 'off'].includes(normalized)) {
        return false;
    }
    throw new Error(`${flagName} must be one of: true, false, yes, no, 1, 0, on, off.`);
}

export function resolveBooleanSettingOption(options: {
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

export function parseIntegerText(value: string, flagName: string, minimum: number, maximum?: number): number {
    if (!/^\d+$/.test(value.trim())) {
        throw new Error(`${flagName} must be an integer.`);
    }
    const parsed = Number.parseInt(value.trim(), 10);
    if (parsed < minimum) {
        throw new Error(`${flagName} must be >= ${minimum}.`);
    }
    if (maximum !== undefined && parsed > maximum) {
        throw new Error(`${flagName} must be <= ${maximum}.`);
    }
    return parsed;
}

export function parseOutOfScopeFailurePolicy(value: string): OutOfScopeFailurePolicy {
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

export function parseFullSuitePlacement(value: string): FullSuiteValidationPlacement {
    return normalizeFullSuiteValidationPlacement(value, {
        rejectInvalidExplicit: true,
        errorPath: '--full-suite-placement'
    });
}

export function normalizeFullSuiteCommandForCompileGateValidation(command: unknown): string | null {
    const value = typeof command === 'string' ? command.trim() : '';
    if (!value || value === UNCONFIGURED_FULL_SUITE_VALIDATION_COMMAND) {
        return null;
    }
    return value;
}

export function validateWorkflowCompileGateCommand(command: string, fullSuiteCommand: unknown): void {
    validateCompileGateCommand(command, '--compile-gate-command', {
        fullSuiteCommand: normalizeFullSuiteCommandForCompileGateValidation(fullSuiteCommand)
    });
}

export function parseScopeBudgetAction(value: string): ScopeBudgetGuardConfig['action'] {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!SCOPE_BUDGET_GUARD_ACTIONS.includes(normalized as ScopeBudgetGuardConfig['action'])) {
        throw new Error(`--scope-budget-action must be one of: ${SCOPE_BUDGET_GUARD_ACTIONS.join(', ')}.`);
    }
    return normalized as ScopeBudgetGuardConfig['action'];
}

export function parseReviewCycleAction(value: string): ReviewCycleGuardConfig['action'] {
    const normalized = value.trim().toUpperCase().replace(/[\s-]+/g, '_');
    if (!REVIEW_CYCLE_GUARD_ACTIONS.includes(normalized as ReviewCycleGuardConfig['action'])) {
        throw new Error(`--review-cycle-action must be one of: ${REVIEW_CYCLE_GUARD_ACTIONS.join(', ')}.`);
    }
    return normalized as ReviewCycleGuardConfig['action'];
}

export function parseProjectMemoryMaintenanceMode(value: string): ProjectMemoryMaintenanceMode {
    const normalized = value.trim().toLowerCase();
    if (!PROJECT_MEMORY_MAINTENANCE_MODES.includes(normalized as ProjectMemoryMaintenanceMode)) {
        throw new Error(`--project-memory-mode must be one of: ${PROJECT_MEMORY_MAINTENANCE_MODES.join(', ')}.`);
    }
    return normalized as ProjectMemoryMaintenanceMode;
}

export function parseProjectMemoryReadStrategy(value: string): ProjectMemoryReadStrategy {
    const normalized = value.trim().toLowerCase();
    if (!PROJECT_MEMORY_READ_STRATEGIES.includes(normalized as ProjectMemoryReadStrategy)) {
        throw new Error(`--project-memory-read-strategy must be one of: ${PROJECT_MEMORY_READ_STRATEGIES.join(', ')}.`);
    }
    return normalized as ProjectMemoryReadStrategy;
}

export function parseGardaSelfGuardMode(value: string): OrchestratorWorkPolicyMode {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'on' || normalized === 'true' || normalized === '1' || normalized === 'yes') {
        return 'deny_agent_entry';
    }
    if (normalized === 'off' || normalized === 'false' || normalized === '0' || normalized === 'no') {
        return 'require_operator_confirmation';
    }
    throw new Error('--garda-self-guard must be on or off.');
}

export function parseProfileList(value: string): string[] {
    const profiles = [...new Set(value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean))];
    if (profiles.length === 0) {
        throw new Error('--scope-budget-profiles must contain at least one profile.');
    }
    return profiles;
}

export function parseReviewTypeList(value: string, flagName: string): string[] {
    const reviewTypes = [...new Set(value
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean))];
    if (reviewTypes.length === 0) {
        throw new Error(`${flagName} must contain at least one review type.`);
    }
    return reviewTypes;
}

export function requireWorkflowSetOperatorConfirmation(options: ParsedOptionsRecord): void {
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
