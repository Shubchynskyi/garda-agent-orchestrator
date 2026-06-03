import * as path from 'node:path';
import {
    buildDefaultWorkflowConfig,
    getWorkflowConfigPath,
    readWorkflowConfigForMerge
} from '../../../core/workflow-config';
import { resolveBundleNameForTarget } from '../../../core/constants';
import { buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

function resolveBundleRoot(repoRoot: string): string {
    return path.join(repoRoot, resolveBundleNameForTarget(repoRoot));
}

function isTaskResetMutationEnabled(repoRoot: string): boolean {
    const defaultConfig = buildDefaultWorkflowConfig();
    const bundleRoot = resolveBundleRoot(repoRoot);
    const configPath = getWorkflowConfigPath(bundleRoot);
    const readResult = readWorkflowConfigForMerge(configPath);
    const taskReset = readResult.config?.task_reset && typeof readResult.config.task_reset === 'object'
        ? readResult.config.task_reset as Record<string, unknown>
        : defaultConfig.task_reset as unknown as Record<string, unknown>;
    return taskReset.enabled === true;
}

export function buildUiTaskActionDefinitions(repoRoot: string, taskId: string): UiActionDefinition[] {
    const taskResetEnabled = isTaskResetMutationEnabled(repoRoot);
    return [
        buildUiActionDefinition(
            repoRoot,
            'task-next-step',
            'Task',
            'Next lifecycle step',
            'Run the task router and print the next required lifecycle command.',
            ['next-step', taskId, '--repo-root', repoRoot],
            { mutates: true, confirmationPhrase: 'RUN TASK NEXT STEP' }
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-reset-reopen',
            'Task',
            'Reset task',
            'Reset this task through the guarded task-reset gate and reopen it for a fresh lifecycle run.',
            ['gate', 'task-reset', '--task-id', taskId, '--reopen', '--confirm', '--repo-root', repoRoot],
            {
                mutates: true,
                confirmationPhrase: 'RESET TASK',
                enabled: taskResetEnabled,
                unavailableReason: 'Task reset mutations are disabled. Enable workflow setting task_reset.enabled before running a confirmed reset.'
            }
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-stats',
            'Task',
            'Task stats',
            'Run the focused task stats command.',
            ['task', taskId, 'stats', '--target-root', repoRoot]
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-events',
            'Task',
            'Task events',
            'Run the focused task events command.',
            ['task', taskId, 'events', '--target-root', repoRoot]
        )
    ];
}
