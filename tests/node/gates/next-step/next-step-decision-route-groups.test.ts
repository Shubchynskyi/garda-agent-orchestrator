import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveDelegatedReviewDecisionRoute,
    resolveFullSuiteDecisionRoute,
    resolveTaskQueueTerminalDecisionRoute
} from '../../../../src/gates/next-step/next-step-decision-route-groups';

function makeTempRuntime(): { repoRoot: string; reviewsRoot: string; eventsRoot: string } {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-next-step-route-groups-'));
    const reviewsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'reviews');
    const eventsRoot = path.join(repoRoot, 'garda-agent-orchestrator', 'runtime', 'task-events');
    fs.mkdirSync(reviewsRoot, { recursive: true });
    fs.mkdirSync(eventsRoot, { recursive: true });
    return { repoRoot, reviewsRoot, eventsRoot };
}

test('resolveTaskQueueTerminalDecisionRoute preserves DONE conflict routing through task-reset', () => {
    const runtime = makeTempRuntime();
    const route = resolveTaskQueueTerminalDecisionRoute({
        ...runtime,
        taskId: 'T-1',
        cliPrefix: 'node bin/garda.js',
        taskEntries: new Map(),
        taskEntry: {
            taskId: 'T-1',
            status: 'DONE',
            area: 'workflow/test',
            title: 'Done task without gate evidence',
            profile: 'strict',
            notes: ''
        },
        completionGatePassed: false,
        latestCompletionCurrent: false,
        finalReportContractReady: false,
        finalReportContractBlocker: 'final report missing',
        summaryBlockers: ['compile-gate: missing'],
        filteredMissingArtifacts: [],
        corePresentArtifacts: []
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-reset');
    assert.equal(route.commands[0]?.label, 'Preview explicit operator reopen');
    assert.match(route.reason, /completion-gate: missing or not passed/);
});

test('resolveFullSuiteDecisionRoute preserves after-compile full-suite routing', () => {
    const route = resolveFullSuiteDecisionRoute({
        enabled: true,
        placement: 'after_compile_before_reviews',
        notRequiredForCurrentScope: false,
        gateStatus: null,
        gatePassed: false,
        timeoutBlockerExhausted: false,
        timeoutRepairTaskProposal: null,
        timedOutRetryAvailable: false,
        transientRetryEvidenceAvailable: false,
        transientRetryEvidenceReason: null,
        targetedDiagnosticRetryAvailable: false,
        targetedDiagnosticRetryReason: null,
        configPath: 'garda-agent-orchestrator/live/config/workflow-config.json',
        commandText: 'npm run test:sharded',
        timeoutForecastLine: 'Recommended full-suite command timeout: 389s.',
        command: 'node bin/garda.js gate full-suite-validation --task-id "T-1"',
        runMarkerRecoveryCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-1"',
        runMarkerCleanupCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-1" --clear-dead-marker --operator-confirmed yes',
        navigatorCommand: 'node bin/garda.js next-step "T-1" --repo-root "."',
        nextReviewType: 'code'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'full-suite-validation');
    assert.equal(route.commands[0]?.label, 'Run full-suite validation');
    assert.match(route.reason, /before launching independent reviewers/);
});

test('resolveDelegatedReviewDecisionRoute preserves missing routing recovery before reviewer launch', () => {
    const route = resolveDelegatedReviewDecisionRoute({
        reviewType: 'code',
        currentReviewReuseRecorded: false,
        currentReviewEvidenceSatisfied: false,
        currentReviewContextInvocationAttested: false,
        routingCurrent: false,
        artifactExists: false,
        receiptExists: false,
        reviewFailed: false,
        stateReady: false,
        stateViolationsText: 'review artifact or receipt is missing',
        reviewerIdentity: '',
        contextReviewerIdentity: '',
        reviewerIdentityIsPlanned: false,
        launchArtifactState: 'missing_or_invalid',
        providerLaunchTargetSummary: 'Codex via AGENTS.md',
        reviewerReadinessChain: 'reviewer readiness chain',
        reviewRoutingChain: 'review routing chain',
        launchPreparationChain: 'launch preparation chain',
        launchCompletionChain: 'launch completion chain',
        reviewInvocationChain: 'review invocation chain',
        reviewResultChain: 'review result chain',
        acceptedVerdictTokens: 'REVIEW PASSED',
        hiddenTimingTrustRemediation: null,
        reusedExistingReview: false,
        oneShotLaunchHint: null,
        instructions: {
            opaqueHandoff: 'opaque handoff',
            freshContextLaunch: 'fresh context',
            sessionReuseBoundary: 'no reuse',
            realSubagentOrStop: 'real subagent or stop',
            cleanupAfterReceipt: 'cleanup'
        },
        commands: {
            recordRouting: {
                label: 'Record fresh delegated review routing',
                command: 'node bin/garda.js gate record-review-routing --task-id "T-1"'
            },
            prepareLaunch: {
                label: 'Prepare delegated reviewer launch metadata',
                command: 'node bin/garda.js gate prepare-reviewer-launch --task-id "T-1"'
            },
            recordDelegationStarted: {
                label: 'Record delegated reviewer start',
                command: 'node bin/garda.js gate record-reviewer-delegation-started --task-id "T-1"'
            },
            completeLaunch: {
                label: 'Complete delegated reviewer launch metadata',
                command: 'node bin/garda.js gate complete-reviewer-launch --task-id "T-1"'
            },
            recoverOrphanedLaunch: {
                label: 'Restart/supersede orphaned delegated reviewer launch',
                command: 'node bin/garda.js gate restart-review-cycle --task-id "T-1"'
            },
            recordInvocation: {
                label: 'Record delegated reviewer launch attestation',
                command: 'node bin/garda.js gate record-reviewer-invocation --task-id "T-1"'
            },
            recordResult: {
                label: 'Pipe delegated review output into stdin, then close reviewer',
                command: 'node bin/garda.js gate record-review-result --task-id "T-1"'
            }
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'record-review-routing');
    assert.equal(route.commands[0]?.label, 'Record fresh delegated review routing');
    assert.match(route.title, /delegated reviewer routing/);
});
