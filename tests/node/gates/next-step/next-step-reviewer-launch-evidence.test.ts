import { describe, it, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

import { buildEventIntegrityHash } from './next-step-test-support';
import type { ReviewArtifactState } from '../../../../src/gates/next-step/next-step-review-artifact-readers';
import {
    buildProviderNativeReviewerLaunchTargetSummary,
    buildReviewerReadinessChainSummary,
    getCurrentReviewerLaunchArtifactEvidenceForInvocation,
    timelineHasDelegatedReviewInvocationForCurrentContext,
    timelineHasDelegatedReviewRoutingAfterCompile
} from '../../../../src/gates/next-step/next-step-reviewer-launch-evidence';

const TASK_ID = 'T-REVIEW-LAUNCH-EVIDENCE';
const REVIEW_TYPE = 'code';
const REVIEWER_IDENTITY = 'agent:code-reviewer';
const HASH_A = 'a'.repeat(64);

let tempRoots: string[] = [];

afterEach(() => {
    for (const repoRoot of tempRoots.splice(0)) {
        fs.rmSync(repoRoot, { recursive: true, force: true });
    }
});

function makeTempRepo(): string {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-review-launch-evidence-'));
    tempRoots.push(repoRoot);
    fs.mkdirSync(reviewsRoot(repoRoot), { recursive: true });
    fs.mkdirSync(eventsRoot(repoRoot), { recursive: true });
    return repoRoot;
}

function reviewsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
}

function eventsRoot(repoRoot: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
}

function reviewScratchPath(repoRoot: string, taskId: string, reviewType: string, fileName: string): string {
    return path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'tmp', 'reviews', taskId, reviewType, fileName);
}

function writeJson(filePath: string, payload: unknown): void {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
}

function sha256Text(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}

function fileSha256(filePath: string): string {
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function appendEvent(
    repoRoot: string,
    taskId: string,
    eventType: string,
    details: Record<string, unknown> = {}
): { task_sequence: number; prev_event_sha256: string | null; event_sha256: string } {
    const timelinePath = path.join(eventsRoot(repoRoot), `${taskId}.jsonl`);
    const existingLines = fs.existsSync(timelinePath)
        ? fs.readFileSync(timelinePath, 'utf8').split('\n').filter((line) => line.trim())
        : [];
    const taskSequence = existingLines.length + 1;
    const previousEvent = taskSequence > 1
        ? JSON.parse(existingLines[existingLines.length - 1]) as Record<string, unknown>
        : null;
    const previousIntegrity = previousEvent?.integrity && typeof previousEvent.integrity === 'object'
        ? previousEvent.integrity as Record<string, unknown>
        : null;
    const previousEventSha256 = typeof previousIntegrity?.event_sha256 === 'string'
        ? previousIntegrity.event_sha256
        : null;
    const line: Record<string, unknown> = {
        task_id: taskId,
        event_type: eventType,
        outcome: 'PASS',
        actor: 'gate',
        message: eventType,
        timestamp_utc: '2026-06-01T00:00:00.000Z',
        details,
        integrity: {
            schema_version: 1,
            task_sequence: taskSequence,
            prev_event_sha256: previousEventSha256,
            event_sha256: null
        }
    };
    const integrity = line.integrity as Record<string, unknown>;
    integrity.event_sha256 = buildEventIntegrityHash(line);
    const eventSha256 = String(integrity.event_sha256 || '');
    fs.appendFileSync(timelinePath, `${JSON.stringify(line)}\n`, 'utf8');
    return {
        task_sequence: taskSequence,
        prev_event_sha256: previousEventSha256,
        event_sha256: eventSha256
    };
}

function makeReviewState(contextPath: string, overrides: Partial<ReviewArtifactState> = {}): ReviewArtifactState {
    return {
        reviewType: REVIEW_TYPE,
        contextPath,
        artifactPath: '',
        receiptPath: '',
        contextExists: true,
        contextCurrent: true,
        artifactExists: false,
        receiptExists: false,
        passToken: 'REVIEW PASSED',
        failToken: 'CODE REVIEW FAILED',
        verdictToken: null,
        failed: false,
        failureKind: null,
        failureReason: null,
        domainScopeCurrent: true,
        ready: false,
        violations: [],
        reviewerIdentity: REVIEWER_IDENTITY,
        contextReviewerIdentity: REVIEWER_IDENTITY,
        reusedExistingReview: false,
        reusedFromReceiptPath: null,
        reusedFromReceiptSha256: null,
        reusedFromReviewContextSha256: null,
        reusedFromReviewContextReuseSha256: null,
        reusedFromReviewTreeStateSha256: null,
        reusedFromReviewScopeSha256: null,
        reusedFromCodeScopeSha256: null,
        receiptReviewContextSha256: null,
        receiptReviewContextReuseSha256: null,
        receiptReviewScopeSha256: null,
        receiptCodeScopeSha256: null,
        contextReviewTreeStateSha256: HASH_A,
        receiptReviewTreeStateSha256: null,
        reviewerProvenance: null,
        reviewResultRecordedAtUtc: null,
        recordedAtUtc: null,
        reviewOutputSourceMtimeUtc: null,
        ...overrides
    };
}

function seedCompileAndRouting(repoRoot: string, contextSha256: string): { routingEventSha256: string } {
    appendEvent(repoRoot, TASK_ID, 'COMPILE_GATE_PASSED');
    const routing = appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_ROUTED', {
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256
    });
    return { routingEventSha256: routing.event_sha256 };
}

