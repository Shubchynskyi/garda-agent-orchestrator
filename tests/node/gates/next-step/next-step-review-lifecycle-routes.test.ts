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
import {
    buildRecordReviewOutputCorrectionInvocationCommand,
    buildRecordReviewOutputCorrectionTransportCommand
} from '../../../../src/gates/next-step/next-step-review-command-builders';
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

test('validation rejection exposes the executable provider correction handoff before record-result', () => {
    const command = { label: 'Record corrected result', command: 'record-review-result' };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-validation-rejected',
        failureReason:
            'ReviewerCorrectionHandoff: provider_action=continue_delegated_reviewer; ' +
            'ReviewerCorrectionInputArtifactPath=runtime/reviews/T-review-code-output-correction.json; ' +
            `ReviewerCorrectionInputArtifactSha256=${'a'.repeat(64)}; ` +
            `ReviewerInvocationEventSha256=${'b'.repeat(64)}; ` +
            'target_reviewer_identity=agent:/root/code-review; fork_context=preserve_current_conversation.',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: ['security'],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/code-review',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'continue_delegated_reviewer',
            launchState: null,
            targetReviewerIdentity: 'agent:/root/code-review',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: null,
            originalProviderInvocationId: null,
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordResult: command
        }
    });

    assert.equal(resolved?.nextGate, 'record-review-result');
    assert.match(resolved?.title || '', /correction handoff/iu);
    assert.match(resolved?.reason || '', /provider_action=continue_delegated_reviewer/iu);
    assert.match(resolved?.reason || '', /through provider tools before running the command below/iu);
    assert.equal(
        resolved?.commands[0]?.label,
        'After the bound reviewer correction returns, record its attested corrected review result'
    );
    assert.match(resolved?.commands[0]?.command || '', /--correction-producer-identity "agent:\/root\/code-review"/u);
    assert.match(resolved?.commands[0]?.command || '', /--correction-provider-invocation-id/u);
    assert.match(
        resolved?.commands[0]?.command || '',
        new RegExp(`--correction-provider-invocation-event-sha256 "${'b'.repeat(64)}"`, 'u')
    );
    assert.match(resolved?.commands[0]?.command || '', new RegExp(`--correction-launch-input-sha256 "${'a'.repeat(64)}"`, 'u'));
});

test('API correction continuation reuses the original provider invocation binding', () => {
    const command = { label: 'Record corrected result', command: 'record-review-result' };
    const originalProviderInvocationId = '/root/original-code-review;attacker-selected=value';
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-validation-rejected',
        failureReason:
            'ReviewerCorrectionHandoff: provider_action=continue_api_conversation; ' +
            `ReviewerCorrectionInputArtifactSha256=${'a'.repeat(64)}; ` +
            `ReviewerInvocationEventSha256=${'b'.repeat(64)}; ` +
            'CorrectionProviderInvocationId=unavailable; ' +
            'OriginalProviderInvocationId=/root/original-code-review; ' +
            'target_reviewer_identity=agent:/root/code-review; fork_context=preserve_current_conversation.',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/code-review',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'continue_api_conversation',
            launchState: null,
            targetReviewerIdentity: 'agent:/root/code-review',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: 'unavailable',
            originalProviderInvocationId,
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordResult: command
        }
    });

    assert.match(
        resolved?.commands[0]?.command || '',
        /--correction-provider-invocation-id "\/root\/original-code-review;attacker-selected=value"/u
    );
    assert.doesNotMatch(
        resolved?.commands[0]?.command || '',
        /--correction-provider-invocation-id "unavailable"/u
    );
});

test('non-live correction requires fail-closed provider-controller availability before fallback', () => {
    const command = { label: 'command', command: 'record-review-result' };
    const transportCommand = {
        label: 'Record transport availability',
        command: 'record-review-output-correction-transport'
    };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-correction-transport-selection-required',
        failureReason: 'pending live correction transport',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/code-reviewer',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'continue_api_conversation',
            launchState: null,
            targetReviewerIdentity: 'agent:/root/code-reviewer',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: null,
            originalProviderInvocationId: '/root/code-reviewer',
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordCorrectionTransport: transportCommand,
            recordResult: command
        }
    });

    assert.equal(resolved?.nextGate, 'record-review-output-correction-transport');
    assert.equal(resolved?.commands[0]?.command, 'record-review-output-correction-transport');
    assert.match(
        resolved?.reason || '',
        /Record `closed`\/`stateless`.*caller-provided source string can never authorize live continuation/isu
    );
});

