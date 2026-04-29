import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildOverviewOutput,
    printOverview
} from '../../../../src/cli/commands/overview';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

test('buildOverviewOutput includes GARDA_OVERVIEW marker', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('GARDA_OVERVIEW'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput includes GARDA_STATUS marker', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('GARDA_STATUS'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput includes Available Commands', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('Available Commands'));
        assert.ok(output.includes('setup'));
        assert.ok(output.includes('bootstrap'));
        assert.ok(output.includes('doctor'));
        assert.ok(output.includes('status'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput renders Available Commands exactly once', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        const matches = output.match(/Available Commands/g) || [];
        assert.equal(matches.length, 1);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput includes banner with version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '2.0.0', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('v2.0.0'));
        assert.ok(output.includes('GARDA AGENT ORCHESTRATOR'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput shows not-installed state for empty workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('Not installed'));
        assert.ok(output.includes('RecommendedNextCommand'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput shows bundle-present state', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    const bundlePath = path.join(tmpDir, DEFAULT_BUNDLE_NAME);
    fs.mkdirSync(bundlePath, { recursive: true });
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('[x] Installed'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput includes Workspace Stages section', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('Workspace Stages'));
        assert.ok(output.includes('Installed'));
        assert.ok(output.includes('Primary initialization'));
        assert.ok(output.includes('Agent initialization'));
        assert.ok(output.includes('Ready for task execution'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('buildOverviewOutput includes workspace overview title', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'overview-test-'));
    try {
        const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
        const output = buildOverviewOutput(pkg, tmpDir);
        assert.ok(output.includes('Workspace overview'));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
