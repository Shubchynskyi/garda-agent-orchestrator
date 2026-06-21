import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import {
    getProviderEntryById,
    normalizeProviderId
} from '../../core/provider-registry';
import {
    fileSha256,
    normalizePath,
    resolvePathInsideRepo
} from '../shared/helpers';
import {
    resolveDefaultReviewScratchPath,
    resolveReviewScratchRoot
} from '../review/review-scratch-paths';
import {
    safeReadJson
} from '../task-audit/task-audit-summary-collectors';
import type {
    ReviewArtifactState
} from './next-step-review-artifact-readers';
import {
    buildPlannedReviewerIdentity,
    isResolvedReviewerIdentity,
    reviewerIdentityMatchesDelegatedLaunchCycle
} from '../../gate-runtime/review/reviewer-identity-contract';
import type {
    DelegatedReviewLaunchArtifactState
} from './next-step-review-readiness-routing';

const PREPARED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch_preparation';
const COMPLETED_REVIEWER_LAUNCH_EVIDENCE_TYPE = 'delegated_reviewer_launch';

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

function isPlainRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function fileExists(filePath: string): boolean {
    return fs.existsSync(filePath) && fs.statSync(filePath).isFile();
}

function stringSha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
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

function getArtifactStringField(artifact: Record<string, unknown>, ...fieldNames: string[]): string {
    for (const fieldName of fieldNames) {
        const rawValue = artifact[fieldName];
        if (typeof rawValue === 'string' && rawValue.trim()) {
            return rawValue.trim();
        }
    }
    return '';
}

function hasReviewerLaunchInputEvidence(launchArtifact: Record<string, unknown>): boolean {
    const copyPastePrompt = getArtifactStringField(
        launchArtifact,
        'copy_paste_reviewer_launch_prompt',
        'copyPasteReviewerLaunchPrompt'
    );
    const copyPastePromptSha256 = getArtifactStringField(
        launchArtifact,
        'copy_paste_reviewer_launch_prompt_sha256',
        'copyPasteReviewerLaunchPromptSha256'
    ).toLowerCase();
    const launchInputMode = getArtifactStringField(launchArtifact, 'launch_input_mode', 'launchInputMode').toLowerCase();
    const launchInputSha256 = getArtifactStringField(launchArtifact, 'launch_input_sha256', 'launchInputSha256').toLowerCase();
    const launchInputArtifactPath = getArtifactStringField(launchArtifact, 'launch_input_artifact_path', 'launchInputArtifactPath');
    const launchInputArtifactSha256 = getArtifactStringField(
        launchArtifact,
        'launch_input_artifact_sha256',
        'launchInputArtifactSha256'
    ).toLowerCase();
    const preparedLaunchArtifactSha256 = getArtifactStringField(
        launchArtifact,
        'prepared_reviewer_launch_artifact_sha256',
        'preparedReviewerLaunchArtifactSha256'
    ).toLowerCase();
    if (
        !copyPastePrompt
        || !/^[0-9a-f]{64}$/.test(copyPastePromptSha256)
        || copyPastePromptSha256 !== stringSha256(copyPastePrompt)
        || !/^[0-9a-f]{64}$/.test(launchInputSha256)
    ) {
        return false;
    }
    if (launchInputMode === 'copy_paste_prompt') {
        return launchInputSha256 === copyPastePromptSha256;
    }
    if (launchInputMode === 'launch_artifact_path') {
        return Boolean(
            launchInputArtifactPath
            && /^[0-9a-f]{64}$/.test(launchInputArtifactSha256)
            && /^[0-9a-f]{64}$/.test(preparedLaunchArtifactSha256)
            && launchInputArtifactSha256 === preparedLaunchArtifactSha256
            && launchInputSha256 === preparedLaunchArtifactSha256
        );
    }
    return false;
}

function hasCompletedReviewerLaunchEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    const delegationStartedAtUtc = getArtifactStringField(
        launchArtifact,
        'delegation_started_at_utc',
        'delegationStartedAtUtc'
    );
    const launchedAtUtc = getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc');
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && delegationStartedAtUtc
        && launchedAtUtc
        && launchedAtUtc === delegationStartedAtUtc
        && freshContext
        && hasReviewerLaunchInputEvidence(launchArtifact)
    );
}

function hasDelegationStartedEvidence(launchArtifact: Record<string, unknown>): boolean {
    const providerInvocationId = getArtifactStringField(
        launchArtifact,
        'provider_invocation_id',
        'providerInvocationId',
        'controller_invocation_id',
        'controllerInvocationId'
    );
    const freshContext = launchArtifact.fresh_context === true
        || launchArtifact.freshContext === true
        || launchArtifact.isolated_context === true
        || launchArtifact.isolatedContext === true
        || launchArtifact.fork_context === false
        || launchArtifact.forkContext === false;
    return Boolean(
        getArtifactStringField(launchArtifact, 'launch_tool', 'launchTool')
        && providerInvocationId
        && getArtifactStringField(launchArtifact, 'delegation_started_at_utc', 'delegationStartedAtUtc')
        && getArtifactStringField(launchArtifact, 'launched_at_utc', 'launchedAtUtc')
        && freshContext
        && hasReviewerLaunchInputEvidence(launchArtifact)
    );
}

