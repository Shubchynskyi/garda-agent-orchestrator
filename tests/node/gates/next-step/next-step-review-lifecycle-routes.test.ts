import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildReviewerOneShotLaunchHint,
    resolveActiveReviewLifecycleDecisionRoute,
    resolveContextPreparationLifecycleRoute,
    resolveCurrentCycleReviewReuseRoute,
    resolveDelegatedReadinessLifecycleRoute,
    resolveDelegatedReviewerIdentityBinding,
    resolveFindingsFollowUpLifecycleRoute
} from '../../../../src/gates/next-step/next-step-review-lifecycle-routes';
import {
    resolveFailedReviewRemediationRoute
} from '../../../../src/gates/next-step/next-step-review-reuse-routing';
import type {
    NextStepDecisionRoutePayload
} from '../../../../src/gates/next-step/next-step-decision-route-groups';

function route(nextGate: string): NextStepDecisionRoutePayload {
    return {
        status: 'BLOCKED',
        nextGate,
        title: nextGate,
        reason: nextGate,
        commands: []
    };
}

test('active review lifecycle preserves dependency and remediation route precedence', () => {
    const visited: string[] = [];
    const resolved = resolveActiveReviewLifecycleDecisionRoute({
        resolveFindingsFollowUpRoute: () => {
            visited.push('findings');
            return null;
        },
        resolveCurrentCycleReuseRoute: () => {
            visited.push('reuse');
            return null;
        },
        resolveDependencyPreparationRoute: () => {
            visited.push('dependency');
            return route('build-review-context');
        },
        resolveStrictSequentialUpstreamReuseRoute: () => {
            visited.push('upstream-reuse');
            return route('unexpected');
        },
        resolveFailedReviewRemediationRoute: () => {
            visited.push('failed-review');
            return route('unexpected');
        },
        resolveContextPreparationRoute: () => {
            visited.push('context');
            return route('unexpected');
        },
        resolveDelegatedReadinessRoute: () => {
            visited.push('delegated');
            return route('unexpected');
        }
    });

    assert.equal(resolved?.nextGate, 'build-review-context');
    assert.deepEqual(visited, ['findings', 'reuse', 'dependency']);
});

test('active review lifecycle reaches delegated readiness only after earlier routes pass', () => {
    const visited: string[] = [];
    const pass = (name: string) => (): null => {
        visited.push(name);
        return null;
    };
    const resolved = resolveActiveReviewLifecycleDecisionRoute({
        resolveFindingsFollowUpRoute: pass('findings'),
        resolveCurrentCycleReuseRoute: pass('reuse'),
        resolveDependencyPreparationRoute: pass('dependency'),
        resolveStrictSequentialUpstreamReuseRoute: pass('upstream-reuse'),
        resolveFailedReviewRemediationRoute: pass('failed-review'),
        resolveContextPreparationRoute: pass('context'),
        resolveDelegatedReadinessRoute: () => {
            visited.push('delegated');
            return route('prepare-reviewer-launch');
        }
    });

    assert.equal(resolved?.nextGate, 'prepare-reviewer-launch');
    assert.deepEqual(visited, [
        'findings',
        'reuse',
        'dependency',
        'upstream-reuse',
        'failed-review',
        'context',
        'delegated'
    ]);
});

test('current-cycle reuse requires scoped metadata before context materialization', () => {
    const resolved = resolveCurrentCycleReviewReuseRoute({
        reviewType: 'code',
        stateReady: true,
        contextExists: true,
        domainScopeCurrent: true,
        reviewFailed: false,
        currentReviewEvidenceSatisfied: false,
        postReviewGateFreshnessRecoveryActive: false,
        postReviewGateFreshnessRecoveryReason: '',
        scopedDiffReadiness: {
            ready: false,
            reason: 'Scoped diff metadata is stale.'
        },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        commands: {
            buildScopedDiff: { label: 'Build scoped diff', command: 'scoped' },
            buildReviewContext: { label: 'Build review context', command: 'context' }
        }
    });

    assert.equal(resolved?.nextGate, 'build-scoped-diff');
    assert.equal(resolved?.commands[0]?.command, 'scoped');
    assert.match(resolved?.reason || '', /not bound as current-cycle review evidence/);
});

test('stale prepared launch identity remains provider-bound until the real reviewer is recorded', () => {
    const binding = resolveDelegatedReviewerIdentityBinding({
        contextReviewerIdentity: 'agent:pending:T-code',
        launchArtifactState: 'prepared',
        launchReviewerIdentity: 'agent:stale-reviewer'
    });

    assert.equal(
        binding.delegatedReviewerIdentity,
        '<agent:resolved-provider-reviewer-id-from-delegated-agent>'
    );
    assert.equal(
        binding.reviewerIdentity,
        '<agent:resolved-provider-reviewer-id-from-delegated-agent>'
    );
    assert.equal(binding.reviewerIdentityIsPlanned, true);
});

test('launched reviewer identity binds only a resolved identity', () => {
    const binding = resolveDelegatedReviewerIdentityBinding({
        contextReviewerIdentity: '',
        launchArtifactState: 'launched',
        launchReviewerIdentity: 'agent:reviewer-42'
    });

    assert.equal(binding.delegatedReviewerIdentity, 'agent:reviewer-42');
    assert.equal(binding.reviewerIdentity, 'agent:reviewer-42');
    assert.equal(binding.reviewerIdentityIsPlanned, false);
});

