import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathExists } from '../core/fs';
import { getBundleCliCommand, PRIMARY_CLI_NAME, resolveBundleName } from '../core/constants';
import { scanTaskEventLocks, type TaskEventLockHealth } from '../gate-runtime/task-events';

export interface TaskStatus {
    id: string;
    status: string;
    priority: string;
    area: string;
    title: string;
    owner: string;
    updated: string;
    profile: string;
    notes: string;
}

export interface BlockingReason {
    reason_code: string;
    description: string;
    remediation: string;
}

export interface WhyBlockedTask {
    task: TaskStatus;
    blocking_reasons: BlockingReason[];
    missing_events: string[];
    failed_gates: string[];
    timeline_status: string;
    related_locks: TaskEventLockHealth[];
}

export interface WhyBlockedResult {
    has_blocked_tasks: boolean;
    blocked_tasks: WhyBlockedTask[];
    in_progress_tasks: WhyBlockedTask[];
    lock_observations: TaskEventLockHealth[];
    summary_lines: string[];
}

const STATUS_TOKENS: Record<string, string> = {
    'TODO': 'TODO',
    '🟦': 'TODO',
    'IN_PROGRESS': 'IN_PROGRESS',
    '🟨': 'IN_PROGRESS',
    'IN_REVIEW': 'IN_REVIEW',
    '🟧': 'IN_REVIEW',
    'DONE': 'DONE',
    '🟩': 'DONE',
    'BLOCKED': 'BLOCKED',
    '🟥': 'BLOCKED'
};

function normalizeStatus(raw: string): string {
    const trimmed = raw.trim();
    for (const [token, normalized] of Object.entries(STATUS_TOKENS)) {
        if (trimmed.includes(token)) {
            return normalized;
        }
    }
    return trimmed.toUpperCase();
}

function parseTaskMdRow(row: string): TaskStatus | null {
    const cells = row.split('|').map(function (c) { return c.trim(); }).filter(Boolean);
    if (cells.length < 9) {
        return null;
    }

    // Skip separator rows
    if (cells[0].startsWith('-') || cells[0].startsWith('=')) {
        return null;
    }

    // Skip header rows
    if (cells[0].toLowerCase() === 'id') {
        return null;
    }

    const id = cells[0];
    if (!id || !id.match(/^T-\d+/i)) {
        return null;
    }

    return {
        id: id,
        status: normalizeStatus(cells[1] || ''),
        priority: cells[2] || '',
        area: cells[3] || '',
        title: cells[4] || '',
        owner: cells[5] || '',
        updated: cells[6] || '',
        profile: cells[7] || '',
        notes: cells[8] || ''
    };
}

function parseTaskMd(taskMdPath: string): TaskStatus[] {
    const tasks: TaskStatus[] = [];

    if (!pathExists(taskMdPath)) {
        return tasks;
    }

    let content: string;
    try {
        content = fs.readFileSync(taskMdPath, 'utf8');
    } catch {
        return tasks;
    }

    const lines = content.split('\n');
    let inTable = false;

    for (const line of lines) {
        const trimmed = line.trim();

        // Detect table start by header row
        if (trimmed.startsWith('|') && trimmed.toLowerCase().includes('| id |')) {
            inTable = true;
            continue;
        }

        // Separator row
        if (inTable && trimmed.startsWith('|') && trimmed.includes('---')) {
            continue;
        }

        if (inTable && trimmed.startsWith('|')) {
            const task = parseTaskMdRow(trimmed);
            if (task) {
                tasks.push(task);
            }
            continue;
        }

        // Table ended
        if (inTable && !trimmed.startsWith('|') && trimmed !== '') {
            inTable = false;
        }
    }

    return tasks;
}

function readTimelineEvents(timelinePath: string): string[] {
    const eventTypes: string[] = [];

    if (!pathExists(timelinePath)) {
        return eventTypes;
    }

    let content: string;
    try {
        content = fs.readFileSync(timelinePath, 'utf8');
    } catch {
        return eventTypes;
    }

    for (const line of content.split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (eventType) {
                eventTypes.push(eventType);
            }
        } catch {
            // Malformed line, skip
        }
    }

    return eventTypes;
}

