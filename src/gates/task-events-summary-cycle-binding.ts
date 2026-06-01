import * as path from 'node:path';
import { assertValidTaskId } from '../gate-runtime/task-events';
import { joinOrchestratorPath, toPosix } from './helpers';
import { formatTimestamp, parseTimestamp } from './task-events-summary-parsing';
import { resolveArtifactPathForRead, safeReadJson } from './task-events-summary-artifacts';

export interface TaskCycleBindingSnapshot {
    preflight_path: string | null;
    preflight_sha256: string | null;
    compile_gate_timestamp: string | null;
    scope_binding?: TaskCycleScopeBinding | null;
}

export interface TaskCycleScopeBinding {
    changed_files_sha256: string | null;
    scope_sha256: string | null;
    scope_content_sha256: string | null;
}

export function normalizeCycleBindingPath(pathValue: unknown, repoRoot: string | null): string | null {
    const resolvedPath = resolveArtifactPathForRead(pathValue, repoRoot);
    if (resolvedPath) {
        return toPosix(resolvedPath);
    }
    if (typeof pathValue !== 'string') {
        return null;
    }
    const trimmed = pathValue.trim();
    return trimmed ? toPosix(trimmed) : null;
}

export function getCycleBindingSnapshotFromPayload(
    payload: Record<string, unknown> | null | undefined,
    repoRoot: string | null
): TaskCycleBindingSnapshot | null {
    if (!payload || typeof payload !== 'object') {
        return null;
    }
    const cycleBinding = payload.cycle_binding as Record<string, unknown> | null | undefined;
    if (!cycleBinding || typeof cycleBinding !== 'object') {
        return null;
    }
    const preflightSha = typeof cycleBinding.preflight_sha256 === 'string'
        ? cycleBinding.preflight_sha256
        : null;
    const compileGateTimestamp = typeof cycleBinding.compile_gate_timestamp === 'string'
        ? cycleBinding.compile_gate_timestamp
        : null;
    const preflightPath = normalizeCycleBindingPath(cycleBinding.preflight_path, repoRoot);
    if (!preflightSha && !compileGateTimestamp && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: compileGateTimestamp,
        scope_binding: normalizeTaskCycleScopeBinding(cycleBinding)
    };
}

export function normalizeTaskCycleScopeBinding(record: Record<string, unknown> | null | undefined): TaskCycleScopeBinding | null {
    if (!record || typeof record !== 'object') {
        return null;
    }
    const nested = record.scope_binding && typeof record.scope_binding === 'object' && !Array.isArray(record.scope_binding)
        ? record.scope_binding as Record<string, unknown>
        : record;
    const changedFilesSha256 = normalizeSha256Like(
        nested.changed_files_sha256
            ?? nested.preflight_changed_files_sha256
            ?? nested.scope_changed_files_sha256
    );
    const scopeSha256 = normalizeSha256Like(nested.scope_sha256 ?? nested.preflight_scope_sha256);
    const scopeContentSha256 = normalizeSha256Like(nested.scope_content_sha256 ?? nested.preflight_scope_content_sha256);
    if (!changedFilesSha256 && !scopeSha256 && !scopeContentSha256) {
        return null;
    }
    return {
        changed_files_sha256: changedFilesSha256,
        scope_sha256: scopeSha256,
        scope_content_sha256: scopeContentSha256
    };
}

function normalizeSha256Like(value: unknown): string | null {
    const text = String(value || '').trim().toLowerCase();
    return /^[0-9a-f]{64}$/.test(text) ? text : null;
}

export function taskCycleScopeBindingsMatch(
    currentCycle: TaskCycleBindingSnapshot | null,
    candidateCycle: TaskCycleBindingSnapshot | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp || !candidateCycle?.compile_gate_timestamp) {
        return false;
    }
    const current = currentCycle?.scope_binding;
    const candidate = candidateCycle?.scope_binding;
    if (!current || !candidate) {
        return false;
    }
    return !!current.changed_files_sha256
        && current.changed_files_sha256 === candidate.changed_files_sha256
        && !!current.scope_sha256
        && current.scope_sha256 === candidate.scope_sha256
        && !!current.scope_content_sha256
        && current.scope_content_sha256 === candidate.scope_content_sha256;
}

