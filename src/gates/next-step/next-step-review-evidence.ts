import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getReviewExecutionDependencies,
    type EffectiveReviewExecutionPolicyMode
} from '../../core/review-execution-policy';
import {
    buildGateChainLaunchDecision,
    formatGateChainLaunchDecision
} from '../../core/dependent-validation-chains';
import {
    validateStrictReusedReviewEvidence,
    type ReviewReuseTelemetryEventLike
} from '../review-reuse/review-reuse-telemetry';
import {
    evaluateHiddenReviewTimingTrust
} from '../review/review-timing-trust';
import {
    fileSha256,
    normalizePath
} from '../shared/helpers';
import {
    getCurrentReviewerLaunchArtifactEvidenceForInvocation
} from './next-step-reviewer-launch-evidence';
import {
    toRepoDisplayPath
} from './next-step-command-formatters';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function getLatestTaskSequenceForEventTypes(eventsRoot: string, taskId: string, eventTypes: string[]): number | null {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return null;
    }
    const wanted = new Set(eventTypes);
    let latestSequence: number | null = null;
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (!wanted.has(String(event.event_type || '').trim())) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const sequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            if (Number.isInteger(sequence) && sequence > 0) {
                latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return latestSequence;
}

function readTaskTimelineEventLikes(eventsRoot: string, taskId: string): ReviewReuseTelemetryEventLike[] {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return [];
    }
    const events: ReviewReuseTelemetryEventLike[] = [];
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            events.push(JSON.parse(line) as ReviewReuseTelemetryEventLike);
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return events;
}

