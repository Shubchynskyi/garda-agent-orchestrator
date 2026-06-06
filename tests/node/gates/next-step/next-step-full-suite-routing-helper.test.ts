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
    timedOutRetryAvailable: false,
    transientRetryEvidenceAvailable: false,
    transientRetryEvidenceReason: null,
    configPath: 'garda-agent-orchestrator/live/config/workflow-config.json',
    commandText: 'npm test',
    timeoutForecastLine: 'Recommended full-suite command timeout: 240s.',
    command: 'node bin/garda.js gate full-suite-validation --task-id "T-123" --preflight-path "runtime/reviews/T-123-preflight.json" --repo-root "."',
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
});