export function buildTaskCycleBindingKey(snapshot: TaskCycleBindingSnapshot | null): string | null {
    if (!snapshot || !snapshot.compile_gate_timestamp) {
        return null;
    }
    const cycleIdentity = snapshot.preflight_sha256 || snapshot.preflight_path;
    if (!cycleIdentity) {
        return null;
    }
    return `${snapshot.compile_gate_timestamp}:${cycleIdentity}`;
}

export function readTaskCycleBindingSnapshot(
    taskId: string,
    repoRoot: string | null,
    reviewsRootOverride?: string | null
): TaskCycleBindingSnapshot | null {
    const effectiveReviewsRoot = reviewsRootOverride
        ? path.resolve(String(reviewsRootOverride))
        : repoRoot
            ? joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'))
            : null;
    if (!effectiveReviewsRoot) {
        return null;
    }
    const safeTaskId = assertValidTaskId(taskId);
    const compileGateArtifact = safeReadJson(path.join(effectiveReviewsRoot, `${safeTaskId}-compile-gate.json`));
    if (!compileGateArtifact) {
        return null;
    }
    const preflightSha = typeof compileGateArtifact.preflight_hash_sha256 === 'string'
        ? compileGateArtifact.preflight_hash_sha256
        : null;
    const compileGateTimestamp = typeof compileGateArtifact.timestamp_utc === 'string'
        ? compileGateArtifact.timestamp_utc
        : null;
    const preflightPath = normalizeCycleBindingPath(compileGateArtifact.preflight_path, repoRoot);
    if (!preflightSha && !compileGateTimestamp && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: compileGateTimestamp,
        scope_binding: normalizeTaskCycleScopeBinding(compileGateArtifact)
    };
}

function getCompileGateSnapshotFromEvent(
    event: Record<string, unknown>,
    repoRoot: string | null
): TaskCycleBindingSnapshot | null {
    const timestamp = formatTimestamp(event.timestamp_utc);
    const details = event.details && typeof event.details === 'object'
        ? event.details as Record<string, unknown>
        : null;
    const preflightSha = details && typeof details.preflight_hash_sha256 === 'string'
        ? details.preflight_hash_sha256
        : null;
    const preflightPath = normalizeCycleBindingPath(details?.preflight_path, repoRoot);
    if (!timestamp && !preflightSha && !preflightPath) {
        return null;
    }
    return {
        preflight_path: preflightPath,
        preflight_sha256: preflightSha,
        compile_gate_timestamp: timestamp,
        scope_binding: normalizeTaskCycleScopeBinding(details)
    };
}

export function resolveTaskCycleBindingSnapshot(
    taskId: string,
    events: ReadonlyArray<Record<string, unknown>>,
    repoRoot: string | null,
    reviewsRootOverride?: string | null
): TaskCycleBindingSnapshot | null {
    const artifactSnapshot = readTaskCycleBindingSnapshot(taskId, repoRoot, reviewsRootOverride);
    let latestCompileSnapshot: TaskCycleBindingSnapshot | null = null;

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        if (eventType !== 'COMPILE_GATE_PASSED' && eventType !== 'COMPILE_GATE_FAILED') {
            continue;
        }
        latestCompileSnapshot = getCompileGateSnapshotFromEvent(event, repoRoot);
        break;
    }

    if (!latestCompileSnapshot?.compile_gate_timestamp) {
        return artifactSnapshot;
    }
    if (!artifactSnapshot) {
        return latestCompileSnapshot.preflight_path || latestCompileSnapshot.preflight_sha256
            ? latestCompileSnapshot
            : null;
    }
    const artifactTime = parseTimestamp(artifactSnapshot.compile_gate_timestamp).getTime();
    const latestEventTime = parseTimestamp(latestCompileSnapshot.compile_gate_timestamp).getTime();
    if (latestCompileSnapshot.preflight_path || latestCompileSnapshot.preflight_sha256) {
        return latestCompileSnapshot;
    }
    if (latestEventTime > artifactTime) {
        return latestCompileSnapshot;
    }

    return {
        preflight_path: artifactSnapshot.preflight_path,
        preflight_sha256: artifactSnapshot.preflight_sha256,
        compile_gate_timestamp: latestCompileSnapshot.compile_gate_timestamp,
        scope_binding: artifactSnapshot.scope_binding ?? latestCompileSnapshot.scope_binding ?? null
    };
}

