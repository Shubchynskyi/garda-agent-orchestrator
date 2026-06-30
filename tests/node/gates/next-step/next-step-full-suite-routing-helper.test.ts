import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveNextStepFullSuiteValidationRoute
} from '../../../../src/gates/next-step/next-step-full-suite-routing';

const BASE_OPTIONS = Object.freeze({
    enabled: true,
    placement: 'before_test_review' as const,
    notRequiredForCurrentScope: false,
    gateStatus: null,
    gatePassed: false,
    timeoutBlockerExhausted: false,
    timeoutRepairTaskProposal: null,
    timedOutRetryAvailable: false,
    transientRetryEvidenceAvailable: false,
    transientRetryEvidenceReason: null,
    configPath: 'garda-agent-orchestrator/live/config/workflow-config.json',
    commandText: 'npm test',
    timeoutForecastLine: 'Recommended full-suite command timeout: 240s.',
    command: 'node bin/garda.js gate full-suite-validation --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --repo-root "."',
    runMarkerRecoveryCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --repo-root "."',
    runMarkerCleanupCommand: 'node bin/garda.js gate full-suite-run-marker-recovery --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --clear-dead-marker --operator-confirmed yes --repo-root "."',
    timeoutRepairTaskCommand: 'node bin/garda.js gate materialize-full-suite-repair-task --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --full-suite-artifact-path "runtime/reviews/T-123-full-suite-validation.json" --repo-root "."',
    navigatorCommand: 'node bin/garda.js next-step "T-123" --repo-root "."',
    nextReviewType: 'test'
});

