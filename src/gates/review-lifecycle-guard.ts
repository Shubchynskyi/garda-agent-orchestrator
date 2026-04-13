import * as fs from 'node:fs';
import * as path from 'node:path';

import { joinOrchestratorPath, normalizePath } from './helpers';
import { collectTaskTimelineEventTypes } from './task-mode';

export type ReviewLifecycleActionType = 'review_phase' | 'review_gate';

export interface ReviewLifecycleGuardResult {
    status: 'ALLOW' | 'BLOCK';
    timeline_path: string;
    blocking_event: string | null;
    violations: string[];
}

function resolveTimelinePath(repoRoot: string, taskId: string): string {
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
}

function resolveBlockingEvent(eventTypes: Set<string>): string | null {
    if (eventTypes.has('COMPLETION_GATE_PASSED')) {
        return 'COMPLETION_GATE_PASSED';
    }
    if (eventTypes.has('REVIEW_GATE_PASSED_WITH_OVERRIDE')) {
        return 'REVIEW_GATE_PASSED_WITH_OVERRIDE';
    }
    if (eventTypes.has('REVIEW_GATE_PASSED')) {
        return 'REVIEW_GATE_PASSED';
    }
    return null;
}

function buildBlockedMessage(
    timelinePath: string,
    blockingEvent: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): string {
    if (actionType === 'review_gate') {
        return (
            `Task timeline '${normalizePath(timelinePath)}' already contains ${blockingEvent}. ` +
            `Do not rerun '${actionLabel}' in place after the review stage has passed. ` +
            'Start a fresh attempt or invalidate downstream evidence before rerunning the review gate.'
        );
    }

    return (
        `Task timeline '${normalizePath(timelinePath)}' already contains ${blockingEvent}. ` +
        `Do not append late review-phase telemetry via '${actionLabel}' after the task has already advanced past review preparation. ` +
        'Start a fresh attempt or invalidate downstream evidence before rerunning review preparation.'
    );
}

export function getReviewLifecycleGuard(
    repoRoot: string,
    taskId: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): ReviewLifecycleGuardResult {
    const timelinePath = resolveTimelinePath(repoRoot, taskId);
    if (!fs.existsSync(timelinePath) || !fs.statSync(timelinePath).isFile()) {
        return {
            status: 'ALLOW',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: []
        };
    }

    const timelineErrors: string[] = [];
    const timelineEventTypes = collectTaskTimelineEventTypes(timelinePath, timelineErrors);
    if (timelineErrors.length > 0) {
        return {
            status: 'BLOCK',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: [
                `Task timeline '${normalizePath(timelinePath)}' is unreadable. Resolve timeline integrity before rerunning '${actionLabel}'.`
            ]
        };
    }

    const blockingEvent = resolveBlockingEvent(timelineEventTypes);
    if (!blockingEvent) {
        return {
            status: 'ALLOW',
            timeline_path: normalizePath(timelinePath),
            blocking_event: null,
            violations: []
        };
    }

    return {
        status: 'BLOCK',
        timeline_path: normalizePath(timelinePath),
        blocking_event: blockingEvent,
        violations: [buildBlockedMessage(timelinePath, blockingEvent, actionLabel, actionType)]
    };
}

export function assertReviewLifecycleGuard(
    repoRoot: string,
    taskId: string,
    actionLabel: string,
    actionType: ReviewLifecycleActionType
): void {
    const result = getReviewLifecycleGuard(repoRoot, taskId, actionLabel, actionType);
    if (result.status === 'BLOCK') {
        throw new Error(result.violations[0]);
    }
}
