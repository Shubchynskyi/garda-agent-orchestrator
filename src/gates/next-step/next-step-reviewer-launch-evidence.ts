import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getProviderEntryById,
    normalizeProviderId
} from '../../core/provider-registry';
import {
    fileSha256
} from '../shared/helpers';
import {
    resolveDefaultReviewScratchPath
} from '../review/review-scratch-paths';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    buildPlannedReviewerIdentity,
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../gate-runtime/review/reviewer-identity-contract';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';
import {
    COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE,
    PROVIDER_FAILED_ATTESTATION_STATES,
    fileExists,
    getArtifactStringField,
    getLatestTaskSequenceForEventTypes,
    isPlainRecord
} from './next-step-reviewer-launch-evidence-shared';
import {
    hasCompletedReviewerLaunchEvidence,
    hasDelegationStartedEvidence
} from './next-step-reviewer-launch-evidence-validation';
import {
    findMatchingReviewerDelegationStartedTelemetry,
    getDelegatedReviewRoutingShaAfterCompile,
    hasControllerResumeAfterSequence,
    hasMatchingReviewerDelegationStartedTelemetry,
    hasMatchingReviewerLaunchCompletedTelemetry,
    hasMatchingReviewerProviderFailureTelemetry,
    resolveReviewerLaunchArtifactPathFromTelemetry,
    timelineHasDelegatedReviewRoutingAfterCompile
} from './next-step-reviewer-launch-evidence-telemetry';

export {
    getDelegatedReviewRoutingShaAfterCompile,
    timelineHasDelegatedReviewRoutingAfterCompile
} from './next-step-reviewer-launch-evidence-telemetry';

export interface CurrentReviewerLaunchArtifactEvidence {
    state: DelegatedReviewLaunchArtifactState;
    path: string | null;
    sha256: string | null;
    launchInputArtifactPath: string | null;
    launchInputArtifactSha256: string | null;
    reviewOutputPath: string | null;
    reviewerIdentity: string | null;
    reviewContextSha256: string | null;
    orphanedReason: string | null;
}

function getReviewContextSha256CandidatesForInvocationMatching(
    state: ReviewArtifactState,
    contextPath: string
): string[] {
    const candidates: string[] = [];
    const currentSha256 = fileSha256(contextPath);
    if (currentSha256) {
        candidates.push(currentSha256);
    }
    const receiptReviewContextSha256 = String(state.receiptReviewContextSha256 || '').trim().toLowerCase();
    for (const candidate of [
        receiptReviewContextSha256 === currentSha256 ? receiptReviewContextSha256 : ''
    ]) {
        if (/^[0-9a-f]{64}$/.test(candidate) && !candidates.includes(candidate)) {
            candidates.push(candidate);
        }
    }
    return candidates;
}

