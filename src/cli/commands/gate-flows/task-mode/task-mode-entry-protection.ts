import * as path from 'node:path';
import {
    parseOperatorConfirmationYes,
    validateFreshOperatorConfirmation
} from '../../../../core/operator-confirmation';
import {
    formatGardaSelfGuardProtectedControlPlaneGuidance,
    isGardaSelfGuardDenyAgentEntryForBundle
} from '../../../../core/workflow-config';
import {
    normalizeTaskModeEntryMode,
    parseTaskModeDepth
} from '../../../../gates/task-mode/task-mode';
import * as gateHelpers from '../../../../gates/shared/helpers';
import {
    quotePowerShellCliValue,
    buildGateCommandPrefix
} from './task-mode-command-format';

export const WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE = 'workflow-config policy changes';

interface TaskModeHandoffOptions {
    entryMode?: unknown;
    requestedDepth?: unknown;
    effectiveDepth?: unknown;
    taskSummary?: unknown;
    startBanner?: unknown;
    provider?: unknown;
    routedTo?: unknown;
    actor?: unknown;
    planPath?: string;
    artifactPath?: string;
    metricsPath?: string;
    emitMetrics?: unknown;
}

interface TaskQueueMetadataForProtectedEntry {
    area?: string | null;
    title?: string | null;
    notes?: string | null;
}

export interface AssertTaskModeProtectedEntryAllowedOptions {
    repoRoot: string;
    orchestratorRoot: string;
    taskId: string;
    options: TaskModeHandoffOptions & {
        orchestratorWork?: unknown;
        workflowConfigWork?: unknown;
        operatorConfirmed?: unknown;
        operatorConfirmedAtUtc?: unknown;
    };
    plannedChangedFiles: string[];
    protectedPlannedFiles: string[];
    workflowConfigPlannedFiles: string[];
    dirtyWorkflowConfigFiles: string[];
    orchestratorWork: boolean;
    workflowConfigWork: boolean;
    taskQueueMetadata: TaskQueueMetadataForProtectedEntry | null;
}

function buildProtectedOperatorConfirmationCommandParts(): string[] {
    return [
        '--operator-confirmed yes',
        '--operator-confirmed-at-utc "<ISO-8601 timestamp>"'
    ];
}

export function buildOrchestratorWorkHandoffCommand(
    repoRoot: string,
    taskId: string,
    options: TaskModeHandoffOptions,
    plannedChangedFiles: string[],
    includeWorkflowConfigWork = false
): string {
    const parts: string[] = [
        `${buildGateCommandPrefix(repoRoot)} gate enter-task-mode`,
        `--repo-root ${quotePowerShellCliValue(path.resolve(repoRoot))}`,
        `--task-id ${quotePowerShellCliValue(taskId)}`,
        `--entry-mode ${quotePowerShellCliValue(normalizeTaskModeEntryMode(options.entryMode || 'EXPLICIT_TASK_EXECUTION'))}`,
        `--requested-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(options.requestedDepth, 'RequestedDepth', 2)))}`,
        `--task-summary ${quotePowerShellCliValue(String(options.taskSummary || '').trim())}`,
        '--orchestrator-work'
    ];
    if (includeWorkflowConfigWork) {
        parts.push('--workflow-config-work');
    }
    parts.push(...buildProtectedOperatorConfirmationCommandParts());
    const startBanner = String(options.startBanner || '').trim();
    if (startBanner) {
        parts.push(`--start-banner ${quotePowerShellCliValue(startBanner)}`);
    }

    const effectiveDepthRaw = String(options.effectiveDepth || '').trim();
    if (effectiveDepthRaw) {
        parts.push(`--effective-depth ${quotePowerShellCliValue(String(parseTaskModeDepth(effectiveDepthRaw, 'EffectiveDepth', 2)))}`);
    }
    const provider = String(options.provider || '').trim();
    if (provider) {
        parts.push(`--provider ${quotePowerShellCliValue(provider)}`);
    }
    const routedTo = String(options.routedTo || '').trim();
    if (routedTo) {
        parts.push(`--routed-to ${quotePowerShellCliValue(routedTo)}`);
    }
    const actor = String(options.actor || '').trim();
    if (actor) {
        parts.push(`--actor ${quotePowerShellCliValue(actor)}`);
    }
    const planPath = String(options.planPath || '').trim();
    if (planPath) {
        parts.push(`--plan-path ${quotePowerShellCliValue(planPath)}`);
    }
    const artifactPath = String(options.artifactPath || '').trim();
    if (artifactPath) {
        parts.push(`--artifact-path ${quotePowerShellCliValue(artifactPath)}`);
    }
    const metricsPath = String(options.metricsPath || '').trim();
    if (metricsPath) {
        parts.push(`--metrics-path ${quotePowerShellCliValue(metricsPath)}`);
    }
    if (options.emitMetrics === false || String(options.emitMetrics || '').trim().toLowerCase() === 'false') {
        parts.push('--emit-metrics false');
    }
    for (const plannedChangedFile of plannedChangedFiles) {
        parts.push(`--planned-changed-file ${quotePowerShellCliValue(plannedChangedFile)}`);
    }
    return parts.join(' ');
}