test('controller-only correction transport fails closed to a fresh full review', () => {
    const command = { label: 'command', command: 'record-review-result' };
    const restartCommand = { label: 'Restart review cycle', command: 'restart-review-cycle' };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-correction-transport-selection-required',
        failureReason: 'pending controller-only correction transport',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/code-reviewer',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'continue_api_conversation',
            launchState: null,
            targetReviewerIdentity: 'agent:/root/code-reviewer',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: null,
            originalProviderInvocationId: null,
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: restartCommand,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordCorrectionTransport: {
                label: 'Record transport availability',
                command: 'record-review-output-correction-transport --provider-invocation-id placeholder'
            },
            recordResult: command
        }
    });

    assert.equal(resolved?.nextGate, 'restart-review-cycle');
    assert.equal(resolved?.commands[0]?.command, 'restart-review-cycle');
    assert.doesNotMatch(resolved?.commands[0]?.command || '', /record-review-output-correction-transport/u);
    assert.match(resolved?.reason || '', /no authenticated original provider invocation binding/u);
});

test('validation rejection shell-quotes an untrusted correction reviewer identity', () => {
    const command = { label: 'Record corrected result', command: 'record-review-result' };
    const maliciousIdentity = 'agent:/root/reviewer" $(Write-Output injected)';
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-validation-rejected',
        failureReason:
            'ReviewerCorrectionHandoff: provider_action=continue_delegated_reviewer; ' +
            `ReviewerCorrectionInputArtifactSha256=${'a'.repeat(64)}; ` +
            `ReviewerInvocationEventSha256=${'b'.repeat(64)}; ` +
            `target_reviewer_identity=${maliciousIdentity}; fork_context=preserve_current_conversation.`,
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: maliciousIdentity,
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'continue_delegated_reviewer',
            launchState: null,
            targetReviewerIdentity: maliciousIdentity,
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: null,
            originalProviderInvocationId: null,
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordResult: command
        }
    });

    const correctionCommand = resolved?.commands[0]?.command || '';
    assert.match(
        correctionCommand,
        /--correction-producer-identity 'agent:\/root\/reviewer" \$\(Write-Output injected\)'/u
    );
    assert.doesNotMatch(correctionCommand, /--correction-producer-identity "agent:\/root\/reviewer"/u);
});

test('correction-only recovery attests the provider invocation before recording its result', () => {
    const command = { label: 'Record corrected result', command: 'record-review-result' };
    const attestationCommand = {
        label: 'Attest correction invocation',
        command: 'record-review-output-correction-invocation'
    };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-validation-rejected',
        failureReason:
            'ReviewerCorrectionHandoff: provider_action=launch_correction_only_reviewer; ' +
            `ReviewerCorrectionInputArtifactSha256=${'a'.repeat(64)}; ` +
            `ReviewerInvocationEventSha256=${'b'.repeat(64)}; ` +
            'CorrectionProducerInvocationEventSha256=unavailable; ' +
            'target_reviewer_identity=new_correction_only_reviewer; fork_context=false.',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/original-reviewer',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'launch_correction_only_reviewer',
            launchState: null,
            targetReviewerIdentity: 'new_correction_only_reviewer',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: null,
            correctionProducerIdentity: null,
            correctionProviderInvocationId: null,
            originalProviderInvocationId: null,
            correctionAttestationSource: null
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordCorrectionInvocation: attestationCommand,
            recordResult: command
        }
    });

    assert.equal(resolved?.nextGate, 'record-review-output-correction-invocation');
    assert.equal(resolved?.commands[0]?.command, attestationCommand.command);
});

test('correction-only completion consumes frozen launch provenance without resupplying it', () => {
    const command = buildRecordReviewOutputCorrectionInvocationCommand(
        '.',
        'node bin/garda.js',
        'T-review',
        'code',
        'garda-agent-orchestrator/runtime/reviews/T-review-code-output-correction.json',
        'a'.repeat(64),
        null,
        {
            producerIdentity: 'agent:/root/correction-reviewer',
            providerInvocationId: '/root/correction-reviewer',
            attestationSource: 'codex_multi_agent_v1'
        }
    );

    assert.match(command, /record-review-output-correction-invocation/u);
    assert.match(command, /--correction-artifact-path/u);
    assert.doesNotMatch(command, /--correction-producer-identity/u);
    assert.doesNotMatch(command, /--provider-invocation-id/u);
    assert.doesNotMatch(command, /--attestation-source/u);
    assert.doesNotMatch(command, /--launch-input-sha256/u);
    assert.doesNotMatch(command, /--fork-context/u);
});

