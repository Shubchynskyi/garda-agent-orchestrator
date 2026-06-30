import test from 'node:test';
import assert from 'node:assert/strict';

import {
    GARDA_LOW_NOISE_RUNTIME_WRITES_ENV,
    GARDA_RUNTIME_WRITES_MODE_ENV,
    isLowNoiseRuntimeWritesEnabled,
    resolveRuntimeWritesMode
} from '../../../src/gate-runtime/derived-runtime-writes';

test('resolveRuntimeWritesMode defaults to normal writes', () => {
    assert.equal(resolveRuntimeWritesMode({ env: {} }), 'normal');
    assert.equal(isLowNoiseRuntimeWritesEnabled({ env: {} }), false);
});

test('resolveRuntimeWritesMode accepts low-noise aliases and flags', () => {
    assert.equal(resolveRuntimeWritesMode({ runtimeWritesMode: 'low_noise', env: {} }), 'low-noise');
    assert.equal(resolveRuntimeWritesMode({ runtimeWritesMode: 'quiet', env: {} }), 'low-noise');
    assert.equal(resolveRuntimeWritesMode({ lowNoiseRuntimeWrites: true, env: {} }), 'low-noise');
    assert.equal(resolveRuntimeWritesMode({ env: { [GARDA_LOW_NOISE_RUNTIME_WRITES_ENV]: '1' } }), 'low-noise');
    assert.equal(resolveRuntimeWritesMode({ env: { [GARDA_RUNTIME_WRITES_MODE_ENV]: 'low-noise' } }), 'low-noise');
});

test('resolveRuntimeWritesMode lets explicit options override env flags', () => {
    assert.equal(
        resolveRuntimeWritesMode({
            runtimeWritesMode: 'normal',
            env: { [GARDA_LOW_NOISE_RUNTIME_WRITES_ENV]: '1' }
        }),
        'normal'
    );
    assert.equal(
        resolveRuntimeWritesMode({
            lowNoiseRuntimeWrites: false,
            env: { [GARDA_RUNTIME_WRITES_MODE_ENV]: 'low-noise' }
        }),
        'normal'
    );
});
