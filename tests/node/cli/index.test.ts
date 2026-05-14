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
        'preprompt',
        'next-step',
        'status',
        'doctor',
        'debug',
        'stats',
        'task',
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
        'repair',
        'gc',
        'clean',
        'skills',
        'review-capabilities',
        'templates',
        'profile',
        'workflow',
        'diff-managed'
    ]);
});