function timelineHasDelegatedReviewInvocationAttestation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (state.reusedExistingReview) {
        return false;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return false;
    }
    const reviewerLaunchArtifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
        repoRoot,
        eventsRoot,
        taskId,
        state
    );
    if (reviewerLaunchArtifactEvidence.state !== 'launched' || !reviewerLaunchArtifactEvidence.sha256) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null || state.reviewerProvenance.task_sequence <= latestCompileSequence) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const reviewTreeStateSha256 = String(details.review_tree_state_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            const launchArtifactSha256 = String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== String(state.reviewerProvenance.review_context_sha256 || '').trim().toLowerCase()
                || reviewTreeStateSha256 !== expectedReviewTreeStateSha256
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
                || launchArtifactSha256 !== reviewerLaunchArtifactEvidence.sha256
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

function timelineHasHistoricalDelegatedReviewInvocationAttestation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (state.reusedExistingReview) {
        return false;
    }
    if (!state.reviewerIdentity || !state.reviewerProvenance?.task_sequence || !state.reviewerProvenance.event_sha256) {
        return false;
    }
    if (
        state.reviewerProvenance.attestation_type !== 'reviewer_invocation_attestation'
        || state.reviewerProvenance.controller_event_type !== 'REVIEWER_INVOCATION_ATTESTED'
    ) {
        return false;
    }
    const expectedReviewContextSha256 = state.receiptReviewContextSha256;
    const expectedReviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (
        !expectedReviewContextSha256
        || !expectedReviewTreeStateSha256
        || state.receiptReviewTreeStateSha256 !== expectedReviewTreeStateSha256
        || state.reviewerProvenance.review_context_sha256 !== expectedReviewContextSha256
        || state.reviewerProvenance.review_tree_state_sha256 !== expectedReviewTreeStateSha256
    ) {
        return false;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
                continue;
            }
            const details = isPlainRecord(event.details) ? event.details : {};
            if (String(details.task_id || '').trim() !== taskId) {
                continue;
            }
            if (String(details.review_type || '').trim() !== state.reviewType) {
                continue;
            }
            if (String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent') {
                continue;
            }
            const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
            if (eventReviewerIdentity !== state.reviewerIdentity) {
                continue;
            }
            const reviewContextSha256 = String(details.review_context_sha256 || '').trim().toLowerCase();
            const reviewTreeStateSha256 = String(details.review_tree_state_sha256 || '').trim().toLowerCase();
            const routingEventSha256 = String(details.routing_event_sha256 || '').trim().toLowerCase();
            if (
                reviewContextSha256 !== expectedReviewContextSha256
                || reviewTreeStateSha256 !== expectedReviewTreeStateSha256
                || routingEventSha256 !== String(state.reviewerProvenance.routing_event_sha256 || '').trim().toLowerCase()
            ) {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const taskSequence = typeof integrity?.task_sequence === 'number'
                ? integrity.task_sequence
                : Number(integrity?.task_sequence);
            const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const prevEventSha256 = integrity?.prev_event_sha256 == null
                ? null
                : String(integrity.prev_event_sha256 || '').trim().toLowerCase() || null;
            if (
                taskSequence !== state.reviewerProvenance.task_sequence
                || eventSha256 !== state.reviewerProvenance.event_sha256
                || prevEventSha256 !== state.reviewerProvenance.prev_event_sha256
            ) {
                continue;
            }
            return true;
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

export function timelineHasReviewReuseRecordedAfterCompile(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (
        !state.reusedExistingReview
        || !state.receiptExists
        || !state.contextExists
        || (!state.contextCurrent && !state.domainScopeCurrent)
        || !state.artifactExists
    ) {
        return false;
    }
    const reviewContextSha256 = fileSha256(state.contextPath);
    const reviewArtifactSha256 = fileSha256(state.artifactPath);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (!reviewContextSha256 || !reviewArtifactSha256 || latestCompileSequence == null) {
        return false;
    }
    const repoRoot = path.resolve(eventsRoot, '..', '..', '..');
    const validation = validateStrictReusedReviewEvidence({
        repoRoot,
        taskId,
        reviewType: state.reviewType,
        events: readTaskTimelineEventLikes(eventsRoot, taskId),
        receiptPath: state.receiptPath,
        reviewContextSha256,
        reviewContextReuseSha256: state.receiptReviewContextReuseSha256,
        reviewTreeStateSha256: state.receiptReviewTreeStateSha256,
        reviewScopeSha256: state.receiptReviewScopeSha256,
        codeScopeSha256: state.receiptCodeScopeSha256,
        reviewArtifactSha256,
        reusedFromReceiptPath: state.reusedFromReceiptPath,
        reusedFromReceiptSha256: state.reusedFromReceiptSha256,
        reusedFromReviewContextSha256: state.reusedFromReviewContextSha256,
        reusedFromReviewContextReuseSha256: state.reusedFromReviewContextReuseSha256,
        reusedFromReviewTreeStateSha256: state.reusedFromReviewTreeStateSha256,
        reusedFromReviewScopeSha256: state.reusedFromReviewScopeSha256,
        reusedFromCodeScopeSha256: state.reusedFromCodeScopeSha256,
        reviewerExecutionMode: state.reviewerProvenance?.reviewer_execution_mode || null,
        reviewerIdentity: state.reviewerIdentity,
        reviewerProvenance: state.reviewerProvenance as unknown as Record<string, unknown> | null,
        latestCompileTaskSequence: latestCompileSequence
    });
    return validation.valid;
}

export function buildReviewGateChainStatusSummary(options: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    reviewType: string;
    edgeId: string;
    status?: 'pass' | 'block';
    reason: string;
    preflightPath: string;
    reviewContextPath?: string;
    depth?: number | string;
}): string {
    const timelinePath = path.join(options.eventsRoot, `${options.taskId}.jsonl`);
    const decision = buildGateChainLaunchDecision({
        edgeId: options.edgeId,
        status: options.status || 'pass',
        reason: options.reason,
        context: {
            taskId: options.taskId,
            reviewType: options.reviewType,
            preflightPath: options.preflightPath,
            reviewContextPath: options.reviewContextPath,
            depth: options.depth,
            repoRoot: '.'
        },
        evidencePaths: [
            toRepoDisplayPath(options.repoRoot, timelinePath)
        ]
    });
    return (
        `${formatGateChainLaunchDecision(decision)} ` +
        'LaneScope=review_type; independent review lanes remain eligible when their own prerequisites are current.'
    );
}

export function timelineHasReviewContextPreparedAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    contextPath: string
): boolean {
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return false;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    if (latestCompileSequence == null) {
        return false;
    }
    const expectedContextPath = normalizePath(contextPath).toLowerCase();
    for (const line of fs.readFileSync(timelinePath, 'utf8').split('\n')) {
        if (!line.trim()) {
            continue;
        }
        try {
            const event = JSON.parse(line) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEW_PHASE_STARTED') {
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
            const eventReviewType = String(details.review_type || details.reviewType || '').trim();
            const outputPath = normalizePath(details.output_path || details.outputPath || '').toLowerCase();
            if (eventReviewType === reviewType && outputPath === expectedContextPath) {
                return true;
            }
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    return false;
}

export function reviewStateHasSatisfiedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.ready) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.domainScopeCurrent && !state.reusedExistingReview) {
        return timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot, taskId, state);
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