interface MatchingReviewerDelegationStartedTelemetry {
    taskSequence: number | null;
}

function getEventTaskSequence(event: Record<string, unknown>): number | null {
    const integrity = isPlainRecord(event.integrity) ? event.integrity : null;
    const sequence = typeof integrity?.task_sequence === 'number'
        ? integrity.task_sequence
        : Number(integrity?.task_sequence);
    return Number.isInteger(sequence) && sequence > 0 ? sequence : null;
}

function findMatchingReviewerDelegationStartedTelemetry(options: {
    lines: string[];
    taskId: string;
    reviewType: string;
    reviewerIdentity: string;
    plannedReviewerIdentity: string;
    reviewContextSha256: string;
    routingEventSha256: string;
    launchBindingSha256: string;
    preparedLaunchEventSha256: string;
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

function hasMatchingReviewerDelegationStartedTelemetry(options: Parameters<typeof findMatchingReviewerDelegationStartedTelemetry>[0]): boolean {
    return findMatchingReviewerDelegationStartedTelemetry(options) != null;
}

function hasControllerResumeAfterSequence(lines: string[], sequence: number | null): boolean {
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

function hasMatchingReviewerLaunchCompletedTelemetry(options: {
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

function resolveReviewerLaunchArtifactPathFromTelemetry(repoRoot: string, rawPath: unknown): string | null {
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

function getReviewContextSha256CandidatesForInvocationMatching(
    state: ReviewArtifactState,
    contextPath: string
): string[] {
    const candidates: string[] = [];
    const currentSha256 = fileSha256(contextPath);
    if (currentSha256) {
        candidates.push(currentSha256);
    }
    for (const candidate of [
        String(state.reviewerProvenance?.review_context_sha256 || '').trim().toLowerCase(),
        String(state.receiptReviewContextSha256 || '').trim().toLowerCase()
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
            const artifactReviewTreeStateSha256 = getArtifactStringField(
                launchArtifact,
                'review_tree_state_sha256',
                'reviewTreeStateSha256'
            ).toLowerCase();
            const currentContextShaMatches = artifactReviewContextSha256 === reviewContextSha256
                && preparedEventReviewContextSha256 === reviewContextSha256;
            const launchBoundContextMatchesCurrentTree = Boolean(
                /^[0-9a-f]{64}$/.test(artifactReviewContextSha256)
                && artifactReviewContextSha256 === preparedEventReviewContextSha256
                && artifactReviewTreeStateSha256
                && artifactReviewTreeStateSha256 === String(state.contextReviewTreeStateSha256 || '').trim().toLowerCase()
            );
            const matchedReviewContextSha256 = currentContextShaMatches || launchBoundContextMatchesCurrentTree
                ? artifactReviewContextSha256
                : '';
            const launchBindingSha256 = getArtifactStringField(
                launchArtifact,
                'launch_binding_sha256',
                'launchBindingSha256'
            ).toLowerCase();
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
            ) {
                continue;
            }
            const evidenceType = getArtifactStringField(launchArtifact, 'evidence_type', 'artifact_type');
            const attestationState = getArtifactStringField(launchArtifact, 'attestation_state', 'attestationState');
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
                    )
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
            if (artifactState === 'delegation_started' && reviewOutputPath && !fileExists(reviewOutputPath)) {
                const delegationStartedAtUtc = getArtifactStringField(
                    launchArtifact,
                    'delegation_started_at_utc',
                    'delegationStartedAtUtc'
                );
                const matchingDelegationStarted = findMatchingReviewerDelegationStartedTelemetry({
                    lines,
                    taskId,
                    reviewType: state.reviewType,
                    reviewerIdentity,
                    plannedReviewerIdentity,
                    reviewContextSha256: matchedReviewContextSha256,
                    routingEventSha256,
                    launchBindingSha256,
                    preparedLaunchEventSha256,
                    providerInvocationId: getArtifactStringField(
                        launchArtifact,
                        'provider_invocation_id',
                        'providerInvocationId',
                        'controller_invocation_id',
                        'controllerInvocationId'
                    ),
                    delegationStartedAtUtc
                });
                if (hasControllerResumeAfterSequence(lines, matchingDelegationStarted?.taskSequence ?? null)) {
                    artifactState = 'orphaned';
                    orphanedReason = 'controller_resume_after_delegation_start_with_missing_review_output';
                }
            }
            let launchInputArtifactPath: string | null = null;
            let launchInputArtifactSha256: string | null = null;
            if (artifactState === 'prepared' || artifactState === 'delegation_started' || artifactState === 'orphaned') {
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

export function timelineHasDelegatedReviewRoutingAfterCompile(
    eventsRoot: string,
    taskId: string,
    reviewType: string,
    reviewerIdentity: string
): boolean {
    return getDelegatedReviewRoutingShaAfterCompile(eventsRoot, taskId, reviewType, reviewerIdentity) != null;
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