export function shouldIncludeFullSuiteTelemetryForCurrentCycle(
    eventType: string,
    eventTimestamp: unknown,
    payload: Record<string, unknown> | null | undefined,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string | null
): boolean {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (!normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        return true;
    }
    if (!currentCycle || !currentCycle.compile_gate_timestamp) {
        return true;
    }

    const candidateCycle = getCycleBindingSnapshotFromPayload(payload, repoRoot);
    const sameScopeEvidence = taskCycleScopeBindingsMatch(currentCycle, candidateCycle);

    if (
        currentCycle.preflight_path
        && candidateCycle?.preflight_path
        && candidateCycle.preflight_path !== currentCycle.preflight_path
    ) {
        return false;
    }

    const eventDate = parseTimestamp(eventTimestamp);
    const compileGateDate = parseTimestamp(currentCycle.compile_gate_timestamp);
    if (
        eventDate.getTime() > 0
        && compileGateDate.getTime() > 0
        && eventDate.getTime() < compileGateDate.getTime()
        && !sameScopeEvidence
    ) {
        return false;
    }

    if (!candidateCycle) {
        return true;
    }
    if (
        currentCycle.preflight_sha256
        && candidateCycle.preflight_sha256
        && candidateCycle.preflight_sha256 !== currentCycle.preflight_sha256
        && !sameScopeEvidence
    ) {
        return false;
    }
    if (
        candidateCycle.compile_gate_timestamp
        && candidateCycle.compile_gate_timestamp !== currentCycle.compile_gate_timestamp
        && !sameScopeEvidence
    ) {
        return false;
    }
    return true;
}

export function shouldIncludeTelemetryForCurrentCycle(
    eventType: string,
    eventTimestamp: unknown,
    payload: Record<string, unknown> | null | undefined,
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string | null
): boolean {
    if (!currentCycle?.compile_gate_timestamp) {
        return true;
    }

    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    if (normalizedEventType.startsWith('FULL_SUITE_VALIDATION_')) {
        return shouldIncludeFullSuiteTelemetryForCurrentCycle(
            eventType,
            eventTimestamp,
            payload,
            currentCycle,
            repoRoot
        );
    }

    const eventDate = parseTimestamp(eventTimestamp);
    const compileGateDate = parseTimestamp(currentCycle.compile_gate_timestamp);
    if (
        eventDate.getTime() > 0
        && compileGateDate.getTime() > 0
        && eventDate.getTime() < compileGateDate.getTime()
    ) {
        return false;
    }

    return true;
}

export function getCurrentCycleReviewContextPaths(
    events: Record<string, unknown>[],
    currentCycle: TaskCycleBindingSnapshot | null,
    repoRoot: string
): Map<string, string> {
    const reviewContextPaths = new Map<string, string>();

    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        const eventType = String(event.event_type || '').trim().toUpperCase();
        const details = event.details && typeof event.details === 'object'
            ? event.details as Record<string, unknown>
            : null;
        if (
            !details
            || !shouldIncludeTelemetryForCurrentCycle(
                eventType,
                event.timestamp_utc,
                details,
                currentCycle,
                repoRoot
            )
        ) {
            continue;
        }

        const reviewType = String(
            details.review_type
            || details.reviewType
            || ''
        ).trim().toLowerCase();
        if (!reviewType || reviewContextPaths.has(reviewType)) {
            continue;
        }

        let candidatePath = '';
        if (eventType === 'REVIEW_RECORDED') {
            candidatePath = String(details.review_context_path || details.reviewContextPath || '').trim();
        } else if (eventType === 'REVIEW_PHASE_STARTED') {
            candidatePath = String(details.output_path || details.review_context_path || details.reviewContextPath || '').trim();
        } else {
            continue;
        }
        if (!candidatePath) {
            continue;
        }

        const resolvedPath = resolveArtifactPathForRead(candidatePath, repoRoot);
        if (!resolvedPath) {
            continue;
        }
        reviewContextPaths.set(reviewType, resolvedPath);
    }

    return reviewContextPaths;
}
