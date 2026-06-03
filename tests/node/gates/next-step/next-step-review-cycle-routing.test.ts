import test from 'node:test';
import assert from 'node:assert/strict';

import {
    resolveReviewLaunchableLanePreparationRoute,
    type NextStepReviewLaunchableLanePreparationOptions
} from '../../../../src/gates/next-step/next-step-review-cycle-routing';

function baseOptions(
    overrides?: Partial<NextStepReviewLaunchableLanePreparationOptions>
): NextStepReviewLaunchableLanePreparationOptions {
    return {
        reviewPolicyMode: 'strict_sequential',
        reviewType: 'test',
        dependencies: [],
        dependencyDetails: '',
        reviewerReadinessChain: 'ReviewerReadiness: current',
        reviewContextChain: 'GateChain: compile-to-review-context',
        scopedDiffReadiness: {
            ready: true,
            reason: 'Scoped diff metadata is current.'
        },
        stateExists: true,
        contextExists: true,
        contextCurrent: true,
        contextDetailsSuffix: '',
        commands: {
            finishUpstreamReview: {
                label: 'Finish upstream review first',
                command: 'node bin/garda.js next-step "T-1" --repo-root "."'
            },
            buildScopedDiff: {
                label: 'Build scoped diff',
                command: 'node bin/garda.js gate build-scoped-diff --review-type test'
            },
            buildReviewContext: {
                label: 'Build review context',
                command: 'node bin/garda.js gate build-review-context --review-type test'
            }
        },
        ...overrides
    };
}

test('resolveReviewLaunchableLanePreparationRoute blocks launchable lane on upstream dependencies first', () => {
    const route = resolveReviewLaunchableLanePreparationRoute(baseOptions({
        dependencies: ['code'],
        dependencyDetails: 'code has no current PASS artifact and receipt',
        stateExists: false,
        contextExists: false,
        contextCurrent: false,
        scopedDiffReadiness: {
            ready: false,
            reason: 'Scoped diff metadata is missing.'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'build-review-context');
    assert.equal(route.title, "Review 'test' is waiting for upstream review evidence.");
    assert.equal(route.commands[0].label, 'Finish upstream review first');
    assert.match(route.reason, /code has no current PASS artifact/);
});

test('resolveReviewLaunchableLanePreparationRoute requires scoped diff before missing review context', () => {
    const route = resolveReviewLaunchableLanePreparationRoute(baseOptions({
        stateExists: false,
        contextExists: false,
        contextCurrent: false,
        scopedDiffReadiness: {
            ready: false,
            reason: 'Scoped diff metadata is stale for the current preflight.'
        }
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'build-scoped-diff');
    assert.equal(route.commands[0].label, 'Build scoped diff');
    assert.match(route.reason, /must include scoped diff metadata/);
});

test('resolveReviewLaunchableLanePreparationRoute rebuilds stale review context with violation details', () => {
    const route = resolveReviewLaunchableLanePreparationRoute(baseOptions({
        contextCurrent: false,
        contextDetailsSuffix: ' review context preflight hash mismatch'
    }));

    assert.ok(route);
    assert.equal(route.nextGate, 'build-review-context');
    assert.equal(route.commands[0].label, 'Build review context');
    assert.match(route.reason, /review-context artifact is stale/);
    assert.match(route.reason, /preflight hash mismatch/);
});

test('resolveReviewLaunchableLanePreparationRoute returns null when lane preparation evidence is current', () => {
    assert.equal(resolveReviewLaunchableLanePreparationRoute(baseOptions()), null);
});
