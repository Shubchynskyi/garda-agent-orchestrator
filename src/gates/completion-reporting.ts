import * as path from 'node:path';
import { getBundleCliCommand, getSourceCliCommand, resolveBundleName } from '../core/constants';
import { isOrchestratorSourceCheckout } from './helpers';

/**
 * Escape a string value for use in PowerShell CLI invocations.
 */
export function quotePowerShellCliValue(value: string): string {
    return `'${String(value).replace(/'/g, "''")}'`;
}

/**
 * Build the `restart-coherent-cycle` recovery command string for a failed completion gate.
 */
export function buildCoherentCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-coherent-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ];
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    return parts.join(' ');
}

/**
 * Build the `restart-review-cycle` recovery command string for a failed completion gate.
 */
export function buildReviewCycleRestartCommand(
    repoRoot: string,
    taskId: string,
    preflightPath: string,
    taskModePath: string | null,
    commandsPath: string | null,
    outputFiltersPath: string | null
): string {
    const cliPrefix = isOrchestratorSourceCheckout(repoRoot)
        ? getSourceCliCommand()
        : getBundleCliCommand(resolveBundleName());
    const parts = [
        `${cliPrefix} gate restart-review-cycle`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--preflight-path ${quotePowerShellCliValue(preflightPath)}`
    ];
    if (taskModePath) {
        parts.push(`--task-mode-path ${quotePowerShellCliValue(taskModePath)}`);
    }
    if (commandsPath) {
        parts.push(`--commands-path ${quotePowerShellCliValue(commandsPath)}`);
    }
    if (outputFiltersPath) {
        parts.push(`--output-filters-path ${quotePowerShellCliValue(outputFiltersPath)}`);
    }
    return parts.join(' ');
}

/**
 * Format the completion gate result object into human-readable diagnostic output.
 */
export function formatCompletionGateResult(result: Record<string, unknown>): string {
    const lines: string[] = [
        result.outcome === 'PASS' ? 'COMPLETION_GATE_PASSED' : 'COMPLETION_GATE_FAILED',
        `TaskId: ${result.task_id}`,
        `Status: ${result.status}`,
        `Outcome: ${result.outcome}`
    ];

    const trustLevels = new Set<string>();
    if (result.review_artifacts && typeof result.review_artifacts === 'object') {
        for (const key of Object.keys(result.review_artifacts)) {
            const artifact = (result.review_artifacts as any)[key];
            if (artifact && artifact.receipt && artifact.receipt.trust_level) {
                trustLevels.add(artifact.receipt.trust_level);
            }
        }
    }
    if (trustLevels.size > 0) {
        lines.push(`TrustStatus: ${Array.from(trustLevels).join(', ')}`);
    }

    const plan = result.plan as Record<string, unknown> | undefined;
    if (plan) {
        lines.push(`PlanGuided: ${!!plan.plan_guided}`);
        if (plan.plan_guided && plan.plan_path) {
            lines.push(`PlanPath: ${plan.plan_path}`);
        }
    }

    if (Array.isArray(result.violations) && result.violations.length > 0) {
        lines.push('Violations:');
        for (const violation of result.violations) {
            lines.push(`- ${violation}`);
        }
    }

    if (typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()) {
        lines.push(`RecoveryCommand: ${result.coherent_cycle_restart_command}`);
    }
    if (typeof result.review_cycle_restart_command === 'string' && result.review_cycle_restart_command.trim()) {
        lines.push(
            typeof result.coherent_cycle_restart_command === 'string' && result.coherent_cycle_restart_command.trim()
                ? `ReviewRecoveryCommand: ${result.review_cycle_restart_command}`
                : `RecoveryCommand: ${result.review_cycle_restart_command}`
        );
    }

    if (Array.isArray(result.isolation_mode_warnings) && result.isolation_mode_warnings.length > 0) {
        lines.push('IsolationModeWarnings:');
        for (const warning of result.isolation_mode_warnings) {
            lines.push(`- ${warning}`);
        }
    }

    return lines.join('\n');
}
