import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveNextStepStartupRoute,
    type NextStepStartupRouteOptions
} from '../../../../src/gates/next-step/next-step-startup-routing';

function baseOptions(overrides?: Partial<NextStepStartupRouteOptions>): NextStepStartupRouteOptions {
    return {
        enterTaskModePassed: true,
        defaultExecutionProvider: 'Codex',
        enterTaskModeCommand: 'node bin/garda.js gate enter-task-mode --task-id "T-1"',
        startupCycleReadiness: {
            ready: true,
            nextGate: 'none',
            title: 'ready',
            reason: 'ready'
        },
        loadRulePackPassed: true,
        rulePackStage: 'TASK_ENTRY',
        preflightExists: false,
        taskEntryRulePackCommand: 'node bin/garda.js gate load-rule-pack --task-id "T-1"',
        handshakeDiagnosticsPassed: true,
        handshakeDiagnosticsCommand: 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"',
        shellSmokePreflightPassed: true,
        shellSmokePreflightCommand: 'node bin/garda.js gate shell-smoke-preflight --task-id "T-1"',
        ...overrides
    };
}

test('resolveNextStepStartupRoute routes missing task mode before startup diagnostics', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        enterTaskModePassed: false,
        startupCycleReadiness: {
            ready: false,
            nextGate: 'load-rule-pack',
            title: 'Load rules',
            reason: 'rules missing'
        }
    }));

    assert.ok(route);
    assert.equal(route.status, 'BLOCKED');
    assert.equal(route.nextGate, 'enter-task-mode');
    assert.equal(route.commands[0].label, 'Enter task mode');
    assert.equal(route.commands[0].command, 'node bin/garda.js gate enter-task-mode --task-id "T-1"');
});

test('resolveNextStepStartupRoute delegates current startup cycle gate commands', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        startupCycleReadiness: {
            ready: false,
            nextGate: 'handshake-diagnostics',
            title: 'Run handshake diagnostics for the current task-mode cycle.',
            reason: 'handshake missing'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'handshake-diagnostics');
    assert.equal(route.title, 'Run handshake diagnostics for the current task-mode cycle.');
    assert.equal(route.reason, 'handshake missing');
    assert.equal(route.commands[0].label, 'Run handshake diagnostics');
    assert.equal(route.commands[0].command, 'node bin/garda.js gate handshake-diagnostics --task-id "T-1"');
});

test('resolveNextStepStartupRoute preserves legacy task-entry fallbacks after startup readiness', () => {
    const route = resolveNextStepStartupRoute(baseOptions({
        loadRulePackPassed: false
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'load-rule-pack');
    assert.equal(route.title, 'Record TASK_ENTRY rule files.');
    assert.equal(route.reason, 'Task execution must record the loaded core workflow rule pack before preflight.');
    assert.equal(route.commands[0].label, 'Load TASK_ENTRY rules');
});

test('resolveNextStepStartupRoute returns null after startup gates are satisfied', () => {
    assert.equal(resolveNextStepStartupRoute(baseOptions()), null);
});