export function getCurrentReviewerLaunchArtifactEvidenceForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): CurrentReviewerLaunchArtifactEvidence {
    const missing: CurrentReviewerLaunchArtifactEvidence = {
        state: 'missing_or_invalid',
        path: null,
        sha256: null,
        launchInputArtifactPath: null,
        launchInputArtifactSha256: null,
        reviewOutputPath: null,
        reviewerIdentity: null,
        reviewContextSha256: null,
        orphanedReason: null
    };
    const contextReviewerIdentity = String(state.contextReviewerIdentity || '').trim();
    const reviewerIdentity = contextReviewerIdentity || buildPlannedReviewerIdentity(taskId, state.reviewType);
    if (!reviewerIdentity.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return missing;
    }
    const plannedReviewerIdentity = buildPlannedReviewerIdentity(taskId, state.reviewType);
    const reviewContextSha256Candidates = getReviewContextSha256CandidatesForInvocationMatching(
        state,
        state.contextPath
    );
    const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (reviewContextSha256Candidates.length === 0 || !routingEventSha256) {
        return missing;
    }
    const timelinePath = path.join(eventsRoot, `${taskId}.jsonl`);
    if (!fileExists(timelinePath)) {
        return missing;
    }
    const lines = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    for (const reviewContextSha256 of reviewContextSha256Candidates) {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        try {
            const event = JSON.parse(lines[index]) as Record<string, unknown>;
            if (String(event.event_type || '').trim() !== 'REVIEWER_LAUNCH_PREPARED') {
                continue;
            }
            const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
            const details = isPlainRecord(event.details) ? event.details : {};
            const preparedLaunchEventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
            const launchArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                details.reviewer_launch_artifact_path
            ) || resolveDefaultReviewScratchPath(repoRoot, taskId, state.reviewType, 'reviewer-launch.json');
            const launchArtifact = safeReadJson(launchArtifactPath);
            if (!launchArtifact) {
                continue;
            }
            const artifactPlannedReviewerIdentity = getArtifactStringField(
                launchArtifact,
                'planned_reviewer_identity',
                'plannedReviewerIdentity'
            );
            const artifactReviewerIdentity = getArtifactStringField(
                launchArtifact,
                'reviewer_identity',
                'reviewerIdentity',
                'reviewer_session_id',
                'reviewerSessionId'
            );
            const artifactReviewContextSha256 = getArtifactStringField(
                launchArtifact,
                'review_context_sha256',
                'reviewContextSha256'
            ).toLowerCase();
            const preparedEventReviewContextSha256 = String(
                details.review_context_sha256 || details.reviewContextSha256 || ''
            ).trim().toLowerCase();
            const currentContextShaMatches = artifactReviewContextSha256 === reviewContextSha256
                && preparedEventReviewContextSha256 === reviewContextSha256;
            const matchedReviewContextSha256 = currentContextShaMatches
                ? artifactReviewContextSha256
                : '';
            const launchBindingSha256 = getArtifactStringField(
                launchArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ).toLowerCase();
            const reviewerLaunchAttemptId = getArtifactStringField(
                launchArtifact,
                'reviewer_launch_attempt_id',
                'reviewerLaunchAttemptId'
            );
            if (
                !/^[0-9a-f]{64}$/.test(preparedLaunchEventSha256)
                || !/^[0-9a-f]{64}$/.test(launchBindingSha256)
                || getArtifactStringField(launchArtifact, 'prepared_launch_event_sha256', 'preparedLaunchEventSha256').toLowerCase() !== preparedLaunchEventSha256
                || getArtifactStringField(launchArtifact, 'task_id', 'taskId') !== taskId
                || getArtifactStringField(launchArtifact, 'review_type', 'reviewType') !== state.reviewType
                || getArtifactStringField(launchArtifact, 'reviewer_execution_mode', 'reviewerExecutionMode') !== 'delegated_subagent'
                || !reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: artifactReviewerIdentity,
                    expectedIdentity: reviewerIdentity,
                    taskId,
                    reviewType: state.reviewType,
                    plannedReviewerIdentity,
                    artifactPlannedReviewerIdentity,
                    artifactResolvedReviewerIdentity: artifactReviewerIdentity
                })
                || !matchedReviewContextSha256
                || getArtifactStringField(launchArtifact, 'routing_event_sha256', 'routingEventSha256').toLowerCase() !== routingEventSha256
                || String(details.review_type || '').trim() !== state.reviewType
                || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
                || !reviewerIdentityMatchesDelegatedLaunchCycle({
                    observedIdentity: String(details.reviewer_session_id || details.reviewer_identity || '').trim(),
                    expectedIdentity: reviewerIdentity,
                    taskId,
                    reviewType: state.reviewType,
                    plannedReviewerIdentity
                })
                || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
                || String(details.launch_binding_sha256 || '').trim().toLowerCase() !== launchBindingSha256
                || (
                    reviewerLaunchAttemptId
                    && getArtifactStringField(details, 'reviewer_launch_attempt_id', 'reviewerLaunchAttemptId')
                        !== reviewerLaunchAttemptId
                )
            ) {
                continue;
            }
            const evidenceType = getArtifactStringField(launchArtifact, 'evidence_type', 'artifact_type');
            const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
            const artifactDeclaresProviderFailure = evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && PROVIDER_FAILED_ATTESTATION_STATES.has(attestationState)
                && hasDelegationStartedEvidence(launchArtifact);
            const launchArtifactSha256 = fileSha256(launchArtifactPath);
            let artifactState: DelegatedReviewLaunchArtifactState = 'missing_or_invalid';
            if (evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE && attestationState === 'prepared') {
                artifactState = 'prepared';
            } else if (
                evidenceType === PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'delegation_started'
                && hasDelegationStartedEvidence(launchArtifact)
            ) {
                artifactState = 'delegation_started';
            } else if (artifactDeclaresProviderFailure) {
                artifactState = 'delegation_started';
            } else if (
                evidenceType === COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE
                && attestationState === 'launched'
                && hasCompletedReviewerLaunchEvidence(launchArtifact)
                && launchArtifactSha256
                && hasMatchingReviewerDelegationStartedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchBindingSha256,
                    preparedLaunchEventSha256,
                    reviewerLaunchAttemptId,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'delegation_started_at_utc',
                        'delegationStartedAtUtc'
                    )
                })
                && hasMatchingReviewerLaunchCompletedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchArtifactSha256,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'delegation_started_at_utc',
                        'delegationStartedAtUtc'
                    ),
                    launchCompletedAtUtc: getArtifactStringField(
                        launchArtifact,
                        'launch_completed_at_utc',
                        'launchCompletedAtUtc'
                    ),
                    reviewerLaunchAttemptId
                })
            ) {
                artifactState = 'launched';
            }
            if (artifactState === 'missing_or_invalid') {
                continue;
            }
            const reviewOutputPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                repoRoot,
                getArtifactStringField(launchArtifact, 'review_output_path', 'reviewOutputPath')
            );
            let orphanedReason: string | null = null;
            const delegationStartedAtUtc = getArtifactStringField(
                launchArtifact,
                'delegation_started_at_utc',
                'delegationStartedAtUtc'
            );
            const matchingDelegationStarted = artifactState === 'delegation_started'
                ? findMatchingReviewerDelegationStartedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchBindingSha256,
                    preparedLaunchEventSha256,
                    reviewerLaunchAttemptId,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc
                })
                : null;
            const hasMatchingProviderFailure = artifactState === 'delegation_started'
                && hasMatchingReviewerProviderFailureTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc,
                    delegationStartedSequence: matchingDelegationStarted?.taskSequence ?? null,
                    reviewerLaunchAttemptId
                });
            if (
                artifactState === 'delegation_started'
                && hasMatchingProviderFailure
            ) {
                artifactState = 'provider_failed';
            } else if (artifactDeclaresProviderFailure) {
                continue;
            }
            if (artifactState === 'delegation_started' && reviewOutputPath && !fileExists(reviewOutputPath)) {
                if (hasControllerResumeAfterSequence(lines, matchingDelegationStarted?.taskSequence ?? null)) {
                    artifactState = 'orphaned';
                    orphanedReason = 'controller_resume_after_delegation_start_with_missing_review_output';
                }
            }
            if (artifactState === 'provider_failed') {
                const hasStartedTelemetry = matchingDelegationStarted != null;
                if (!hasStartedTelemetry) {
                    continue;
                }
            }
            let launchInputArtifactPath: string | null = null;
            let launchInputArtifactSha256: string | null = null;
            if (
                artifactState === 'prepared'
                || artifactState === 'delegation_started'
                || artifactState === 'provider_failed'
                || artifactState === 'orphaned'
            ) {
                launchInputArtifactPath = resolveReviewerLaunchArtifactPathFromTelemetry(
                    repoRoot,
                    getArtifactStringField(
                        launchArtifact,
                        'reviewer_launch_input_artifact_path',
                        'reviewerLaunchInputArtifactPath'
                    )
                );
                if (!launchInputArtifactPath || !fileExists(launchInputArtifactPath)) {
                    continue;
                }
                const pinnedInputArtifactSha256 = getArtifactStringField(
                    launchArtifact,
                    'reviewer_launch_input_artifact_sha256',
                    'reviewerLaunchInputArtifactSha256'
                ).toLowerCase();
                launchInputArtifactSha256 = fileSha256(launchInputArtifactPath);
                if (
                    !launchInputArtifactSha256
                    || !/^[0-9a-f]{64}$/.test(pinnedInputArtifactSha256)
                    || launchInputArtifactSha256 !== pinnedInputArtifactSha256
                ) {
                    continue;
                }
            }
            return {
                state: artifactState,
                path: launchArtifactPath,
                sha256: launchArtifactSha256 || null,
                launchInputArtifactPath,
                launchInputArtifactSha256,
                reviewOutputPath,
                reviewerIdentity: artifactReviewerIdentity || null,
                reviewContextSha256: matchedReviewContextSha256 || null,
                orphanedReason
            };
        } catch {
            // Ignore malformed lines; timeline integrity is reported by task-audit-summary.
        }
    }
    }
    return missing;
}