function seedPreparedLaunchArtifact(repoRoot: string, contextPath: string): {
    launchArtifactPath: string;
    launchArtifactSha256: string;
    preparedLaunchEventSha256: string;
    routingEventSha256: string;
} {
    const contextSha256 = fileSha256(contextPath);
    const { routingEventSha256 } = seedCompileAndRouting(repoRoot, contextSha256);
    const launchArtifactPath = reviewScratchPath(repoRoot, TASK_ID, REVIEW_TYPE, 'reviewer-launch.json');
    const launchInputArtifactPath = reviewScratchPath(repoRoot, TASK_ID, REVIEW_TYPE, 'reviewer-launch-input.json');
    const launchBindingSha256 = 'b'.repeat(64);
    const preparedEvent = appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_PREPARED', {
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: REVIEWER_IDENTITY,
        reviewer_identity: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventSha256,
        launch_binding_sha256: launchBindingSha256,
        reviewer_launch_artifact_path: launchArtifactPath
    });
    const launchArtifactBase = {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch_preparation',
        attestation_state: 'prepared',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventSha256,
        launch_binding_sha256: launchBindingSha256,
        prepared_launch_event_sha256: preparedEvent.event_sha256,
        reviewer_launch_input_artifact_path: launchInputArtifactPath
    };
    writeJson(launchInputArtifactPath, launchArtifactBase);
    const pinnedInputArtifactSha256 = fileSha256(launchInputArtifactPath);
    writeJson(launchArtifactPath, {
        ...launchArtifactBase,
        reviewer_launch_input_artifact_sha256: pinnedInputArtifactSha256
    });
    return {
        launchArtifactPath,
        launchArtifactSha256: fileSha256(launchArtifactPath),
        preparedLaunchEventSha256: preparedEvent.event_sha256,
        routingEventSha256
    };
}

function overwriteLaunchedArtifact(
    repoRoot: string,
    contextPath: string,
    launchArtifactPath: string,
    preparedLaunchEventSha256: string,
    routingEventSha256: string
): string {
    const contextSha256 = fileSha256(contextPath);
    const copyPastePrompt = `Delegated ${REVIEW_TYPE} reviewer launch prompt for ${TASK_ID}.`;
    const copyPastePromptSha256 = sha256Text(copyPastePrompt);
    const delegationStartedAtUtc = '2026-06-01T00:00:01.000Z';
    const launchCompletedAtUtc = '2026-06-01T00:00:12.000Z';
    writeJson(launchArtifactPath, {
        schema_version: 1,
        evidence_type: 'delegated_reviewer_launch',
        attestation_state: 'launched',
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_identity: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventSha256,
        launch_binding_sha256: 'b'.repeat(64),
        prepared_launch_event_sha256: preparedLaunchEventSha256,
        launch_tool: 'test-subagent-spawn',
        provider_invocation_id: 'test-provider-invocation',
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc,
        copy_paste_reviewer_launch_prompt: copyPastePrompt,
        copy_paste_reviewer_launch_prompt_sha256: copyPastePromptSha256,
        launch_input_mode: 'copy_paste_prompt',
        launch_input_sha256: copyPastePromptSha256,
        fork_context: false
    });
    appendEvent(repoRoot, TASK_ID, 'REVIEWER_DELEGATION_STARTED', {
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: REVIEWER_IDENTITY,
        reviewer_identity: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventSha256,
        provider_invocation_id: 'test-provider-invocation',
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc
    });
    appendEvent(repoRoot, TASK_ID, 'REVIEWER_LAUNCH_COMPLETED', {
        task_id: TASK_ID,
        review_type: REVIEW_TYPE,
        reviewer_execution_mode: 'delegated_subagent',
        reviewer_session_id: REVIEWER_IDENTITY,
        reviewer_identity: REVIEWER_IDENTITY,
        review_context_sha256: contextSha256,
        routing_event_sha256: routingEventSha256,
        reviewer_launch_artifact_sha256: fileSha256(launchArtifactPath),
        provider_invocation_id: 'test-provider-invocation',
        delegation_started_at_utc: delegationStartedAtUtc,
        launched_at_utc: delegationStartedAtUtc,
        launch_completed_at_utc: launchCompletedAtUtc
    });
    return fileSha256(launchArtifactPath);
}

