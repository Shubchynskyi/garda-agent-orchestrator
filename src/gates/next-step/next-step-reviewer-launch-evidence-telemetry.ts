import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    buildPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../gate-runtime/review/reviewer-identity-contract';
import {
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    resolveReviewScratchRoot
} from '../review/review-scratch-paths';
import {
    REVIEWER_PROVIDER_FAILURE_EVENT_TYPES,
    fileExists,
    getArtifactStringField,
    getEventTaskSequence,
    getLatestTaskSequenceForEventTypes,
    isPlainRecord
} from './next-step-reviewer-launch-evidence-shared';

export interface MatchingReviewerDelegationStartedTelemetry {
    taskSequence: number | null;
}

export function findMatchingReviewerDelegationStartedTelemetry(options: {
    lines: string[];
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    preparedLaunchEventSha256: string;
    reviewerLaunchAttemptId?: string;
    providerInvocationId: string;
    delegationStartedAtUtc: string;
}): MatchingReviewerDelegationStartedTelemetry | null {
    const normalizedReviewContextSha256 = options.reviewContextSha256.toLowerCase();
    const normalizedRoutingEventSha256 = options.routingEventSha256.toLowerCase();
    for (let index = options.lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(options.lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_STARTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const detailsProviderInvocationId = getArtifactStringField(
                details,
                'provider_invocation_id',
                'providerInvocationId',
                'controller_invocation_id',
                'controllerInvocationId'
            );
            if (
                String(details.task_id || details.taskId || '').trim() === options.taskId
                && String(details.review_type || details.reviewType || '').trim() === options.reviewType
                && String(details.reviewer_execution_mode || details.reviewerExecutionMode || '').trim() === 'delegated_subagent'
                && reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: options.reviewerIdentity,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    plannedReviewerIdentity: options.plannedReviewerIdentity
                })
                && String(details.review_context_sha256 || details.reviewContextSha256 || '').trim().toLowerCase() === normalizedReviewContextSha256
                && String(details.routing_event_sha256 || details.routingEventSha256 || '').trim().toLowerCase() === normalizedRoutingEventSha256
                && (!options.reviewerLaunchAttemptId || getArtifactStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId') === options.reviewerLaunchAttemptId)
                && detailsProviderInvocationId === options.providerInvocationId
                && String(details.delegation_started_at_utc || details.delegationStartedAtUtc || '').trim() === options.delegationStartedAtUtc
            ) {
                return {
                    taskSequence: getEventTaskSequence(event)
                };
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return null;
}

export function hasMatchingReviewerDelegationStartedTelemetry(
    options: Parameters<typeof findMatchingReviewerDelegationStartedTelemetry>[0]
): boolean {
    return findMatchingReviewerDelegationStartedTelemetry(options) != null;
}

export function hasControllerResumeAfterSequence(lines: string[], sequence: number | null): boolean {
    if (sequence == null) {
        return false;
    }
    const resumeEventTypes = new Set([
        'CONTROLLER_SESSION_RESUMED',
        'TASK_MODE_ENTERED',
        'HANDSHAKE_DIAGNOSTICS_RECORDED',
        'SHELL_SMOKE_PREFLIGHT_RECORDED'
    ]);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (!resumeEventTypes.has(String(event.event_type || '').trim())) {
                continue;
            }
            const taskSequence = getEventTaskSequence(event);
            if (taskSequence != null && taskSequence > sequence) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

export function hasMatchingReviewerProviderFailureTelemetry(options: {
    lines: string[];
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    providerInvocationId: string;
    delegationStartedAtUtc: string;
    delegationStartedSequence: number | null;
    reviewerLaunchAttemptId?: string;
}): boolean {
    if (options.delegationStartedSequence == null) {
        return false;
    }
    const normalizedReviewContextSha256 = options.reviewContextSha256.toLowerCase();
    const normalizedRoutingEventSha256 = options.routingEventSha256.toLowerCase();
    for (let index = options.lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(options.lines[index]) as Record<string, unknown>;
            const eventType = String(event.event_type || '').trim();
            if (!REVIEWER_PROVIDER_FAILURE_EVENT_TYPES.has(eventType)) {
                continue;
            }
            const taskSequence = getEventTaskSequence(event);
            if (taskSequence == null || taskSequence <= options.delegationStartedSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const detailsProviderInvocationId = getArtifactStringField(
                details,
                'provider_invocation_id',
                'providerInvocationId',
                'controller_invocation_id',
                'controllerInvocationId'
            );
            const outcome = String(event.outcome || details.outcome || '').trim().toUpperCase();
            const failureReason = getArtifactStringField(
                details,
                'provider_failure_reason',
                'providerFailureReason',
                'failure_reason',
                'failureReason',
                'error',
                'error_message',
                'errorMessage'
            );
            if (
                String(details.task_id || details.taskId || '').trim() === options.taskId
                && String(details.review_type || details.reviewType || '').trim() === options.reviewType
                && String(details.reviewer_execution_mode || details.reviewerExecutionMode || '').trim() === 'delegated_subagent'
                && reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: options.reviewerIdentity,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    plannedReviewerIdentity: options.plannedReviewerIdentity
                })
                && String(details.review_context_sha256 || details.reviewContextSha256 || '').trim().toLowerCase() === normalizedReviewContextSha256
                && String(details.routing_event_sha256 || details.routingEventSha256 || '').trim().toLowerCase() === normalizedRoutingEventSha256
                && (!options.reviewerLaunchAttemptId || getArtifactStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId') === options.reviewerLaunchAttemptId)
                && detailsProviderInvocationId === options.providerInvocationId
                && String(details.delegation_started_at_utc || details.delegationStartedAtUtc || '').trim() === options.delegationStartedAtUtc
                && (outcome === 'FAIL' || outcome === 'ERROR' || Boolean(failureReason))
            ) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

export function hasMatchingReviewerLaunchCompletedTelemetry(options: {
    lines: string[];
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchArtifactSha256: string;
    providerInvocationId: string;
    delegationStartedAtUtc: string;
    launchCompletedAtUtc: string;
    reviewerLaunchAttemptId?: string;
}): boolean {
    const normalizedReviewContextSha256 = options.reviewContextSha256.toLowerCase();
    const normalizedRoutingEventSha256 = options.routingEventSha256.toLowerCase();
    const normalizedLaunchArtifactSha256 = options.launchArtifactSha256.toLowerCase();
    for (let index = options.lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(options.lines[index]) as Record<string, unknown>;
            const eventType = String(event.event_type || '').trim();
            if (eventType !== 'REVIEWER_LAUNCH_COMPLETED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            const detailsProviderInvocationId = getArtifactStringField(
                details,
                'provider_invocation_id',
                'providerInvocationId',
                'controller_invocation_id',
                'controllerInvocationId'
            );
            if (
                String(details.task_id || details.taskId || '').trim() === options.taskId
                && String(details.review_type || details.reviewType || '').trim() === options.reviewType
                && String(details.reviewer_execution_mode || details.reviewerExecutionMode || '').trim() === 'delegated_subagent'
                && reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: options.reviewerIdentity,
                    taskId: options.taskId,
                    reviewType: options.reviewType,
                    plannedReviewerIdentity: options.plannedReviewerIdentity
                })
                && String(details.review_context_sha256 || details.reviewContextSha256 || '').trim().toLowerCase() === normalizedReviewContextSha256
                && String(details.routing_event_sha256 || details.routingEventSha256 || '').trim().toLowerCase() === normalizedRoutingEventSha256
                && (!options.reviewerLaunchAttemptId || getArtifactStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId') === options.reviewerLaunchAttemptId)
                && String(details.reviewer_launch_artifact_sha256 || details.reviewerLaunchArtifactSha256 || '').trim().toLowerCase() === normalizedLaunchArtifactSha256
                && detailsProviderInvocationId === options.providerInvocationId
                && String(details.delegation_started_at_utc || details.delegationStartedAtUtc || '').trim() === options.delegationStartedAtUtc
                && String(details.launch_completed_at_utc || details.launchCompletedAtUtc || '').trim() === options.launchCompletedAtUtc
            ) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

export function resolveReviewerLaunchArtifactPathFromTelemetry(repoRoot: string, rawPath: unknown): string | null {
    const pathValue = String(rawPath || '').trim();
    if (!pathValue) {
        return null;
    }
    try {
        const resolvedPath = resolvePathInsideRepo(pathValue, repoRoot, { allowMissing: true });
        if (!resolvedPath) {
            return null;
        }
        const reviewScratchRoot = normalizePath(path.resolve(resolveReviewScratchRoot(repoRoot))).toLowerCase();
        const normalizedPath = normalizePath(path.resolve(resolvedPath)).toLowerCase();
        return normalizedPath === reviewScratchRoot || normalizedPath.startsWith(`${reviewScratchRoot}/`)
            ? resolvedPath
            : null;
    } catch {
        return null;
    }
}

function lookupDelegatedReviewRoutingShaAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string,
    latestCompileSequence: number
): string | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (
                String(details.review_type || '').trim() === reviewType
                && String(details.reviewer_execution_mode || '').trim() === 'delegated_subagent'
                && String(details.reviewer_session_id || '').trim() === reviewerIdentity
            ) {
                const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
                return /^[0-9a-f]{64}$/.test(eventSha256) ? eventSha256 : null;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return null;
}

export function getDelegatedReviewRoutingShaAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): string | null {
    if (!reviewerIdentity.startsWith('agent:')) {
        return null;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return null;
    }
    const directMatch = lookupDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        reviewType,
        reviewerIdentity,
        latestCompileSequence
    );
    if (directMatch) {
        return directMatch;
    }
    if (isResolvedReviewerIdentity(reviewerIdentity)) {
        return lookupDelegatedReviewRoutingShaAfterCompile(
            eventsRoot,
            taskId,
            reviewType,
            buildPlannedReviewerIdentity(taskId, reviewType),
            latestCompileSequence
        );
    }
    return null;
}

export function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    return getDelegatedReviewRoutingShaAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity) != null;
}
