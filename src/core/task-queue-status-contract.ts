export const GATE_OWNED_TASK_QUEUE_STATUSES = Object.freeze([
    'IN_PROGRESS',
    'IN_REVIEW',
    'DONE'
] as const);

export const AGENT_BLOCKED_TASK_QUEUE_STATUSES = Object.freeze([
    'IN_PROGRESS',
    'IN_REVIEW',
    'DONE',
    'BLOCKED'
] as const);

export type GateDecisionStatus = 'pass' | 'block' | 'advisory';

export type TaskQueueStatusUpdateAuthority =
    | 'gate_owned_status_sync'
    | 'operator_task_reset'
    | 'agent_non_status_backlog_edit';

export interface TaskQueueStatusContract {
    schema_version: 1;
    decision: GateDecisionStatus;
    authority: TaskQueueStatusUpdateAuthority;
    gate_owned_statuses: readonly string[];
    agent_blocked_statuses: readonly string[];
    agent_may_edit_non_status_task_content: boolean;
    operator_reset_command: string;
    reason: string;
    visible_summary_line: string;
}

export function buildTaskQueueStatusContract(taskId: string | null = null): TaskQueueStatusContract {
    const taskIdValue = taskId && taskId.trim() ? taskId.trim() : '<task-id>';
    return {
        schema_version: 1,
        decision: 'block',
        authority: 'gate_owned_status_sync',
        gate_owned_statuses: GATE_OWNED_TASK_QUEUE_STATUSES,
        agent_blocked_statuses: AGENT_BLOCKED_TASK_QUEUE_STATUSES,
        agent_may_edit_non_status_task_content: true,
        operator_reset_command: `gate task-reset --task-id "${taskIdValue}" --reopen --dry-run --repo-root "."`,
        reason:
            'Agents may add or edit backlog task content and non-status notes, but active lifecycle status changes are owned by gate flows. ' +
            'Use completion, review, task-mode, or explicit operator task-reset/discard commands instead of manually editing TASK.md status cells.',
        visible_summary_line:
            'Task status sync: gate-owned for IN_PROGRESS/IN_REVIEW/DONE; explicit operator task-reset/discard only for reset or discard; agents may edit non-status backlog content.'
    };
}
