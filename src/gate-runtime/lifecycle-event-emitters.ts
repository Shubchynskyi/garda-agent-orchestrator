import { appendTaskEvent } from './task-events';
import type { AutoEmitOptions } from './lifecycle-event-core';
import {
    emitLifecycleEvent,
    emitLifecycleEventAsync,
    emitMandatoryLifecycleEvent,
    emitMandatoryLifecycleEventAsync
} from './lifecycle-event-core';
import { LIFECYCLE_EVENT_TYPES } from './lifecycle-event-types';

export function emitPlanCreatedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PLAN_CREATED, 'INFO', 'Task plan created.', details, options, true);
}

export async function emitPlanCreatedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PLAN_CREATED, 'INFO', 'Task plan created.', details, options, true);
}

export function emitPreflightStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_STARTED, 'INFO', 'Preflight classification started.', details, options);
}

export function emitMandatoryPreflightStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_STARTED, 'INFO', 'Preflight classification started.', details, options);
}

export async function emitMandatoryPreflightStartedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_STARTED, 'INFO', 'Preflight classification started.', details, options);
}

export function emitPreflightFailedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_FAILED, 'FAIL', 'Preflight classification failed.', details, options);
}

export function emitMandatoryPreflightFailedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_FAILED, 'FAIL', 'Preflight classification failed.', details, options);
}

export async function emitMandatoryPreflightFailedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.PREFLIGHT_FAILED, 'FAIL', 'Preflight classification failed.', details, options);
}

export function emitImplementationStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.IMPLEMENTATION_STARTED, 'INFO', 'Implementation started.', details, options);
}

export function emitMandatoryImplementationStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.IMPLEMENTATION_STARTED, 'INFO', 'Implementation started.', details, options);
}

export async function emitMandatoryImplementationStartedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.IMPLEMENTATION_STARTED, 'INFO', 'Implementation started.', details, options);
}

export function emitReviewPhaseStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED, 'INFO', 'Review phase started.', details, options);
}

export async function emitReviewPhaseStartedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED, 'INFO', 'Review phase started.', details, options);
}

export function emitReviewRecordedEvent(repoRoot: string, taskId: string, reviewType: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_RECORDED, 'PASS', `Review recorded: ${reviewType}.`, details, options);
}

export async function emitReviewRecordedEventAsync(repoRoot: string, taskId: string, reviewType: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_RECORDED, 'PASS', `Review recorded: ${reviewType}.`, details, options);
}

export function emitMandatoryReviewPhaseStartedEvent(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEvent(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED, 'INFO', 'Review phase started.', details, options);
}

export async function emitMandatoryReviewPhaseStartedEventAsync(repoRoot: string, taskId: string, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEventAsync(repoRoot, taskId, LIFECYCLE_EVENT_TYPES.REVIEW_PHASE_STARTED, 'INFO', 'Review phase started.', details, options);
}

export function emitFullSuiteValidationEvent(
    repoRoot: string,
    taskId: string,
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED',
    details: unknown,
    options: AutoEmitOptions = {}
) {
    const eventType = {
        PASSED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
        FAILED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
        WARNED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
        SKIPPED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
    }[status];
    const outcome = status === 'FAILED' ? 'FAIL' : status === 'WARNED' ? 'WARN' : status === 'SKIPPED' ? 'INFO' : 'PASS';
    return emitLifecycleEvent(
        repoRoot,
        taskId,
        eventType,
        outcome,
        `Full-suite validation ${status.toLowerCase()}.`,
        details,
        options
    );
}

export async function emitMandatoryFullSuiteValidationEventAsync(
    repoRoot: string,
    taskId: string,
    status: 'PASSED' | 'FAILED' | 'WARNED' | 'SKIPPED',
    details: unknown,
    options: AutoEmitOptions = {}
) {
    const eventType = {
        PASSED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_PASSED,
        FAILED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_FAILED,
        WARNED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_WARNED,
        SKIPPED: LIFECYCLE_EVENT_TYPES.FULL_SUITE_VALIDATION_SKIPPED
    }[status];
    const outcome = status === 'FAILED' ? 'FAIL' : status === 'WARNED' ? 'WARN' : status === 'SKIPPED' ? 'INFO' : 'PASS';
    return emitMandatoryLifecycleEventAsync(
        repoRoot,
        taskId,
        eventType,
        outcome,
        `Full-suite validation ${status.toLowerCase()}.`,
        details,
        options
    );
}

export function emitCompletionGateEvent(repoRoot: string, taskId: string, passed: boolean, details: unknown, options: AutoEmitOptions = {}): ReturnType<typeof appendTaskEvent> {
    if (!repoRoot || !taskId) return null;
    try {
        return appendTaskEvent(
            repoRoot,
            taskId,
            passed ? LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_PASSED : LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_FAILED,
            passed ? 'PASS' : 'FAIL',
            passed ? 'Completion gate passed.' : 'Completion gate failed.',
            details,
            {
                actor: options.actor || 'gate',
                passThru: options.passThru ?? true,
                eventsRoot: options.eventsRoot
            }
        );
    } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        process.stderr.write(`WARNING: completion-gate event emit failed: ${msg}\n`);
        return null;
    }
}