export function getHiddenReviewTimingTrustRemediation(
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): string | null {
    const timelineEvents = readTaskTimelineEventLikes(eventsRoot, taskId);
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(eventsRoot, taskId, ['COMPILE_GATE_PASSED']);
    const timingTrust = evaluateHiddenReviewTimingTrust({
        reviewType: state.reviewType,
        reusedExistingReview: state.reusedExistingReview,
        reviewerProvenance: state.reviewerProvenance,
        reviewResultRecordedAtUtc: state.reviewResultRecordedAtUtc,
        recordedAtUtc: state.recordedAtUtc,
        reviewOutputSourceMtimeUtc: state.reviewOutputSourceMtimeUtc,
        timelineEvents,
        latestCompileSequence
    });
    return timingTrust.trusted ? null : timingTrust.message;
}

function isReviewFailTokenViolation(state: ReviewArtifactState, violation: string): boolean {
    return Boolean(
        state.failed
        && state.failToken
        && violation.includes(`review artifact contains fail token '${state.failToken}'`)
    );
}

export function reviewStateHasCurrentRecordedEvidence(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    if (!state.contextExists || !state.artifactExists || !state.receiptExists) {
        return false;
    }
    const nonVerdictViolations = state.violations.filter(
        (violation) => !isReviewFailTokenViolation(state, violation)
    );
    if (nonVerdictViolations.length > 0) {
        return false;
    }
    if (getHiddenReviewTimingTrustRemediation(eventsRoot, taskId, state)) {
        return false;
    }
    if (state.domainScopeCurrent && !state.reusedExistingReview && !state.failed) {
        return timelineHasHistoricalDelegatedReviewInvocationAttestation(eventsRoot, taskId, state);
    }
    if (state.reusedExistingReview) {
        return timelineHasReviewReuseRecordedAfterCompile(eventsRoot, taskId, state);
    }
    return timelineHasDelegatedReviewInvocationAttestation(repoRoot, eventsRoot, taskId, state);
}

function getTimelineEventTaskSequence(event: ReviewReuseTelemetryEventLike): number | null {
    const integrity = event.integrity && typeof event.integrity === 'object' && !Array.isArray(event.integrity)
        ? event.integrity as Record<string, unknown>
        : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function getLatestReviewEventSequence(
    events: readonly ReviewReuseTelemetryEventLike[],
    eventType: string,
    reviewType: string
): number | null {
    const normalizedEventType = eventType.trim().toUpperCase();
    const normalizedReviewType = reviewType.trim().toLowerCase();
    let latestSequence: number | null = null;
    for (const event of events) {
        if (String(event.event_type || '').trim().toUpperCase() !== normalizedEventType) {
            continue;
        }
        const details = event.details && typeof event.details === 'object' && !Array.isArray(event.details)
            ? event.details as Record<string, unknown>
            : null;
        const currentReviewType = String(details?.review_type ?? details?.reviewType ?? '').trim().toLowerCase();
        if (currentReviewType !== normalizedReviewType) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence != null) {
            latestSequence = latestSequence == null ? sequence : Math.max(latestSequence, sequence);
        }
    }
    return latestSequence;
}

export function findStrictSequentialUpstreamNeedingCurrentCycleReuse(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    targetReviewType: string;
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
    latestCompileSequence?: number | null;
}): { upstreamState: ReviewArtifactState; upstreamReviewType: string; latestCompileSequence: number } | null {
    if (params.policyMode !== 'strict_sequential') {
        return null;
    }
    const latestCompileSequence = params.latestCompileSequence ?? getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null) {
        return null;
    }
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    const upstreamReviewTypes = getReviewExecutionDependencies(
        params.targetReviewType,
        params.requiredReviews,
        params.policyMode
    );
    for (const upstreamReviewType of upstreamReviewTypes) {
        const upstreamState = stateByReviewType.get(upstreamReviewType);
        if (
            !upstreamState?.ready
            || !upstreamState.domainScopeCurrent
            || upstreamState.failed
        ) {
            continue;
        }
        if (
            upstreamState.reusedExistingReview
            && timelineHasReviewReuseRecordedAfterCompile(params.eventsRoot, params.taskId, upstreamState)
        ) {
            continue;
        }
        const upstreamRecordedSequence = getLatestReviewEventSequence(
            timelineEvents,
            'REVIEW_RECORDED',
            upstreamReviewType
        );
        if (
            !upstreamState.reusedExistingReview
            && upstreamRecordedSequence != null
            && upstreamRecordedSequence > latestCompileSequence
        ) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && upstreamState.contextCurrent) {
            continue;
        }
        if (!upstreamState.reusedExistingReview && !reviewStateHasSatisfiedEvidence(
            params.repoRoot,
            params.eventsRoot,
            params.taskId,
            upstreamState
        )) {
            continue;
        }
        return {
            upstreamState,
            upstreamReviewType,
            latestCompileSequence
        };
    }
    return null;
}