const MANDATORY_EVENTS_CODE_CHANGE = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'PREFLIGHT_CLASSIFIED',
    'IMPLEMENTATION_STARTED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

const MANDATORY_EVENTS_NO_CODE = Object.freeze([
    'TASK_MODE_ENTERED',
    'RULE_PACK_LOADED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED',
    'REVIEW_GATE_PASSED',
    'COMPLETION_GATE_PASSED'
]);

function hasEvent(events: string[], eventType: string): boolean {
    if (eventType === 'REVIEW_GATE_PASSED') {
        return events.includes('REVIEW_GATE_PASSED') || events.includes('REVIEW_GATE_PASSED_WITH_OVERRIDE');
    }
    return events.includes(eventType);
}

function getFailedGates(events: string[]): string[] {
    const failKeys = ['COMPILE_GATE_FAILED', 'REVIEW_GATE_FAILED', 'COMPLETION_GATE_FAILED',
        'PREFLIGHT_FAILED', 'RULE_PACK_LOAD_FAILED', 'DOC_IMPACT_ASSESSMENT_FAILED'];
    return failKeys.filter(function (k) { return events.includes(k); });
}

function detectBlockingReasons(
    task: TaskStatus,
    events: string[],
    missingEvents: string[],
    failedGates: string[],
    relatedLocks: TaskEventLockHealth[]
): BlockingReason[] {
    const reasons: BlockingReason[] = [];

    // Parse blocked_reason_code from Notes column
    const notesText = task.notes || '';
    const blockedMatch = notesText.match(/blocked_reason_code\s*[=:]\s*([A-Z_0-9]+)/i);
    if (blockedMatch) {
        reasons.push({
            reason_code: blockedMatch[1].toUpperCase(),
            description: `Explicit blocked reason code recorded in TASK.md: ${blockedMatch[1]}`,
            remediation: `Resolve the '${blockedMatch[1]}' condition and update the task status to resume.`
        });
    }

    // Task mode not entered
    if (!events.includes('TASK_MODE_ENTERED')) {
        reasons.push({
            reason_code: 'TASK_MODE_NOT_ENTERED',
            description: 'enter-task-mode gate was never run for this task.',
            remediation: `Run: ${getBundleCliCommand()} gate enter-task-mode --task-id "${task.id}" ...`
        });
    }

    // Rule pack evidence missing
    if (events.includes('TASK_MODE_ENTERED') && !events.includes('RULE_PACK_LOADED')) {
        reasons.push({
            reason_code: 'RULE_PACK_NOT_LOADED',
            description: 'load-rule-pack gate was not run after entering task mode.',
            remediation: `Run: ${getBundleCliCommand()} gate load-rule-pack --task-id "${task.id}" --stage "TASK_ENTRY" --loaded-rule-file "<rule-file>"`
        });
    }

    // Compile failed
    if (failedGates.includes('COMPILE_GATE_FAILED')) {
        reasons.push({
            reason_code: 'COMPILE_GATE_FAILED',
            description: 'Build failed during compile gate.',
            remediation: 'Fix compile errors, run npm run build, then rerun compile-gate.'
        });
    }

    // Review gate failed
    if (failedGates.includes('REVIEW_GATE_FAILED')) {
        reasons.push({
            reason_code: 'REVIEW_GATE_FAILED',
            description: 'Required review(s) returned FAILED verdict.',
            remediation: 'Check runtime/reviews/' + task.id + '-*.md for findings. Fix blocking issues and rerun reviews.'
        });
    }

    // Completion failed
    if (failedGates.includes('COMPLETION_GATE_FAILED')) {
        reasons.push({
            reason_code: 'COMPLETION_GATE_FAILED',
            description: 'Completion gate failed — lifecycle evidence or review artifacts incomplete.',
            remediation: `Run: ${getBundleCliCommand()} gate completion-gate --task-id "${task.id}" and resolve each listed failure.`
        });
    }

    // Missing events
    if (missingEvents.length > 0) {
        reasons.push({
            reason_code: 'TIMELINE_INCOMPLETE',
            description: `Task timeline is missing ${missingEvents.length} mandatory event(s): ${missingEvents.join(', ')}.`,
            remediation: 'Re-run the appropriate gate commands to emit the missing events.'
        });
    }

    for (const lock of relatedLocks) {
        const ownerPidText = lock.owner_pid === null ? 'unknown' : String(lock.owner_pid);
        const ownerHostText = lock.owner_hostname || 'unknown';
        if (lock.status === 'STALE') {
            reasons.push({
                reason_code: 'STALE_TASK_EVENT_LOCK',
                description: `Task-event lock '${lock.lock_name}' is stale (${lock.stale_reason || 'unknown reason'}) and can block timeline writes for this task.`,
                remediation: `Run '${PRIMARY_CLI_NAME} doctor --target-root "." --cleanup-stale-locks --dry-run' first, then rerun without '--dry-run' if the candidate list is correct. runtime/reviews/ is not part of the lock subsystem.`
            });
            continue;
        }
        reasons.push({
            reason_code: 'ACTIVE_TASK_EVENT_LOCK',
            description: `Task-event lock '${lock.lock_name}' is currently held by PID ${ownerPidText} on ${ownerHostText}; gate writes may block until it is released.`,
            remediation: `Wait for the owning process to finish or terminate PID ${ownerPidText} safely if it is hung. Do not delete live locks manually. runtime/reviews/ is not part of the lock subsystem.`
        });
    }

    return reasons;
}