export function emitMandatoryCompletionGateEvent(repoRoot: string, taskId: string, passed: boolean, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEvent(
        repoRoot,
        taskId,
        passed ? LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_PASSED : LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_FAILED,
        passed ? 'PASS' : 'FAIL',
        passed ? 'Completion gate passed.' : 'Completion gate failed.',
        details,
        options
    );
}

export async function emitMandatoryCompletionGateEventAsync(repoRoot: string, taskId: string, passed: boolean, details: unknown, options: AutoEmitOptions = {}) {
    return emitMandatoryLifecycleEventAsync(
        repoRoot,
        taskId,
        passed ? LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_PASSED : LIFECYCLE_EVENT_TYPES.COMPLETION_GATE_FAILED,
        passed ? 'PASS' : 'FAIL',
        passed ? 'Completion gate passed.' : 'Completion gate failed.',
        details,
        options
    );
}

export function emitStatusChangedEvent(repoRoot: string, taskId: string, previousStatus: string, newStatus: string, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.STATUS_CHANGED,
        'INFO',
        `Task status changed: ${previousStatus} → ${newStatus}.`,
        {
            previous_status: previousStatus,
            new_status: newStatus
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export function emitMandatoryStatusChangedEvent(
    repoRoot: string,
    taskId: string,
    previousStatus: string,
    newStatus: string,
    options: AutoEmitOptions = {}
) {
    return emitMandatoryLifecycleEvent(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.STATUS_CHANGED,
        'INFO',
        `Task status changed: ${previousStatus} → ${newStatus}.`,
        {
            previous_status: previousStatus,
            new_status: newStatus
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export async function emitStatusChangedEventAsync(repoRoot: string, taskId: string, previousStatus: string, newStatus: string, options: AutoEmitOptions = {}) {
    return emitLifecycleEventAsync(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.STATUS_CHANGED,
        'INFO',
        `Task status changed: ${previousStatus} → ${newStatus}.`,
        {
            previous_status: previousStatus,
            new_status: newStatus
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export async function emitMandatoryStatusChangedEventAsync(
    repoRoot: string,
    taskId: string,
    previousStatus: string,
    newStatus: string,
    options: AutoEmitOptions = {}
) {
    return emitMandatoryLifecycleEventAsync(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.STATUS_CHANGED,
        'INFO',
        `Task status changed: ${previousStatus} → ${newStatus}.`,
        {
            previous_status: previousStatus,
            new_status: newStatus
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export function emitReviewerDelegationRoutedEvent(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    executionMode: 'delegated_subagent',
    reviewerSessionId: string,
    fallbackReason: string | null = null,
    options: AutoEmitOptions = {}
) {
    return emitLifecycleEvent(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.REVIEWER_DELEGATION_ROUTED,
        'INFO',
        `Reviewer delegation: ${reviewType} → ${executionMode}.`,
        {
            review_type: reviewType,
            reviewer_execution_mode: executionMode,
            reviewer_session_id: reviewerSessionId,
            delegation_used: executionMode === 'delegated_subagent',
            reviewer_fallback_reason: fallbackReason
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export async function emitReviewerDelegationRoutedEventAsync(
    repoRoot: string,
    taskId: string,
    reviewType: string,
    executionMode: 'delegated_subagent',
    reviewerSessionId: string,
    fallbackReason: string | null = null,
    options: AutoEmitOptions = {}
) {
    return emitLifecycleEventAsync(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.REVIEWER_DELEGATION_ROUTED,
        'INFO',
        `Reviewer delegation: ${reviewType} → ${executionMode}.`,
        {
            review_type: reviewType,
            reviewer_execution_mode: executionMode,
            reviewer_session_id: reviewerSessionId,
            delegation_used: executionMode === 'delegated_subagent',
            reviewer_fallback_reason: fallbackReason
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export function emitProviderRoutingEvent(repoRoot: string, taskId: string, provider: string, routedTo: string, reason: string, options: AutoEmitOptions = {}) {
    return emitLifecycleEvent(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.PROVIDER_ROUTING_DECISION,
        'INFO',
        `Provider routing: ${provider} → ${routedTo}.`,
        {
            provider,
            routed_to: routedTo,
            reason
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}

export async function emitProviderRoutingEventAsync(repoRoot: string, taskId: string, provider: string, routedTo: string, reason: string, options: AutoEmitOptions = {}) {
    return emitLifecycleEventAsync(
        repoRoot,
        taskId,
        LIFECYCLE_EVENT_TYPES.PROVIDER_ROUTING_DECISION,
        'INFO',
        `Provider routing: ${provider} → ${routedTo}.`,
        {
            provider,
            routed_to: routedTo,
            reason
        },
        { ...options, actor: options.actor || 'orchestrator' }
    );
}