test('one-shot launch hint fails closed when bound input path or hash is missing', () => {
    assert.equal(buildReviewerOneShotLaunchHint({
        launchArtifactState: 'prepared',
        launchInputArtifactPath: 'runtime\\reviews\\launch-input.txt',
        launchInputArtifactSha256: null
    }), null);
    assert.equal(buildReviewerOneShotLaunchHint({
        launchArtifactState: 'prepared',
        launchInputArtifactPath: null,
        launchInputArtifactSha256: 'abc123'
    }), null);

    const hint = buildReviewerOneShotLaunchHint({
        launchArtifactState: 'prepared',
        launchInputArtifactPath: 'runtime\\reviews\\launch-input.txt',
        launchInputArtifactSha256: 'abc123'
    });
    assert.match(hint || '', /ReviewerOneShotLaunchHint/);
    assert.match(hint || '', /runtime\/reviews\/launch-input\.txt/);
    assert.match(hint || '', /launch_input_sha256=abc123/);
});

test('extracted findings and context routes preserve lifecycle contracts', () => {
    const command = { label: 'command', command: 'command' };
    const findings = resolveFindingsFollowUpLifecycleRoute({
        reviewType: 'refactor',
        findingsDispositionReady: true,
        followUpCount: 1,
        followUpSatisfied: false,
        groupedByParent: false,
        validationArtifactDisplayPath: 'runtime/findings.json',
        materializeFollowUpsCommand: command
    });
    assert.equal(findings?.nextGate, 'materialize-review-follow-up-tasks');

    const context = resolveContextPreparationLifecycleRoute({
        contextReady: false,
        reviewType: 'test',
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        preparationRoute: null,
        buildReviewContextCommand: command
    });
    assert.equal(context?.nextGate, 'build-review-context');
    assert.equal(context?.commands[0], command);
});

test('failed current review evidence blocks downstream launch until implementation remediation', () => {
    const command = { label: 'command', command: 'command' };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-findings',
        failureReason: 'implementation defect',
        currentReviewRecordedEvidenceCurrent: true,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: ['refactor', 'test'],
        reviewerResultRecoveryIdentity: null,
        launchArtifactState: 'launched',
        commands: {
            restartReviewCycle: command,
            rerunNavigator: { label: 'Rerun navigator', command: 'next-step' },
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordResult: command
        }
    });

    assert.equal(resolved?.nextGate, 'implementation');
    assert.equal(resolved?.commands[0]?.command, 'next-step');
    assert.match(resolved?.reason || '', /Dependent reviews currently blocked/);
});

test('prepared delegated lifecycle wrapper binds identity and one-shot provider start recording', () => {
    const command = { label: 'command', command: 'command' };
    const resolved = resolveDelegatedReadinessLifecycleRoute({
        contextReady: true,
        contextReviewerIdentity: 'agent:pending:T-review-code',
        recordedReviewerIdentity: '<agent:resolved-provider-reviewer-id-from-delegated-agent>',
        launchArtifactState: 'prepared',
        identityBinding: resolveDelegatedReviewerIdentityBinding({
            contextReviewerIdentity: 'agent:pending:T-review-code',
            launchArtifactState: 'prepared',
            launchReviewerIdentity: 'agent:stale-reviewer'
        }),
        launchInputArtifactPath: 'runtime/reviewer-launch-input.json',
        launchInputArtifactSha256: 'abc123',
        decision: {
            reviewType: 'code',
            currentReviewReuseRecorded: false,
            currentReviewEvidenceSatisfied: false,
            currentReviewContextInvocationAttested: false,
            routingCurrent: true,
            artifactExists: false,
            receiptExists: false,
            reviewFailed: false,
            stateReady: false,
            stateViolationsText: 'missing',
            providerLaunchTargetSummary: 'Provider target.',
            reviewerReadinessChain: 'Reviewer chain.',
            reviewRoutingChain: 'Routing chain.',
            launchPreparationChain: 'Preparation chain.',
            launchCompletionChain: 'Completion chain.',
            reviewInvocationChain: 'Invocation chain.',
            reviewResultChain: 'Result chain.',
            acceptedVerdictTokens: 'Accepted tokens.',
            hiddenTimingTrustRemediation: null,
            reusedExistingReview: false,
            instructions: {
                opaqueHandoff: 'Opaque.',
                freshContextLaunch: 'Fresh.',
                sessionReuseBoundary: 'No reuse.',
                realSubagentOrStop: 'Real reviewer.',
                cleanupAfterReceipt: 'Cleanup.'
            },
            commands: {
                recordRouting: command,
                prepareLaunch: command,
                recordDelegationStartedChoices: [
                    {
                        label: 'Record delegated reviewer start from launch artifact',
                        command: 'record-reviewer-delegation-started'
                    },
                    {
                        label: 'Record delegated reviewer start from copy-paste prompt',
                        command: 'record-reviewer-delegation-started-copy-paste'
                    }
                ],
                recordDelegationStarted: {
                    label: 'Record delegated reviewer start',
                    command: 'record-reviewer-delegation-started'
                },
                completeLaunch: command,
                recoverOrphanedLaunch: command,
                recoverFailedLaunch: command,
                recordInvocation: command,
                recordResult: command
            }
        }
    });

    assert.equal(resolved?.nextGate, 'record-reviewer-delegation-started');
    assert.equal(resolved?.commands[0]?.command, 'record-reviewer-delegation-started');
    assert.match(resolved?.reason || '', /ReviewerOneShotLaunchHint/);
    assert.match(resolved?.reason || '', /launch_input_sha256=abc123/);
});
