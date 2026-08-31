import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getActiveTaskLifecycleGateIds,
    isTaskLifecycleConditionActive,
    resolveFirstActiveTaskLifecycleGate
} from '../../../src/runtime/task-lifecycle-phase-runtime';

test('runtime projects manifest gate order and predicate-controlled phases', () => {
    assert.deepEqual(getActiveTaskLifecycleGateIds('validation', {
        changes_exist: true,
        optional_quality_checks_enabled: false,
        full_suite_after_compile_before_reviews: true
    }), ['compile-gate', 'full-suite-validation']);
    assert.deepEqual(getActiveTaskLifecycleGateIds('validation', {
        changes_exist: false,
        optional_quality_checks_enabled: true,
        full_suite_after_compile_before_reviews: true
    }), []);
    assert.deepEqual(getActiveTaskLifecycleGateIds('closeout', {
        review_gate_required: true,
        full_suite_before_completion: false,
        project_memory_impact_required: true
    }), ['required-reviews-check', 'project-memory-impact', 'doc-impact-gate']);
});

test('runtime condition evaluation is fail-closed for absent predicate values', () => {
    assert.equal(isTaskLifecycleConditionActive({ kind: 'always' }, {}), true);
    assert.equal(isTaskLifecycleConditionActive({
        kind: 'predicate',
        predicate_id: 'reviews_required'
    }, {}), false);
});

test('runtime resolves the first pending gate and rejects unmapped active gates', () => {
    const visits: string[] = [];
    const route = resolveFirstActiveTaskLifecycleGate(
        ['compile-gate', 'full-suite-validation'],
        {
            'compile-gate': () => {
                visits.push('compile-gate');
                return null;
            },
            'full-suite-validation': () => {
                visits.push('full-suite-validation');
                return 'run-full-suite';
            }
        }
    );
    assert.equal(route, 'run-full-suite');
    assert.deepEqual(visits, ['compile-gate', 'full-suite-validation']);
    assert.throws(
        () => resolveFirstActiveTaskLifecycleGate(['unknown-gate'], {}),
        /No runtime resolver is registered/u
    );
});
