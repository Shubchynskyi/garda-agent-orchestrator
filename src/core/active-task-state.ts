import * as fs from 'node:fs';
import * as path from 'node:path';

import { assertValidTaskId } from '../gate-runtime/task-events-helpers';

const ACTIVE_TASK_RUNTIME_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

function isActiveTaskStatus(statusCell: string): boolean {
    const normalized = String(statusCell || '').trim().toUpperCase();
    return normalized.includes('IN_PROGRESS')
        || normalized.includes('IN_REVIEW')
        || String(statusCell || '').includes('🟨')
        || String(statusCell || '').includes('🟧');
}

function isTerminalTaskStatus(statusCell: string): boolean {
    const normalized = String(statusCell || '').trim().toUpperCase();
    return normalized.includes('DONE')
        || normalized.includes('BLOCKED')
        || normalized.includes('DECOMPOSED')
        || String(statusCell || '').includes('🟩')
        || String(statusCell || '').includes('🟥')
        || String(statusCell || '').includes('🟪');
}

export interface RuntimeTaskState {
    activeTaskIds: Set<string>;
    ambiguousTaskIds: Set<string>;
    terminalTaskIds: Set<string>;
}

const RUNTIME_RECOVERY_EVENTS = new Set([
    'TASK_MODE_ENTERED',
    'PREFLIGHT_CLASSIFIED',
    'COMPILE_GATE_PASSED',
    'REVIEW_PHASE_STARTED'
]);

export function collectRuntimeTaskState(bundleRoot: string): RuntimeTaskState {
    const activeTaskIds = new Set<string>();
    const ambiguousTaskIds = new Set<string>();
    const terminalTaskIds = new Set<string>();
    const taskEventsDir = path.join(bundleRoot, 'runtime', 'task-events');

    try {
        for (const entry of fs.readdirSync(taskEventsDir)) {
            if (!entry.endsWith('.jsonl') || entry === 'all-tasks.jsonl') {
                continue;
            }

            const rawTaskId = entry.replace(/\.jsonl$/, '').trim();
            let taskId: string;
            try {
                taskId = assertValidTaskId(rawTaskId);
            } catch {
                continue;
            }

            const timelinePath = path.join(taskEventsDir, entry);
            let content: string;
            let timelineMtimeMs = 0;
            try {
                timelineMtimeMs = fs.statSync(timelinePath).mtimeMs;
                content = fs.readFileSync(timelinePath, 'utf8');
            } catch {
                activeTaskIds.add(taskId);
                continue;
            }

            let latestStatus: string | null = null;
            let parseFailed = false;
            let hasLifecycleEvidence = false;
            let hasCompletionGatePass = false;
            let latestEventSequence = -1;
            let latestRestartSequence = -1;
            let latestTerminalSequence = -1;
            for (const rawLine of content.split('\n')) {
                const line = rawLine.trim();
                if (!line) {
                    continue;
                }
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const eventType = String(parsed.event_type || '').trim().toUpperCase();
                    if (eventType) {
                        hasLifecycleEvidence = true;
                        latestEventSequence += 1;
                    }
                    if (RUNTIME_RECOVERY_EVENTS.has(eventType)) {
                        latestRestartSequence = latestEventSequence;
                    }
                    if (eventType === 'COMPLETION_GATE_PASSED') {
                        hasCompletionGatePass = true;
                        latestTerminalSequence = latestEventSequence;
                    }
                    if (eventType !== 'STATUS_CHANGED') {
                        continue;
                    }
                    const details = parsed.details;
                    if (!details || typeof details !== 'object' || Array.isArray(details)) {
                        continue;
                    }
                    const nextStatus = String((details as Record<string, unknown>).new_status || '').trim();
                    if (nextStatus) {
                        latestStatus = nextStatus;
                        if (isTerminalTaskStatus(nextStatus)) {
                            latestTerminalSequence = latestEventSequence;
                        }
                    }
                } catch {
                    parseFailed = true;
                    break;
                }
            }

            const withinRuntimeGrace = timelineMtimeMs > 0
                && (Date.now() - timelineMtimeMs) <= ACTIVE_TASK_RUNTIME_GRACE_MS;
            const hasFreshLifecycleRestart = withinRuntimeGrace && latestRestartSequence > latestTerminalSequence;
            if (parseFailed || isActiveTaskStatus(latestStatus || '')) {
                activeTaskIds.add(taskId);
            } else if (hasFreshLifecycleRestart) {
                activeTaskIds.add(taskId);
            } else if (isTerminalTaskStatus(latestStatus || '') || hasCompletionGatePass) {
                terminalTaskIds.add(taskId);
            } else if (hasLifecycleEvidence) {
                ambiguousTaskIds.add(taskId);
            }
        }
    } catch {
        // best-effort runtime fallback only
    }

    return {
        activeTaskIds,
        ambiguousTaskIds,
        terminalTaskIds
    };
}

export function resolveActiveTaskIds(targetRoot: string, bundleRoot: string, explicitTaskIds?: readonly string[]): Set<string> {
    const activeTaskIds = new Set<string>();
    for (const explicitTaskId of explicitTaskIds || []) {
        try {
            activeTaskIds.add(assertValidTaskId(explicitTaskId));
        } catch {
            // ignore invalid explicit values in best-effort active-task discovery
        }
    }

    const runtimeTaskState = collectRuntimeTaskState(bundleRoot);
    const mergeRuntimeTaskIds = (includeAmbiguous: boolean): void => {
        for (const taskId of runtimeTaskState.activeTaskIds) {
            activeTaskIds.add(taskId);
        }
        if (includeAmbiguous) {
            for (const taskId of runtimeTaskState.ambiguousTaskIds) {
                activeTaskIds.add(taskId);
            }
        }
    };

    mergeRuntimeTaskIds(false);

    const taskPath = path.join(targetRoot, 'TASK.md');
    if (!fs.existsSync(taskPath)) {
        mergeRuntimeTaskIds(true);
        return activeTaskIds;
    }

    let content: string;
    try {
        content = fs.readFileSync(taskPath, 'utf8');
    } catch {
        mergeRuntimeTaskIds(true);
        return activeTaskIds;
    }

    const taskMdActiveTaskIds = new Set<string>();
    for (const rawLine of content.split('\n')) {
        const trimmed = rawLine.trim();
        if (!trimmed.startsWith('|')) {
            continue;
        }
        const cells = trimmed
            .split('|')
            .slice(1, -1)
            .map((cell) => cell.trim());
        if (cells.length < 2) {
            continue;
        }

        let taskId: string;
        try {
            taskId = assertValidTaskId(cells[0]);
        } catch {
            continue;
        }

        if (isActiveTaskStatus(cells[1] || '')) {
            taskMdActiveTaskIds.add(taskId);
        }
    }

    for (const taskId of taskMdActiveTaskIds) {
        if (runtimeTaskState.terminalTaskIds.has(taskId) && !runtimeTaskState.activeTaskIds.has(taskId)) {
            continue;
        }
        activeTaskIds.add(taskId);
    }

    mergeRuntimeTaskIds(true);
    return activeTaskIds;
}