describe('next-step reviewer launch evidence helpers', () => {
    it('resolves current prepared launch artifacts and readiness chain state', () => {
        const repoRoot = makeTempRepo();
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${REVIEW_TYPE}-review-context.json`);
        writeJson(contextPath, { task_id: TASK_ID, review_type: REVIEW_TYPE });
        seedPreparedLaunchArtifact(repoRoot, contextPath);

        const state = makeReviewState(contextPath);
        const artifactEvidence = getCurrentReviewerLaunchArtifactEvidenceForInvocation(
            repoRoot,
            eventsRoot(repoRoot),
            TASK_ID,
            state
        );

        assert.equal(timelineHasDelegatedReviewRoutingAfterCompile(eventsRoot(repoRoot), TASK_ID, REVIEW_TYPE, REVIEWER_IDENTITY), true);
        assert.equal(artifactEvidence.state, 'prepared');
        assert.equal(artifactEvidence.launchInputArtifactSha256, fileSha256(
            reviewScratchPath(repoRoot, TASK_ID, REVIEW_TYPE, 'reviewer-launch-input.json')
        ));
        assert.notEqual(artifactEvidence.launchInputArtifactSha256, artifactEvidence.sha256);
        assert.match(
            buildReviewerReadinessChainSummary(
                repoRoot,
                eventsRoot(repoRoot),
                TASK_ID,
                REVIEW_TYPE,
                state,
                () => false
            ),
            /launch artifact=prepared -> invocation=blocked until launch completion/
        );
    });

    it('requires launched artifact binding before invocation attestation is current', () => {
        const repoRoot = makeTempRepo();
        const contextPath = path.join(reviewsRoot(repoRoot), `${TASK_ID}-${REVIEW_TYPE}-review-context.json`);
        writeJson(contextPath, { task_id: TASK_ID, review_type: REVIEW_TYPE });
        const { launchArtifactPath, preparedLaunchEventSha256, routingEventSha256 } = seedPreparedLaunchArtifact(repoRoot, contextPath);
        const launchArtifactSha256 = overwriteLaunchedArtifact(
            repoRoot,
            contextPath,
            launchArtifactPath,
            preparedLaunchEventSha256,
            routingEventSha256
        );
        const delegationStartedAtUtc = '2026-06-01T00:00:01.000Z';
        const launchCompletedAtUtc = '2026-06-01T00:00:12.000Z';
        appendEvent(repoRoot, TASK_ID, 'REVIEWER_INVOCATION_ATTESTED', {
            task_id: TASK_ID,
            review_type: REVIEW_TYPE,
            reviewer_execution_mode: 'delegated_subagent',
            reviewer_session_id: REVIEWER_IDENTITY,
            reviewer_identity: REVIEWER_IDENTITY,
            review_context_sha256: fileSha256(contextPath),
            review_tree_state_sha256: HASH_A,
            routing_event_sha256: routingEventSha256,
            reviewer_launch_artifact_sha256: launchArtifactSha256,
            provider_invocation_id: 'test-provider-invocation',
            delegation_started_at_utc: delegationStartedAtUtc,
            launched_at_utc: delegationStartedAtUtc,
            launch_completed_at_utc: launchCompletedAtUtc
        });

        const state = makeReviewState(contextPath, {
            artifactExists: true,
            receiptExists: true,
            ready: true
        });

        assert.equal(getCurrentReviewerLaunchArtifactEvidenceForInvocation(repoRoot, eventsRoot(repoRoot), TASK_ID, state).state, 'launched');
        assert.equal(timelineHasDelegatedReviewInvocationForCurrentContext(repoRoot, eventsRoot(repoRoot), TASK_ID, state), true);
        assert.match(
            buildReviewerReadinessChainSummary(
                repoRoot,
                eventsRoot(repoRoot),
                TASK_ID,
                REVIEW_TYPE,
                state,
                () => true
            ),
            /invocation=attested -> review output\/receipt=ready/
        );
    });

    it('summarizes provider-native delegated reviewer launch target from provider registry', () => {
        assert.match(
            buildProviderNativeReviewerLaunchTargetSummary({ provider: 'Codex' }),
            /^ProviderLaunchTarget: Codex; /
        );
    });
});