export function taskMetadataAllowsWorkflowConfigWork(taskQueueMetadata: TaskQueueMetadataForProtectedEntry | null): boolean {
    if (!taskQueueMetadata) {
        return false;
    }
    const trustedTaskText = [
        taskQueueMetadata.area,
        taskQueueMetadata.title,
        taskQueueMetadata.notes
    ].filter(Boolean).join(' ').toLowerCase();
    return trustedTaskText.includes(WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE);
}

export function isGardaSelfGuardDenyAgentEntry(repoRoot: string, orchestratorRoot: string): boolean {
    return isGardaSelfGuardDenyAgentEntryForBundle(
        gateHelpers.isOrchestratorSourceCheckout(repoRoot),
        orchestratorRoot
    );
}

export function buildGardaSelfGuardDenialMessage(protectedFiles: readonly string[]): string {
    return formatGardaSelfGuardProtectedControlPlaneGuidance({
        protectedFiles,
        includeWorkflowConfigWork: true
    });
}

export function requireTaskModeOperatorConfirmation(
    options: {
        operatorConfirmed?: unknown;
        operatorConfirmedAtUtc?: unknown;
    },
    scopeLabel: string
): void {
    const rawConfirmation = String(options.operatorConfirmed || '').trim();
    const confirmed = rawConfirmation ? parseOperatorConfirmationYes(rawConfirmation) : false;
    validateFreshOperatorConfirmation({
        actionLabel: `enter-task-mode ${scopeLabel}`,
        confirmed,
        confirmedAtUtc: String(options.operatorConfirmedAtUtc || '').trim(),
        requireConfirmedAtUtc: true,
        instruction:
            'Ask the operator to approve this protected task-mode entry, then rerun with --operator-confirmed yes and --operator-confirmed-at-utc "<ISO-8601 timestamp>". ' +
            'Agents must not approve --orchestrator-work or --workflow-config-work for themselves.'
    });
}

export function assertTaskModeProtectedEntryAllowed(input: AssertTaskModeProtectedEntryAllowedOptions): void {
    const {
        repoRoot,
        orchestratorRoot,
        taskId,
        options,
        plannedChangedFiles,
        protectedPlannedFiles,
        workflowConfigPlannedFiles,
        dirtyWorkflowConfigFiles,
        orchestratorWork,
        workflowConfigWork,
        taskQueueMetadata
    } = input;

    if (dirtyWorkflowConfigFiles.length > 0) {
        throw new Error(
            `Workspace already contains workflow config changes before task-mode entry: ${dirtyWorkflowConfigFiles.join(', ')}. ` +
            'Enter task mode before editing workflow-config.json so the change cannot be laundered into the baseline.'
        );
    }

    if (
        isGardaSelfGuardDenyAgentEntry(repoRoot, orchestratorRoot)
        && (orchestratorWork || workflowConfigWork || protectedPlannedFiles.length > 0)
    ) {
        throw new Error(buildGardaSelfGuardDenialMessage(protectedPlannedFiles));
    }

    if (workflowConfigWork && !orchestratorWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, true);
        throw new Error(
            'Task-mode --workflow-config-work requires --orchestrator-work because workflow-config.json is part of the protected orchestrator control plane. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (workflowConfigWork && workflowConfigPlannedFiles.length === 0) {
        throw new Error(
            'Task-mode --workflow-config-work requires the planned task scope to include a protected workflow-config.json file. ' +
            'Add the intended workflow-config.json path to the planned changed files before entering task mode.'
        );
    }

    if (workflowConfigWork && !taskMetadataAllowsWorkflowConfigWork(taskQueueMetadata)) {
        throw new Error(
            'Task-mode --workflow-config-work requires trusted TASK.md metadata to explicitly own workflow-config policy changes. ' +
            `Update the task row Area, Title, or Notes to include the exact ownership phrase '${WORKFLOW_CONFIG_TASK_OWNERSHIP_PHRASE}' before entering task mode.`
        );
    }

    if (workflowConfigPlannedFiles.length > 0 && !workflowConfigWork) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, true);
        throw new Error(
            `Planned task scope includes workflow config files: ${workflowConfigPlannedFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work --workflow-config-work before preflight so this high-risk config intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (!orchestratorWork && protectedPlannedFiles.length > 0) {
        const rerunCommand = buildOrchestratorWorkHandoffCommand(repoRoot, taskId, options, plannedChangedFiles, workflowConfigWork);
        throw new Error(
            `Planned task scope includes protected orchestrator files: ${protectedPlannedFiles.join(', ')}. ` +
            'Re-run enter-task-mode with --orchestrator-work before preflight so the intent stays explicit and auditable. ' +
            `Suggested command: ${rerunCommand}`
        );
    }

    if (orchestratorWork || workflowConfigWork) {
        requireTaskModeOperatorConfirmation(
            options,
            workflowConfigWork ? '--orchestrator-work --workflow-config-work' : '--orchestrator-work'
        );
    }

}
