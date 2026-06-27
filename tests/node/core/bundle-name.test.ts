import test from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_BUNDLE_NAME, resolveBundleName } from '../../../src/core/constants';

test('DEFAULT_BUNDLE_NAME is the expected constant', () => {
    assert.equal(DEFAULT_BUNDLE_NAME, 'garda-agent-orchestrator');
});

test('resolveBundleName returns default when no override and no env var', () => {
    assert.equal(resolveBundleName(), 'garda-agent-orchestrator');
});

test('resolveBundleName ignores explicit override', () => {
    assert.equal(resolveBundleName('my-bundle'), 'garda-agent-orchestrator');
});

test('resolveBundleName ignores GARDA_BUNDLE_NAME env var', () => {
    const saved = process.env.GARDA_BUNDLE_NAME;
    try {
        process.env.GARDA_BUNDLE_NAME = 'custom-bundle';
        assert.equal(resolveBundleName(), 'garda-agent-orchestrator');
    } finally {
        if (saved === undefined) {
            delete process.env.GARDA_BUNDLE_NAME;
        } else {
            process.env.GARDA_BUNDLE_NAME = saved;
        }
    }
});

test('resolveBundleName ignores whitespace-only override', () => {
    assert.equal(resolveBundleName('  '), 'garda-agent-orchestrator');
});

test('resolveBundleName does not use trimmed override as bundle name', () => {
    assert.equal(resolveBundleName('  custom-name  '), 'garda-agent-orchestrator');
});
