import type { ReportInstructionEntry } from './types';

export function buildInstructionEntries(): ReportInstructionEntry[] {
    return [
        {
            id: 'task-execution',
            title: 'Task execution',
            body: 'Start and resume task work with `garda next-step "<task-id>" --repo-root "."`. Treat the printed command as the current router result, then return to next-step after each gate.'
        },
        {
            id: 'task-inspection',
            title: 'Task inspection',
            body: 'Use the Tasks tab for per-task details. Compact rows come from TASK.md only; loading details reads task events, blockers, reviews, and artifact links for that one task.'
        },
        {
            id: 'review-execution-modes',
            title: 'Review execution modes',
            body: '`parallel_all` launches lanes independently. `test_after_code` makes test wait for code. `code_first_optional` makes selected specialist reviews wait for code and keeps test downstream. `strict_sequential` runs required review lanes one by one.'
        },
        {
            id: 'workflow-guards',
            title: 'Workflow guards',
            body: 'Scope budget guards catch oversized tasks. Review-cycle guards catch repeated failed review loops. Project-memory maintenance checks whether durable memory needs a focused update before closeout.'
        },
        {
            id: 'workflow-configuration',
            title: 'Workflow configuration',
            body: 'The Workflow Config tab shows a human label first and the real parameter in parentheses. Saves run audited `garda workflow set` commands when the UI was started with `--actions`.'
        },
        {
            id: 'init-settings',
            title: 'Init settings',
            body: 'The Init settings tab shows current initialization answers, hard agent-init checkpoints, ordinary document controls, and the prompt handoff used to complete agent onboarding.'
        },
        {
            id: 'project-memory',
            title: 'Project memory',
            body: 'The Project memory tab shows the current maintenance mode and durable project-memory files. Open each file on demand instead of loading full contents into the dashboard.'
        },
        {
            id: 'backups',
            title: 'Backups',
            body: 'The Backups tab lists rollback snapshots from the backup inventory, shows auto-backup settings from workflow config, and exposes guarded manual-create and restore actions when the UI server runs with `--actions`.'
        },
        {
            id: 'workspace-actions',
            title: 'Workspace actions',
            body: 'Workspace actions are shown in their domain tabs: task commands in the selected task detail, backup create/restore commands in Backups, cleanup controls in Cleanup settings, and Garda switch controls in the top status strip.'
        }
    ];
}
