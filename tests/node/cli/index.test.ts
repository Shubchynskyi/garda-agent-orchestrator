import test from 'node:test';
import assert from 'node:assert/strict';

import { describeFoundation } from '../../../src/cli/index';

test('describeFoundation exposes the staged Node-only runtime', () => {
    const foundation = describeFoundation();

    assert.equal(foundation.activeCliEntrypoint, 'bin/garda.js');
    assert.equal(foundation.nodeBaseline, '>=24.0.0');
    assert.equal(foundation.nodeBaselineLabel, 'Node 24 LTS');
    assert.equal(foundation.runtimeMode, 'node-only-router');
    assert.deepEqual(foundation.lifecycleCommands, [
        'setup',
        'agent-init',
        'status',
        'doctor',
        'debug',
        'stats',
        'bootstrap',
        'install',
        'init',
        'reinit',
        'verify',
        'check-update',
        'uninstall',
        'update',
        'rollback',
        'cleanup',
        'gc',
        'clean',
        'skills',
        'profile',
        'diff-managed'
    ]);
});