function getCurrentReviewerLaunchArtifactStateForInvocation(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): DelegatedReviewLaunchArtifactState {
    return getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot, taskId, state).state;
}

export function timelineHasDelegatedReviewInvocationForCurrentContext(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    state: ReviewArtifactState
): boolean {
    const reviewerIdentity = state.contextReviewerIdentity;
    if (!reviewerIdentity?.startsWith('agent:') || !state.contextExists || !state.contextCurrent) {
        return false;
    }
    const plannedReviewerIdentity = buildPlannedReviewerIdentity(taskId, state.reviewType);
    const reviewContextSha256Candidates = getReviewContextSha256CandidatesForInvocationMatching(
        state,
        state.contextPath
    );
    const reviewTreeStateSha256 = state.contextReviewTreeStateSha256;
    if (reviewContextSha256Candidates.length === 0 || !reviewTreeStateSha256) {
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
    if (latestCompileSequence == null) {
        return false;
    }
    const routingEventSha256 = getDelegatedReviewRoutingShaAfterCompile(
        eventsRoot,
        taskId,
        state.reviewType,
        reviewerIdentity
    );
    if (!routingEventSha256) {
        return false;
    }
    const events = fs.readFileSync(timelinePath, 'utf8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .flatMap((line) => {
            try {
                return [JSON.parse(line) as Record<string, unknown>];
            } catch {
                return [];
            }
        });
    let routingSequence: number | null = null;
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_DELEGATION_ROUTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const eventSha256 = String(integrity?.event_sha256 || '').trim().toLowerCase();
        if (eventSha256 !== routingEventSha256) {
            continue;
        }
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= latestCompileSequence) {
            continue;
        }
        routingSequence = taskSequence;
        break;
    }
    if (!routingSequence) {
        return false;
    }
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (String(event.event_type || '').trim() !== 'REVIEWER_INVOCATION_ATTESTED') {
            continue;
        }
        const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
        const taskSequence = typeof integrity?.task_sequence === 'number'
            ? integrity.task_sequence
            : Number(integrity?.task_sequence);
        if (!Number.isInteger(taskSequence) || taskSequence <= routingSequence) {
            continue;
        }
        const details = isPlainRecord(event.details) ? event.details : {};
        const eventReviewerIdentity = String(details.reviewer_identity || details.reviewer_session_id || '').trim();
        if (
            String(details.task_id || '').trim() !== taskId
            || String(details.review_type || '').trim() !== state.reviewType
            || String(details.reviewer_execution_mode || '').trim() !== 'delegated_subagent'
            || !reviewerIdentityMatchesDelegatedLaunchCycle({
                observedIdentity: eventReviewerIdentity,
                expectedIdentity: reviewerIdentity,
                taskId,
                reviewType: state.reviewType,
                plannedReviewerIdentity,
                artifactResolvedReviewerIdentity: reviewerLaunchArtifactEvidence.reviewerIdentity
            })
            || !reviewContextSha256Candidates.includes(
                String(details.review_context_sha256 || '').trim().toLowerCase()
            ) && String(details.review_context_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.reviewContextSha256
            || String(details.review_tree_state_sha256 || '').trim().toLowerCase() !== reviewTreeStateSha256
            || String(details.routing_event_sha256 || '').trim().toLowerCase() !== routingEventSha256
            || String(details.reviewer_launch_artifact_sha256 || '').trim().toLowerCase() !== reviewerLaunchArtifactEvidence.sha256
        ) {
            continue;
        }
        return true;
    }
    return false;
}