describe('next-step full-suite route helper', () => {
    it('routes after-compile placement before any reviewer launch', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Run full-suite validation after compile before reviews.');
        assert.match(route?.reason || '', /after compile-gate and before launching independent reviewers/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });

    it('routes before-test placement only when test is the next review lane', () => {
        const route = resolveNextStepFullSuiteValidationRoute(BASE_OPTIONS);

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Run full-suite validation before test review.');
        assert.match(route?.reason || '', /before launching the mandatory test reviewer/);
    });

    it('suppresses before-test full-suite routing while non-test review lanes remain launchable', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            nextReviewType: 'code'
        });

        assert.equal(route, null);
    });

    it('routes timed-out failures to a retry instead of implementation remediation', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            timedOutRetryAvailable: true
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Retry full-suite validation with updated timeout forecast.');
        assert.match(route?.reason || '', /recommends a longer timeout/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });

    it('routes exhausted timeout blockers to repair-task materialization before reviewers', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            timeoutBlockerExhausted: true,
            timeoutRepairTaskProposal: 'id=T-123-F1; title=Fix full-suite timeout blocker'
        });

        assert.equal(route?.nextGate, 'full-suite-timeout-repair-task');
        assert.match(route?.title || '', /repair task/i);
        assert.match(route?.reason || '', /exhausting the configured retry policy/);
        assert.match(route?.reason || '', /T-123-F1/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.timeoutRepairTaskCommand);
    });

    it('routes exhausted WARNED timeout blockers to repair-task materialization before reviewers', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            gateStatus: null,
            gatePassed: false,
            timeoutBlockerExhausted: true,
            timeoutRepairTaskProposal: 'id=T-123-F1; title=Fix full-suite timeout blocker'
        });

        assert.equal(route?.nextGate, 'full-suite-timeout-repair-task');
        assert.match(route?.reason || '', /T-123-F1/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.timeoutRepairTaskCommand);
    });

    it('prints a cleanup command only for dead interrupted markers without live descendants', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: false,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.commands[0]?.label, 'Clear dead full-suite run marker after preserving recovery evidence');
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerCleanupCommand);
    });

    it('routes interrupted missing evidence to recovery instead of a fresh not-yet-run prompt', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'node',
                descendantProcessCandidates: [
                    {
                        pid: 12347,
                        parentPid: 12346,
                        commandLine: 'node --test .node-build/tests/node/full-suite-child.test.js'
                    }
                ],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Recover interrupted full-suite validation run.');
        assert.match(route?.reason || '', /no terminal full-suite artifact was materialized/);
        assert.match(route?.reason || '', /child pid 12346 is still alive/);
        assert.match(route?.reason || '', /Live descendant candidates/);
        assert.match(route?.reason || '', /pid=12347/);
        assert.match(route?.reason || '', /Interrupted command: npm test/);
        assert.match(route?.reason || '', /Retry command: npm test/);
        assert.match(route?.reason || '', /terminate only task-owned processes/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('routes unresolved marker files to recovery instead of starting a fresh run', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            unresolvedRunMarkerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Inspect unresolved full-suite run marker state.');
        assert.match(route?.reason || '', /stale, invalid, malformed, or not bound/);
        assert.match(route?.reason || '', /would overwrite the diagnostic marker/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerRecoveryCommand);
    });

    it('routes active interrupted markers to wait instead of starting a duplicate full-suite run', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: true,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.equal(route?.title, 'Wait for active full-suite validation run.');
        assert.match(route?.reason || '', /Do not start a second full-suite run/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.navigatorCommand);
    });

    it('redacts secret-looking process and command text in interrupted recovery output', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            commandText: 'API_TOKEN=super-secret npm test',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'AUTH_TOKEN=interrupted-secret npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: true,
                childCommand: 'API_TOKEN=child-secret node',
                descendantProcessCandidates: [
                    {
                        pid: 12347,
                        parentPid: 12346,
                        commandLine: 'PASSWORD=worker-secret node --test'
                    }
                ],
                processScanWarning: null
            }
        });

        const reason = route?.reason || '';
        assert.doesNotMatch(reason, /super-secret|interrupted-secret|child-secret|worker-secret/);
        assert.match(reason, /<redacted>/);
    });

    it('keeps recovery conservative when no descendant process evidence is available', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            placement: 'after_compile_before_reviews',
            nextReviewType: 'code',
            interruptedRun: {
                markerPath: 'garda-agent-orchestrator/runtime/reviews/T-123-full-suite-run-marker.json',
                startedAtUtc: '2026-06-07T01:02:03.000Z',
                command: 'npm test',
                timeoutMs: 600000,
                gatePid: 12345,
                gateProcessAlive: false,
                childPid: 12346,
                childProcessAlive: false,
                childCommand: 'npm',
                descendantProcessCandidates: [],
                processScanWarning: null
            }
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.reason || '', /No live descendant process candidates/);
        assert.match(route?.reason || '', /do not kill generic node\.exe/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.runMarkerCleanupCommand);
    });

    it('routes non-timeout failures back to implementation via navigator', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL'
        });

        assert.equal(route?.nextGate, 'implementation');
        assert.match(route?.title || '', /Fix full-suite failures/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.navigatorCommand);
    });

    it('routes non-timeout failures to full-suite retry when focused transient evidence is present', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            transientRetryEvidenceAvailable: true,
            transientRetryEvidenceReason: 'Evidence: runtime/manual-validation/T-123/full-suite-retry-evidence.json; reason_kind=transient.'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.title || '', /focused transient evidence/);
        assert.match(route?.reason || '', /does not replace mandatory full-suite evidence/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });

    it('routes non-timeout failures to full-suite retry when targeted diagnostics passed afterward', () => {
        const route = resolveNextStepFullSuiteValidationRoute({
            ...BASE_OPTIONS,
            gateStatus: 'FAIL',
            targetedDiagnosticRetryAvailable: true,
            targetedDiagnosticRetryReason: 'Evidence: artifact=runtime/reviews/T-123-intermediate-command-targeted-test.json.'
        });

        assert.equal(route?.nextGate, 'full-suite-validation');
        assert.match(route?.title || '', /targeted diagnostics/);
        assert.match(route?.reason || '', /do not replace mandatory full-suite evidence/);
        assert.match(route?.reason || '', /full-suite-retry-evidence\.json/);
        assert.equal(route?.commands[0]?.command, BASE_OPTIONS.command);
    });
});
