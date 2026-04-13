import test from 'node:test';
import assert from 'node:assert/strict';

import {
    getBaseRequiredPaths,
    BASE_REQUIRED_PATHS,
    getBundlePath,
    buildRequiredPaths
} from '../../../src/validators/workspace-layout';

test('getBaseRequiredPaths returns paths using the given bundle name', () => {
    const paths = getBaseRequiredPaths('my-orchestrator');
    assert.ok(paths.length > 25);
    assert.ok(paths.includes('TASK.md'));
    assert.ok(paths.includes('my-orchestrator/VERSION'));
    assert.ok(paths.includes('my-orchestrator/bin/garda.js'));
    assert.ok(paths.includes('my-orchestrator/live/config/review-capabilities.json'));
    // Must not contain the default bundle name
    for (const p of paths) {
        if (p === 'TASK.md') continue;
        assert.ok(p.startsWith('my-orchestrator/'), `Expected "${p}" to start with "my-orchestrator/"`);
    }
});

test('BASE_REQUIRED_PATHS is backwards compatible with default bundle name', () => {
    assert.ok(Array.isArray(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.length > 25);
    assert.ok(Object.isFrozen(BASE_REQUIRED_PATHS));
    assert.ok(BASE_REQUIRED_PATHS.includes('garda-agent-orchestrator/src'));
});

test('getBundlePath uses default bundle name when no override', () => {
    const saved = process.env.GARDA_BUNDLE_NAME;
    delete process.env.GARDA_BUNDLE_NAME;
    try {
        const result = getBundlePath('/projects/my-app');
        assert.ok(result.includes('garda-agent-orchestrator'));
    } finally {
        if (saved !== undefined) process.env.GARDA_BUNDLE_NAME = saved;
    }
});

test('getBundlePath uses custom bundle name when provided', () => {
    const result = getBundlePath('/projects/my-app', 'custom-bundle');
    assert.ok(result.endsWith('custom-bundle'));
    assert.ok(!result.includes('garda-agent-orchestrator'));
});

test('buildRequiredPaths respects custom bundleName option', () => {
    const paths = buildRequiredPaths({ bundleName: 'alt-orchestrator' });
    assert.ok(paths.some(p => p.startsWith('alt-orchestrator/')));
    assert.ok(!paths.some(p => p.startsWith('garda-agent-orchestrator/')));
    assert.ok(paths.some(p => p.includes('00-core.md')));
});
