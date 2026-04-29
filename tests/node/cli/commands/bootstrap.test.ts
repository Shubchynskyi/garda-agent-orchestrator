import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    BOOTSTRAP_DEFINITIONS,
    buildBootstrapSuccessOutput,
    handleBootstrap
} from '../../../../src/cli/commands/bootstrap';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

function findRepoRoot(startDir: string): string {
    let current = path.resolve(startDir);
    while (true) {
        const packageJsonPath = path.join(current, 'package.json');
        const cliPath = path.join(current, 'bin', 'garda.js');
        if (fs.existsSync(packageJsonPath) && fs.existsSync(cliPath)) {
            return current;
        }

        const parent = path.dirname(current);
        if (parent === current) {
            throw new Error(`Could not resolve repository root from: ${startDir}`);
        }
        current = parent;
    }
}

test('BOOTSTRAP_DEFINITIONS includes expected flags', () => {
    assert.ok(BOOTSTRAP_DEFINITIONS['--destination']);
    assert.ok(BOOTSTRAP_DEFINITIONS['--target']);
    assert.equal(BOOTSTRAP_DEFINITIONS['--target'].key, 'destination');
    assert.ok(BOOTSTRAP_DEFINITIONS['--repo-url']);
    assert.ok(BOOTSTRAP_DEFINITIONS['--branch']);
});

test('buildBootstrapSuccessOutput includes GARDA_BOOTSTRAP_OK marker', () => {
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', '/workspace/garda-agent-orchestrator');
    assert.ok(output.includes('GARDA_BOOTSTRAP_OK'));
});

test('buildBootstrapSuccessOutput includes version info', () => {
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', '/workspace/garda-agent-orchestrator');
    assert.ok(output.includes('PackageVersion: 1.0.8'));
    assert.ok(output.includes('BundleVersion: 1.0.8'));
});

test('buildBootstrapSuccessOutput includes paths', () => {
    const dest = path.join('/workspace', DEFAULT_BUNDLE_NAME);
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', dest);
    assert.ok(output.includes('BundlePath:'));
    assert.ok(output.includes('TargetRoot:'));
    assert.ok(output.includes('InitPromptPath:'));
    assert.ok(output.includes('InitAnswersPath:'));
});

test('buildBootstrapSuccessOutput includes next steps', () => {
    const dest = path.join('/workspace', DEFAULT_BUNDLE_NAME);
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', dest);
    assert.ok(output.includes('NextSteps:'));
    assert.ok(output.includes('1. Give your agent'));
    assert.ok(output.includes('2. Let the agent write'));
    assert.ok(output.includes('AGENT_INIT_PROMPT.md'));
});

test('buildBootstrapSuccessOutput uses npx for default bundle name', () => {
    const dest = path.join('/workspace', DEFAULT_BUNDLE_NAME);
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', dest);
    assert.ok(output.includes('npx'));
    assert.ok(output.includes('install'));
});

test('buildBootstrapSuccessOutput uses Node CLI for custom bundle paths', () => {
    const dest = path.join('/workspace', 'custom-bundle');
    const pkg = { version: '1.0.8', name: 'garda-agent-orchestrator' };
    const output = buildBootstrapSuccessOutput(pkg, '1.0.8', dest);
    assert.ok(output.includes('Custom bundle paths should still use the Node CLI'));
    assert.ok(output.includes('node'));
    assert.ok(output.includes('garda.js'));
    assert.ok(output.includes('install'));
    assert.ok(output.includes('node'));
    assert.ok(output.includes('Qwen'));
});

test('handleBootstrap deploys bundle to destination', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-integ-'));
    try {
        const repoRoot = findRepoRoot(__dirname);
        const dest = path.join(tmpDir, DEFAULT_BUNDLE_NAME);
        const originalLog = console.log;
        const lines: string[] = [];
        console.log = (...items: unknown[]) => {
            lines.push(items.join(' '));
        };

        try {
            await handleBootstrap(['--destination', dest], { version: '1.0.8', name: 'garda-agent-orchestrator' }, repoRoot);
        } finally {
            console.log = originalLog;
        }

        assert.ok(fs.existsSync(dest), 'Bundle directory should exist');
        assert.ok(fs.existsSync(path.join(dest, 'VERSION')), 'VERSION file should exist');
        assert.ok(fs.existsSync(path.join(dest, 'package.json')), 'package.json should exist');
        assert.ok(fs.existsSync(path.join(dest, 'bin', 'garda.js')), 'bin/garda.js should exist');
        assert.ok(fs.existsSync(path.join(dest, 'bin', 'garda.js')), 'legacy bin/garda.js should exist');
        assert.ok(!fs.existsSync(path.join(dest, 'scripts')), 'scripts directory should not exist');
        assert.ok(lines.some((line) => line.includes('GARDA_BOOTSTRAP_OK')), 'Should print GARDA_BOOTSTRAP_OK');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handleBootstrap uses positional as destination fallback', async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bootstrap-integ-'));
    try {
        const repoRoot = findRepoRoot(__dirname);
        const dest = path.join(tmpDir, 'my-bundle');

        const originalLog = console.log;
        const lines: string[] = [];
        console.log = (...items: unknown[]) => { lines.push(items.join(' ')); };
        try {
            await handleBootstrap([dest], { version: '1.0.8', name: 'garda-agent-orchestrator' }, repoRoot);
        } finally {
            console.log = originalLog;
        }

        assert.ok(fs.existsSync(dest), 'Bundle directory should exist');
        assert.ok(lines.some((line) => line.includes('GARDA_BOOTSTRAP_OK')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('handleBootstrap prints help on --help flag', async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => { lines.push(items.join(' ')); };
    try {
        await handleBootstrap(['--help'], { version: '1.0.8', name: 'garda-agent-orchestrator' }, '/tmp');
    } finally {
        console.log = originalLog;
    }
    assert.ok(lines.some((line) => line.includes('Garda Agent Orchestrator CLI')));
});

test('handleBootstrap prints version on --version flag', async () => {
    const originalLog = console.log;
    const lines: string[] = [];
    console.log = (...items: unknown[]) => { lines.push(items.join(' ')); };
    try {
        await handleBootstrap(['--version'], { version: '1.0.8', name: 'garda-agent-orchestrator' }, '/tmp');
    } finally {
        console.log = originalLog;
    }
    assert.ok(lines.some((line) => line === '1.0.8'));
});