function analyseTask(task: TaskStatus, bundlePath: string, lockObservations: TaskEventLockHealth[]): WhyBlockedTask {
    const timelinePath = path.join(bundlePath, 'runtime', 'task-events', task.id + '.jsonl');
    const events = readTimelineEvents(timelinePath);

    const hasTimeline = pathExists(timelinePath);
    let timelineStatus = 'MISSING';
    if (hasTimeline) {
        timelineStatus = events.length > 0 ? 'PRESENT' : 'EMPTY';
    }

    const failedGates = getFailedGates(events);

    // Detect code-change from preflight artifact
    let codeChanged = false;
    const preflightPath = path.join(bundlePath, 'runtime', 'reviews', task.id + '-preflight.json');
    if (pathExists(preflightPath)) {
        try {
            const parsed = JSON.parse(fs.readFileSync(preflightPath, 'utf8')) as Record<string, unknown>;
            const metrics = parsed.metrics as Record<string, unknown> | null;
            if (metrics && typeof metrics.changed_lines_total === 'number' && metrics.changed_lines_total > 0) {
                codeChanged = true;
            } else if (Array.isArray(parsed.changed_files) && parsed.changed_files.length > 0) {
                codeChanged = true;
            }
        } catch {
            // Ignore
        }
    }

    const mandatory = codeChanged ? MANDATORY_EVENTS_CODE_CHANGE : MANDATORY_EVENTS_NO_CODE;
    const missingEvents = mandatory.filter(function (ev) { return !hasEvent(events, ev); });
    const relatedLocks = lockObservations.filter(function (lock) {
        return lock.scope === 'aggregate' || lock.task_id === task.id;
    });

    const blockingReasons = detectBlockingReasons(task, events, missingEvents, failedGates, relatedLocks);

    return {
        task,
        blocking_reasons: blockingReasons,
        missing_events: missingEvents,
        failed_gates: failedGates,
        timeline_status: timelineStatus,
        related_locks: relatedLocks
    };
}

