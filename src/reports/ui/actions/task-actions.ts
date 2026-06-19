import { resolveTaskResetAvailability } from '../../../core/task-reset-availability';
import { buildUiActionDefinition } from './action-common';
import type { UiActionDefinition } from './types';

const TASK_RESET_ENABLE_CONFIRMATION_PHRASE = 'ENABLE TASK RESET';
const TASK_DISCARD_CONFIRMATION_PHRASE = 'DISCARD TASK';

export function buildUiTaskActionDefinitions(repoRoot: string, taskId: string): UiActionDefinition[] {
    const taskResetAvailability = resolveTaskResetAvailability(repoRoot);
    const nowUtc = new Date().toISOString();
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
                enabled: taskResetAvailability.enabled,
                unavailableReason: `TASK_RESET_DISABLED: ${taskResetAvailability.disabledReason || 'Task reset is not ready.'} Run the audited enable action before confirmed reset/discard.`
            }
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-reset-discard',
            'Task',
            'Discard task',
            'Terminally discard this task through the guarded task-reset gate and mark it DONE after clearing runtime artifacts.',
            ['gate', 'task-reset', '--task-id', taskId, '--discard', '--confirm', '--repo-root', repoRoot],
            {
                mutates: true,
                confirmationPhrase: TASK_DISCARD_CONFIRMATION_PHRASE,
                enabled: taskResetAvailability.enabled,
                unavailableReason: `TASK_RESET_DISABLED: ${taskResetAvailability.disabledReason || 'Task reset is not ready.'} Run the audited enable action before confirmed reset/discard.`
            }
        ),
        buildUiActionDefinition(
            repoRoot,
            'task-reset-enable-audited',
            'Task',
            'Enable audited task reset',
            taskResetAvailability.configuredEnabled
                ? 'Repair missing workflow-set audit evidence for task_reset.enabled=true.'
                : 'Enable task reset through audited workflow set before running reset or discard.',
            [
                'workflow',
                'set',
                '--task-reset-enabled',
                'true',
                '--target-root',
                repoRoot,
                '--operator-confirmed',
                'yes',
                '--operator-confirmed-at-utc',
                nowUtc
            ],
            {
                mutates: true,
                confirmationPhrase: TASK_RESET_ENABLE_CONFIRMATION_PHRASE,
                enabled: !taskResetAvailability.enabled
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