export function buildReviewerReadinessChainSummary(
    repoRoot: string,
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    state: ReviewArtifactState | undefined,
    reviewStateHasSatisfiedEvidence: (state: ReviewArtifactState) => boolean
): string {
    const contextStatus = !state || !state.contextExists
        ? 'missing'
        : state.contextCurrent
            ? 'current'
            : 'stale';
    const reviewerIdentity = state?.contextReviewerIdentity || '';
    const routingCurrent = Boolean(
        state
        && contextStatus === 'current'
        && reviewerIdentity.startsWith('agent:')
        && timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity)
    );
    const routingStatus = routingCurrent
        ? 'current'
        : contextStatus !== 'current'
            ? 'blocked until current context'
            : reviewerIdentity
                ? 'missing current-cycle telemetry'
                : 'missing reviewer identity';
    const launchArtifactState = routingCurrent && state
        ? getCurrentReviewerLaunchArtifactStateForInvocation(repoRoot, eventsRoot, taskId, state)
        : 'missing_or_invalid';
    const launchStatus = !routingCurrent
        ? 'blocked until routing'
        : launchArtifactState === 'prepared'
            ? 'prepared'
        : launchArtifactState === 'delegation_started'
            ? 'delegation started'
            : launchArtifactState === 'provider_failed'
                ? 'provider failed'
                : launchArtifactState === 'orphaned'
                    ? 'orphaned'
                    : launchArtifactState === 'launched'
                        ? 'launched'
                        : 'missing or stale';
    const invocationCurrent = Boolean(
        state
        && timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot, taskId, state)
    );
    const invocationStatus = invocationCurrent
        ? 'attested'
        : launchArtifactState === 'launched'
            ? 'missing current-cycle attestation'
            : launchArtifactState === 'provider_failed'
                ? 'blocked until launch recovery'
            : launchArtifactState === 'orphaned'
                ? 'blocked until launch recovery'
                : launchArtifactState === 'delegation_started'
                    ? 'blocked until launch completion'
            : launchArtifactState === 'prepared'
                ? 'blocked until launch completion'
                : 'blocked until launch artifact';
    let resultStatus = 'blocked until invocation';
    if (invocationCurrent && state) {
        if (!state.artifactExists && !state.receiptExists) {
            resultStatus = 'review output and receipt missing';
        } else if (!state.artifactExists) {
            resultStatus = 'review output missing';
        } else if (!state.receiptExists) {
            resultStatus = 'receipt missing';
        } else if (!state.ready) {
            resultStatus = 'receipt invalid or stale';
        } else if (!reviewStateHasSatisfiedEvidence(state)) {
            resultStatus = 'receipt missing current-cycle provenance';
        } else {
            resultStatus = 'ready';
        }
    }
    return `Reviewer readiness chain: ${[
        'preflight scope=current',
        `review context=${contextStatus}`,
        `routing=${routingStatus}`,
        `launch artifact=${launchStatus}`,
        `invocation=${invocationStatus}`,
        `review output/receipt=${resultStatus}.`
    ].join(' -> ')}`;
}

export function buildProviderNativeReviewerLaunchTargetSummary(taskMode: Record<string, unknown> | null): string {
    const provider = normalizeProviderId(taskMode?.provider);
    const providerEntry = provider ? getProviderEntryById(provider) : null;
    if (!providerEntry) {
        return 'ProviderLaunchTarget: unresolved; launch a provider-native/internal delegated reviewer subagent with a fresh isolated context.';
    }
    return (
        `ProviderLaunchTarget: ${providerEntry.reviewerLaunchLabel || providerEntry.displayLabel}; ` +
        `${providerEntry.delegatedReviewerLaunchInstruction || 'launch a clean-context delegated reviewer subagent with isolated context.'}`
    );
}