export function findReviewGateStaleUpstreamRecovery(params: {
    repoRoot: string;
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamReviewType: string; upstreamState: ReviewArtifactState; upstreamReviewType: string; latestReviewGateFailureSequence: number } | null {
    const latestReviewGateFailureSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_FAILED']
    );
    if (latestReviewGateFailureSequence == null) {
        return null;
    }
    const latestReviewGatePassSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['REVIEW_GATE_PASSED', 'REVIEW_GATE_PASSED_WITH_OVERRIDE']
    );
    if (latestReviewGatePassSequence != null && latestReviewGatePassSequence > latestReviewGateFailureSequence) {
        return null;
    }
    const latestCompileSequence = getLatestTaskSequenceForEventTypes(
        params.eventsRoot,
        params.taskId,
        ['COMPILE_GATE_PASSED']
    );
    if (latestCompileSequence == null || latestReviewGateFailureSequence <= latestCompileSequence) {
        return null;
    }
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const downstreamReviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(downstreamReviewType);
        if (!downstreamState || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, downstreamState)) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            downstreamReviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamState = stateByReviewType.get(upstreamReviewType);
            if (
                !upstreamState
                || !upstreamState.ready
                || !upstreamState.domainScopeCurrent
                || upstreamState.reusedExistingReview
                || !reviewStateHasSatisfiedEvidence(params.repoRoot, params.eventsRoot, params.taskId, upstreamState)
            ) {
                continue;
            }
            return {
                downstreamReviewType,
                upstreamState,
                upstreamReviewType,
                latestReviewGateFailureSequence
            };
        }
    }
    return null;
}

export function findDownstreamReviewNeedingDependencyRebind(params: {
    eventsRoot: string;
    taskId: string;
    requiredReviewTypes: string[];
    requiredReviews: Record<string, boolean>;
    policyMode: EffectiveReviewExecutionPolicyMode;
    reviewStates: readonly ReviewArtifactState[];
}): { downstreamState: ReviewArtifactState; upstreamReviewType: string } | null {
    const timelineEvents = readTaskTimelineEventLikes(params.eventsRoot, params.taskId);
    if (timelineEvents.length === 0) {
        return null;
    }
    const stateByReviewType = new Map(params.reviewStates.map((state) => [state.reviewType, state]));
    for (const reviewType of params.requiredReviewTypes) {
        const downstreamState = stateByReviewType.get(reviewType);
        if (!downstreamState?.ready || !downstreamState.contextExists) {
            continue;
        }
        const downstreamRebindSequence = getLatestDownstreamReviewRebindSequence(timelineEvents, downstreamState);
        if (downstreamRebindSequence == null) {
            continue;
        }
        const upstreamReviewTypes = getReviewExecutionDependencies(
            reviewType,
            params.requiredReviews,
            params.policyMode
        );
        for (const upstreamReviewType of upstreamReviewTypes) {
            const upstreamRecordedSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_RECORDED', upstreamReviewType);
            if (upstreamRecordedSequence != null && upstreamRecordedSequence > downstreamRebindSequence) {
                return { downstreamState, upstreamReviewType };
            }
        }
    }
    return null;
}

function getLatestDownstreamReviewRebindSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const reviewPhaseSequence = getLatestReviewEventSequence(timelineEvents, 'REVIEW_PHASE_STARTED', state.reviewType);
    const reuseAcceptedSequence = getLatestReviewContextReuseAcceptedSequence(timelineEvents, state);
    if (reviewPhaseSequence == null) {
        return reuseAcceptedSequence;
    }
    if (reuseAcceptedSequence == null) {
        return reviewPhaseSequence;
    }
    return Math.max(reviewPhaseSequence, reuseAcceptedSequence);
}

function getLatestReviewContextReuseAcceptedSequence(
    timelineEvents: readonly ReviewReuseTelemetryEventLike[],
    state: ReviewArtifactState
): number | null {
    const expectedContextPath = normalizePath(state.contextPath).toLowerCase();
    let latestSequence: number | null = null;
    for (const event of timelineEvents) {
        if (event.event_type !== 'REVIEW_CONTEXT_REUSE_ACCEPTED') {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewType = String(details.review_type || details.reviewType || '').trim();
        if (eventReviewType !== state.reviewType || details.current_pass_review_evidence !== true) {
            continue;
        }
        const outputPath = normalizePath(
            details.output_path || details.outputPath || details.review_context_path || details.reviewContextPath || ''
        ).toLowerCase();
        if (!outputPath || outputPath !== expectedContextPath) {
            continue;
        }
        const sequence = getTimelineEventTaskSequence(event);
        if (sequence == null) {
            continue;
        }
        latestSequence = latestSequence == null
            ? sequence
            : Math.max(latestSequence, sequence);
    }
    return latestSequence;
}
