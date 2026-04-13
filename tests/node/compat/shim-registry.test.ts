import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GATE_COMMANDS,
    getAllShimmedGateNames
} from '../../../src/compat/shim-registry';

// ---------------------------------------------------------------------------
// GATE_COMMANDS – structural checks
// ---------------------------------------------------------------------------

test('GATE_COMMANDS is a frozen array', () => {
    assert.equal(Object.isFrozen(GATE_COMMANDS), true);
    assert.ok(Array.isArray(GATE_COMMANDS));
});

test('GATE_COMMANDS is non-empty and contains only kebab-case strings', () => {
    assert.ok(GATE_COMMANDS.length > 0);
    for (const name of GATE_COMMANDS) {
        assert.equal(typeof name, 'string');
        assert.match(name, /^[a-z][a-z0-9-]*$/, `${name} must be kebab-case`);
    }
});

test('GATE_COMMANDS includes representative well-known gate names', () => {
    assert.ok(GATE_COMMANDS.includes('validate-manifest'));
    assert.ok(GATE_COMMANDS.includes('enter-task-mode'));
    assert.ok(GATE_COMMANDS.includes('load-rule-pack'));
    assert.ok(GATE_COMMANDS.includes('compile-gate'));
    assert.ok(GATE_COMMANDS.includes('completion-gate'));
    assert.ok(GATE_COMMANDS.includes('log-task-event'));
    assert.ok(GATE_COMMANDS.includes('human-commit'));
});

test('GATE_COMMANDS has no duplicates', () => {
    const unique = new Set(GATE_COMMANDS);
    assert.equal(unique.size, GATE_COMMANDS.length);
});

// ---------------------------------------------------------------------------
// getAllShimmedGateNames – behaviour
// ---------------------------------------------------------------------------

test('getAllShimmedGateNames returns an array equal to GATE_COMMANDS', () => {
    assert.deepEqual(getAllShimmedGateNames(), [...GATE_COMMANDS]);
});

test('getAllShimmedGateNames returns a new copy each time (not the same reference)', () => {
    const a = getAllShimmedGateNames();
    const b = getAllShimmedGateNames();
    assert.notEqual(a, b);
    assert.deepEqual(a, b);
});

test('mutating the returned array does not affect GATE_COMMANDS', () => {
    const copy = getAllShimmedGateNames();
    copy.push('fake-gate');
    assert.ok(!GATE_COMMANDS.includes('fake-gate'));
    assert.equal(GATE_COMMANDS.length, copy.length - 1);
});