test('correction transport command shell-quotes untrusted reviewer and provider values', () => {
    const dangerousIdentity = 'agent:/root/reviewer" $(Write-Output injected)';
    const dangerousInvocation = 'provider" $(Write-Output injected)';
    const command = buildRecordReviewOutputCorrectionTransportCommand({
        repoRoot: '.',
        cliPrefix: 'node bin/garda.js',
        taskId: 'T-review',
        reviewType: 'code',
        correctionArtifactPath:
            'garda-agent-orchestrator/runtime/reviews/T-review-code-output-correction.json',
        reviewerIdentity: dangerousIdentity,
        providerInvocationId: dangerousInvocation,
        taskModePath: 'garda-agent-orchestrator/runtime/reviews/custom-task-mode.json',
        sessionAvailability: 'closed'
    });

    assert.match(
        command,
        /--reviewer-identity 'agent:\/root\/reviewer" \$\(Write-Output injected\)'/u
    );
    assert.match(
        command,
        /--provider-invocation-id 'provider" \$\(Write-Output injected\)'/u
    );
    assert.doesNotMatch(command, /--reviewer-identity "agent:\/root\/reviewer/u);
    assert.doesNotMatch(command, /--provider-invocation-id "provider/u);
    assert.match(
        command,
        /--task-mode-path "garda-agent-orchestrator\/runtime\/reviews\/custom-task-mode\.json"/u
    );
});

test('correction-only recovery records the result with its attested producer event', () => {
    const command = { label: 'Record corrected result', command: 'record-review-result' };
    const producerEventSha256 = 'c'.repeat(64);
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'code',
        verdictToken: 'CODE_REVIEW_FAILED',
        failureKind: 'review-validation-rejected',
        failureReason:
            'ReviewerCorrectionHandoff: provider_action=launch_correction_only_reviewer; ' +
            `ReviewerCorrectionInputArtifactSha256=${'a'.repeat(64)}; ` +
            `ReviewerInvocationEventSha256=${'b'.repeat(64)}; ` +
            `CorrectionProducerInvocationEventSha256=${producerEventSha256}; ` +
            'CorrectionProducerIdentity=agent:/root/correction-reviewer; ' +
            'CorrectionProviderInvocationId=/root/correction-reviewer; ' +
            'CorrectionAttestationSource=codex_collaboration_spawn_agent; ' +
            'target_reviewer_identity=new_correction_only_reviewer; fork_context=false.',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: [],
        reviewerResultRecoveryIdentity: {
            ready: true,
            reviewerIdentity: 'agent:/root/original-reviewer',
            identitySource: 'explicit_resolved_attempt'
        },
        launchArtifactState: 'launched',
        correctionHandoff: {
            providerAction: 'launch_correction_only_reviewer',
            launchState: null,
            targetReviewerIdentity: 'new_correction_only_reviewer',
            launchInputSha256: 'a'.repeat(64),
            reviewerInvocationEventSha256: 'b'.repeat(64),
            correctionProducerInvocationEventSha256: producerEventSha256,
            correctionProducerIdentity: 'agent:/root/correction-reviewer',
            correctionProviderInvocationId: '/root/correction-reviewer',
            originalProviderInvocationId: null,
            correctionAttestationSource: 'codex_collaboration_spawn_agent'
        },
        commands: {
            restartReviewCycle: command,
            rerunNavigator: command,
            compileGate: command,
            buildScopedDiff: command,
            buildReviewContext: command,
            recordResult: command
        }
    });

    const resultCommand = resolved?.commands[0]?.command || '';
    assert.equal(resolved?.nextGate, 'record-review-result');
    assert.match(resultCommand, /--correction-producer-identity "agent:\/root\/correction-reviewer"/u);
    assert.match(resultCommand, /--correction-provider-invocation-id "\/root\/correction-reviewer"/u);
    assert.match(
        resultCommand,
        new RegExp(`--correction-provider-invocation-event-sha256 "${producerEventSha256}"`, 'u')
    );
    assert.match(resultCommand, /--correction-attestation-source "codex_collaboration_spawn_agent"/u);
});

test('exhausted output correction restarts only the affected lane with a fresh full reviewer', () => {
    const command = { label: 'Restart review cycle', command: 'restart-review-cycle' };
    const resolved = resolveFailedReviewRemediationRoute({
        taskId: 'T-review',
        reviewType: 'security',
        verdictToken: '',
        failureKind: 'review-correction-full-review-required',
        failureReason: 'correction provenance changed',
        currentReviewRecordedEvidenceCurrent: false,
        focusedIntermediateEvidence: { available: false, reason: null },
        currentReviewContextPrepared: true,
        scopedDiffReadiness: { ready: true, reason: '' },
        reviewerReadinessChain: 'Reviewer chain.',
        reviewContextChain: 'Context chain.',
        downstreamReviewTypes: ['api', 'test'],
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

    assert.equal(resolved?.nextGate, 'restart-review-cycle');
    assert.equal(resolved?.commands[0]?.command, 'restart-review-cycle');
    assert.match(resolved?.reason || '', /fresh context and launch a full reviewer/u);
    assert.doesNotMatch(resolved?.reason || '', /implementation defect.*fix/u);
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
