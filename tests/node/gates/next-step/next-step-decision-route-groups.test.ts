import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    resolveClassifyDecisionRoute,
    resolveCompletedCloseoutDecisionRoute,
    resolveDelegatedReviewDecisionRoute,
    resolveFullSuiteDecisionRoute,
    resolveOptionalSkillSelectionDecisionRoute,
    resolvePendingOptionalSkillDecisionRoute,
    resolvePreGuardDecisionRoute,
    resolveStartupDecisionRoute,
    resolveTaskIdCaseMismatchDecisionRoute,
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

test('resolveTaskIdCaseMismatchDecisionRoute preserves terminal casing recovery before startup', () => {
    const route = resolveTaskIdCaseMismatchDecisionRoute({
        requestedTaskId: 't-1',
        taskIdCaseMismatch: 'T-1',
        cliPrefix: 'node bin/garda.js',
        presentArtifacts: []
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-id-casing');
    assert.equal(route.commands[0]?.label, 'Rerun navigator with TASK.md casing');
    assert.equal(route.commands[0]?.command, 'node bin/garda.js next-step "T-1" --repo-root "."');
});

test('resolveStartupDecisionRoute preserves fresh task-mode startup command', () => {
    const route = resolveStartupDecisionRoute({
        enterTaskModePassed: false,
        protectedManifestRecovery: null,
        defaultExecutionProvider: 'Codex',
        enterTaskModeCommand:
            'node bin/garda.js gate enter-task-mode --task-id "T-1" --provider "Codex" --repo-root "."',
        startupCycleReadiness: {
            ready: false,
            reason: 'No TASK_MODE_ENTERED event exists for this task.',
            nextGate: 'load-rule-pack',
            title: 'Load TASK_ENTRY rules.'
        },
        loadRulePackPassed: false,
        rulePackStage: null,
        preflightExists: false,
        taskEntryRulePackCommand: 'node bin/garda.js gate load-rule-pack --task-id "T-1"',
        handshakeDiagnosticsPassed: false,
        handshakeDiagnosticsCommand: 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"',
        shellSmokePreflightPassed: false,
        shellSmokePreflightCommand: 'node bin/garda.js gate shell-smoke-preflight --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0]?.label, 'Enter task mode');
    assert.match(route.reason, /No TASK_MODE_ENTERED event exists/);
});

test('resolveClassifyDecisionRoute keeps failed classify recovery ahead of strict and protected routes', () => {
    let lowerPriorityRouteRead = false;
    const route = resolveClassifyDecisionRoute({
        preflightExists: false,
        classifyChangePassed: false,
        readFailedGateRecovery: () => ({
            nextGate: 'classify-change',
            title: 'Recover failed classify-change.',
            reason: 'The latest classify-change attempt failed.',
            command: 'node bin/garda.js gate classify-change --task-id "T-1"',
            label: 'Retry classify-change'
        }),
        resolveStrictDecompositionRoute: () => {
            lowerPriorityRouteRead = true;
            return null;
        },
        resolveProtectedScopeRoute: () => {
            lowerPriorityRouteRead = true;
            return null;
        },
        buildClassifyCommand: () => {
            lowerPriorityRouteRead = true;
            return 'unexpected';
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.commands[0]?.label, 'Retry classify-change');
    assert.equal(lowerPriorityRouteRead, false);
});

test('resolveClassifyDecisionRoute keeps protected restart ahead of ordinary classify fallback', () => {
    let classifyCommandBuilt = false;
    const route = resolveClassifyDecisionRoute({
        preflightExists: false,
        classifyChangePassed: false,
        readFailedGateRecovery: () => null,
        resolveStrictDecompositionRoute: () => null,
        resolveProtectedScopeRoute: () => ({
            status: 'BLOCKED',
            nextGate: 'enter-task-mode',
            title: 'Restart task mode for protected scope before classify.',
            reason: 'Fresh operator approval is required.',
            commands: [{
                label: 'Restart task mode with orchestrator work',
                command: 'node bin/garda.js gate enter-task-mode --orchestrator-work'
            }]
        }),
        buildClassifyCommand: () => {
            classifyCommandBuilt = true;
            return 'unexpected';
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0]?.label, 'Restart task mode with orchestrator work');
    assert.equal(classifyCommandBuilt, false);
});

test('resolveCompletedCloseoutDecisionRoute preserves final audit materialization routing', () => {
    const route = resolveCompletedCloseoutDecisionRoute({
        completionGatePassed: true,
        latestCompletionCurrent: true,
        postDoneDriftBlocked: false,
        postDoneDriftReason: '',
        finalReportContractReady: true,
        finalReportContractBlocker: '',
        finalReport: null,
        taskAuditCommand: 'node bin/garda.js gate task-audit-summary --task-id "T-1"',
        missingArtifacts: [{
            key: 'final-closeout',
            path: 'garda-agent-orchestrator/runtime/reviews/T-1-final-closeout.json',
            exists: false
        }]
    });

    assert.ok(route);
    assert.equal(route.status, 'READY');
    assert.equal(route.nextGate, 'task-audit-summary');
    assert.equal(route.commands[0]?.label, 'Build final audit summary');
    assert.equal(route.missingArtifacts?.[0]?.key, 'final-closeout');
});

const OPTIONAL_SKILL_SELECTION_BASE = Object.freeze({
    artifact_path: 'garda-agent-orchestrator/runtime/reviews/T-1-optional-skill-selection.json',
    artifact_present: true,
    artifact_violations: [] as string[],
    timeline_invalid_json: false,
    current_policy_mode: 'mandatory',
    policy_mode: 'mandatory',
    decision: 'selected_installed_skills',
    selection_phase: 'pre_implementation',
    path_evidence_source: 'planned_changed_files',
    post_diff_self_check: false,
    selected_skill_ids: ['node-backend'],
    selected_skill_sources: ['custom_live'],
    selected_skill_details: [{
        id: 'node-backend',
        pack: 'node-backend',
        source: 'custom_live',
        allowed_skill_path: 'garda-agent-orchestrator/live/skills/node-backend/SKILL.md'
    }],
    activated_skill_ids: [] as string[],
    declined_skill_ids: [] as string[],
    pending_activation_skill_ids: ['node-backend'],
    recommended_missing_pack_ids: [] as string[],
    as_is_reason: null,
    changed_paths: ['src/app.ts'],
    changed_paths_count: 1,
    visible_summary_line: 'Optional skills: node-backend',
    activation_commands: ['activate node-backend'],
    decline_commands: [] as string[],
    skill_catalog_path: 'garda-agent-orchestrator/live/config/skills-headlines.json',
    task_start_instruction: 'Activate node-backend.'
});

test('resolveOptionalSkillSelectionDecisionRoute keeps artifact violations ahead of remediation', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: {
            ...OPTIONAL_SKILL_SELECTION_BASE,
            artifact_violations: ['selection hash mismatch']
        },
        mandatoryRemediation: {
            label: 'Install missing skill pack',
            command: 'skills install node-backend',
            reason: 'Skill pack is missing.'
        },
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.match(route.reason, /selection hash mismatch/);
    assert.equal(route.commands[0]?.label, 'Refresh preflight and optional-skill selection');
});

test('resolveOptionalSkillSelectionDecisionRoute preserves mandatory remediation routing', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: OPTIONAL_SKILL_SELECTION_BASE,
        mandatoryRemediation: {
            label: 'Install missing skill pack',
            command: 'skills install node-backend',
            reason: 'Skill pack is missing.'
        },
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'optional-skill-remediation');
    assert.equal(route.reason, 'Skill pack is missing.');
    assert.equal(route.commands[0]?.command, 'skills install node-backend');
});

test('resolveOptionalSkillSelectionDecisionRoute fails closed on malformed mandatory timeline', () => {
    const route = resolveOptionalSkillSelectionDecisionRoute({
        optionalSkillSelection: {
            ...OPTIONAL_SKILL_SELECTION_BASE,
            timeline_invalid_json: true
        },
        mandatoryRemediation: null,
        mandatoryPolicyMode: true,
        refreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        timelineIntegrityCommand: 'node bin/garda.js gate task-events-summary --task-id "T-1"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'task-events-summary');
    assert.match(route.reason, /timeline JSONL is malformed/i);
    assert.equal(route.commands[0]?.label, 'Inspect task timeline integrity');
});

test('resolvePreGuardDecisionRoute preserves stale-cycle refresh ahead of later guards', () => {
    const route = resolvePreGuardDecisionRoute({
        preflightCycleReadiness: {
            ready: false,
            reason: 'Preflight evidence is older than task-mode evidence.'
        },
        preflightCycleRefreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        protectedControlPlane: {
            touched: true,
            taskModeHasOrchestratorWork: false,
            selfGuardDeny: true,
            selfGuardGuidance: 'Operator maintenance required.',
            selfGuardPolicyChangeCommand: 'node bin/garda.js workflow set --self-guard',
            orchestratorWorkRestartCommand: 'node bin/garda.js gate enter-task-mode --orchestrator-work'
        },
        workspaceReadiness: {
            ready: false,
            reason: 'Workspace scope changed.'
        },
        workspaceRefreshCommand: 'node bin/garda.js gate classify-change --task-id "T-1"',
        coherentCycleReadiness: {
            ready: false,
            reason: 'Coherent cycle is stale.'
        },
        navigatorCommand: 'node bin/garda.js next-step "T-1" --repo-root "."',
        postPreflightRulePack: {
            ready: false,
            reason: 'POST_PREFLIGHT evidence is missing.',
            stage: null,
            canBind: false,
            loadCommand: 'node bin/garda.js gate load-rule-pack --stage POST_PREFLIGHT',
            bindCommand: 'node bin/garda.js gate bind-rule-pack-to-preflight'
        },
        optionalSkillActivation: {
            skillId: 'node-backend',
            command: 'node bin/garda.js gate activate-optional-skill --skill-id node-backend'
        }
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'classify-change');
    assert.equal(route.commands[0]?.label, 'Refresh preflight');
    assert.match(route.reason, /older than task-mode evidence/);
});

test('resolvePendingOptionalSkillDecisionRoute preserves activation command contract', () => {
    const route = resolvePendingOptionalSkillDecisionRoute({
        skillId: 'node-backend',
        command: 'node bin/garda.js gate activate-optional-skill --skill-id "node-backend"'
    });

    assert.ok(route);
    assert.equal(route.nextGate, 'activate-optional-skill');
    assert.equal(route.commands[0]?.label, 'Activate optional skill node-backend');
    assert.match(route.reason, /current task cycle has no matching activation evidence/);
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
            recoverFailedLaunch: {
                label: 'Restart/supersede failed delegated reviewer launch',
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