export function getWhyBlocked(targetRoot: string): WhyBlockedResult {
    const resolvedRoot = path.resolve(targetRoot);
    const bundlePath = path.join(resolvedRoot, resolveBundleName());
    const taskMdPath = path.join(resolvedRoot, 'TASK.md');

    const allTasks = parseTaskMd(taskMdPath);
    const lockObservations = pathExists(bundlePath)
        ? scanTaskEventLocks(bundlePath).locks
        : [];
    const blocked: WhyBlockedTask[] = [];
    const inProgress: WhyBlockedTask[] = [];

    for (const task of allTasks) {
        if (task.status === 'BLOCKED') {
            blocked.push(analyseTask(task, bundlePath, lockObservations));
        } else if (task.status === 'IN_PROGRESS' || task.status === 'IN_REVIEW') {
            const analysed = analyseTask(task, bundlePath, lockObservations);
            if (analysed.blocking_reasons.length > 0 || analysed.missing_events.length > 0 || analysed.failed_gates.length > 0) {
                inProgress.push(analysed);
            }
        }
    }

    const summaryLines: string[] = [];
    if (blocked.length === 0 && inProgress.length === 0) {
        summaryLines.push('No blocked or stalled tasks found.');
        if (lockObservations.length > 0) {
            summaryLines.push(`Task-event locks observed: ${lockObservations.length} (runtime/reviews/ is not part of the lock subsystem).`);
        }
        if (allTasks.filter(function (t) { return t.status === 'TODO' || t.status === 'IN_PROGRESS'; }).length === 0) {
            summaryLines.push('All tasks are DONE or queue is empty.');
        }
    } else {
        if (blocked.length > 0) {
            summaryLines.push(`Blocked tasks: ${blocked.length}`);
        }
        if (inProgress.length > 0) {
            summaryLines.push(`In-progress tasks with gate issues: ${inProgress.length}`);
        }
        if (lockObservations.length > 0) {
            summaryLines.push(`Task-event locks observed: ${lockObservations.length} (runtime/reviews/ is not part of the lock subsystem).`);
        }
        summaryLines.push(`Run: ${PRIMARY_CLI_NAME} doctor explain <FAILURE_ID> for remediation steps.`);
    }

    return {
        has_blocked_tasks: blocked.length > 0 || inProgress.length > 0,
        blocked_tasks: blocked,
        in_progress_tasks: inProgress,
        lock_observations: lockObservations,
        summary_lines: summaryLines
    };
}

export function formatWhyBlockedResult(result: WhyBlockedResult): string {
    const lines: string[] = [];
    lines.push('WhyBlocked');
    lines.push('');

    if (result.lock_observations.length > 0) {
        lines.push('Task-Event Locks');
        for (const lock of result.lock_observations) {
            const ageText = lock.age_ms === null ? 'unknown' : `${lock.age_ms}ms`;
            lines.push(
                `  ${lock.lock_name}: ${lock.status} scope=${lock.scope}` +
                (lock.task_id ? ` task=${lock.task_id}` : '') +
                ` age=${ageText} owner_pid=${lock.owner_pid === null ? 'unknown' : lock.owner_pid}`
            );
            lines.push(`    Fix: ${lock.remediation}`);
        }
        lines.push('');
    }

    if (!result.has_blocked_tasks) {
        for (const line of result.summary_lines) {
            lines.push(line);
        }
        return lines.join('\n');
    }

    function formatAnalysed(analysed: WhyBlockedTask, sectionLabel: string): void {
        const task = analysed.task;
        lines.push(`${sectionLabel}: ${task.id} — ${task.title}`);
        lines.push(`  Status: ${task.status}  |  Priority: ${task.priority}  |  Owner: ${task.owner}`);
        lines.push(`  Timeline: ${analysed.timeline_status}`);

        if (analysed.failed_gates.length > 0) {
            lines.push(`  Failed gates: ${analysed.failed_gates.join(', ')}`);
        }

        if (analysed.related_locks.length > 0) {
            lines.push(`  Related locks: ${analysed.related_locks.map((lock) => `${lock.lock_name}:${lock.status}`).join(', ')}`);
        }

        if (analysed.missing_events.length > 0) {
            lines.push(`  Missing timeline events: ${analysed.missing_events.join(', ')}`);
        }

        if (analysed.blocking_reasons.length > 0) {
            lines.push('  Blocking reasons:');
            for (const reason of analysed.blocking_reasons) {
                lines.push(`    [${reason.reason_code}] ${reason.description}`);
                lines.push(`      Fix: ${reason.remediation}`);
            }
        } else {
            lines.push('  No specific blocking reason detected — check timeline and review artifacts manually.');
        }

        lines.push('');
    }

    for (const analysed of result.blocked_tasks) {
        formatAnalysed(analysed, 'BLOCKED');
    }

    for (const analysed of result.in_progress_tasks) {
        formatAnalysed(analysed, 'STALLED');
    }

    for (const line of result.summary_lines) {
        lines.push(line);
    }

    return lines.join('\n');
}
