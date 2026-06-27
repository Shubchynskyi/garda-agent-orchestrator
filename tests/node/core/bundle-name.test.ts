import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    buildBundleRelativePath,
    buildTargetBundleRelativePath,
    DEFAULT_BUNDLE_NAME,
    resolveBundleName,
    resolveBundleRootForTarget
} from '../../../src/core/constants';

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

test('buildBundleRelativePath normalizes separators and leading roots', () => {
    assert.equal(buildBundleRelativePath('runtime\\reviews\\T-1.json'), 'garda-agent-orchestrator/runtime/reviews/T-1.json');
    assert.equal(buildBundleRelativePath('./live/config/workflow-config.json'), 'garda-agent-orchestrator/live/config/workflow-config.json');
    assert.equal(buildBundleRelativePath('/runtime/task-events/T-1.jsonl'), 'garda-agent-orchestrator/runtime/task-events/T-1.jsonl');
});

test('target bundle helpers use the supported fixed deployed bundle directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'garda-bundle-helper-'));
    const bundleRoot = path.join(tmpDir, DEFAULT_BUNDLE_NAME);
    fs.mkdirSync(path.join(bundleRoot, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '1.0.0\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'package.json'), '{"name":"garda-agent-orchestrator"}\n', 'utf8');
    fs.writeFileSync(path.join(bundleRoot, 'bin', 'garda.js'), '', 'utf8');

    assert.equal(resolveBundleRootForTarget(tmpDir), bundleRoot);
    assert.equal(
        buildTargetBundleRelativePath(tmpDir, 'runtime/reviews/T-1-preflight.json'),
        'garda-agent-orchestrator/runtime/reviews/T-1-preflight.json'
    );
});
