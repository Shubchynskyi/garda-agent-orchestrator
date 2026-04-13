import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
    collectDebugEnvSnapshot,
    formatDebugEnvText,
    formatDebugEnvJson,
    type DebugEnvSnapshot
} from '../../../../src/cli/commands/debug-env';

import { DEFAULT_BUNDLE_NAME } from '../../../../src/core/constants';

// ---------------------------------------------------------------------------
// collectDebugEnvSnapshot
// ---------------------------------------------------------------------------

test('collectDebugEnvSnapshot returns expected shape for empty target root', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-env-test-'));
    try {
        const snapshot = collectDebugEnvSnapshot(tmpDir, '2.0.0');
        assert.equal(snapshot.cli_version, '2.0.0');
        assert.equal(snapshot.node_version, process.version);
        assert.equal(snapshot.platform, process.platform);
        assert.equal(snapshot.arch, process.arch);
        assert.equal(typeof snapshot.os_release, 'string');
        assert.equal(typeof snapshot.cpus, 'number');
        assert.ok(snapshot.cpus >= 1);
        assert.equal(typeof snapshot.total_memory_mb, 'number');
        assert.ok(snapshot.total_memory_mb > 0);
        assert.equal(snapshot.bundle_present, false);
        assert.equal(snapshot.live_version, null);
        assert.equal(typeof snapshot.env, 'object');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDebugEnvSnapshot detects bundle when present', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-env-test-'));
    try {
        const bundleDir = path.join(tmpDir, DEFAULT_BUNDLE_NAME, 'live');
        fs.mkdirSync(bundleDir, { recursive: true });
        fs.writeFileSync(
            path.join(bundleDir, 'version.json'),
            JSON.stringify({ version: '1.2.3' })
        );
        const snapshot = collectDebugEnvSnapshot(tmpDir, '2.0.0');
        assert.equal(snapshot.bundle_present, true);
        assert.equal(snapshot.live_version, '1.2.3');
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDebugEnvSnapshot handles missing version.json gracefully', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-env-test-'));
    try {
        fs.mkdirSync(path.join(tmpDir, DEFAULT_BUNDLE_NAME), { recursive: true });
        const snapshot = collectDebugEnvSnapshot(tmpDir, '2.0.0');
        assert.equal(snapshot.bundle_present, true);
        assert.equal(snapshot.live_version, null);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDebugEnvSnapshot redacts hostname', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-env-test-'));
    try {
        const snapshot = collectDebugEnvSnapshot(tmpDir, '1.0.0');
        // Hostname should be redacted to <host-XXXXXXXX> pattern or null
        if (snapshot.hostname !== null) {
            assert.match(snapshot.hostname, /^<host-[a-f0-9]{8}>$/);
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('collectDebugEnvSnapshot filters env to triage keys only', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'debug-env-test-'));
    // Inject a non-allowlisted env var to prove it is excluded
    const savedValue = process.env.DEBUG_ENV_TEST_SENTINEL;
    process.env.DEBUG_ENV_TEST_SENTINEL = 'should_not_appear';
    try {
        const snapshot = collectDebugEnvSnapshot(tmpDir, '1.0.0');
        const envKeys = Object.keys(snapshot.env);
        const allowedKeys = new Set([
            'NODE_ENV', 'CI', 'GITHUB_ACTIONS', 'TERM', 'SHELL', 'COMSPEC',
            'NO_COLOR', 'FORCE_COLOR', 'LANG', 'LC_ALL', 'TERM_PROGRAM', 'EDITOR'
        ]);
        for (const key of envKeys) {
            assert.ok(allowedKeys.has(key), `Unexpected env key: ${key}`);
        }
        assert.ok(!('DEBUG_ENV_TEST_SENTINEL' in snapshot.env), 'Non-allowlisted key leaked into snapshot');
    } finally {
        if (savedValue === undefined) {
            delete process.env.DEBUG_ENV_TEST_SENTINEL;
        } else {
            process.env.DEBUG_ENV_TEST_SENTINEL = savedValue;
        }
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

// ---------------------------------------------------------------------------
// formatDebugEnvText
// ---------------------------------------------------------------------------

test('formatDebugEnvText starts with GARDA_DEBUG_ENV marker', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '2.0.0',
        node_version: 'v20.0.0',
        platform: 'linux',
        arch: 'x64',
        os_release: '5.15.0',
        hostname: '<host-abcd1234>',
        cpus: 4,
        total_memory_mb: 8192,
        shell: '/bin/bash',
        cwd: '/home/user/project',
        bundle_present: true,
        bundle_path: 'garda-agent-orchestrator',
        live_version: '1.0.0',
        env: { CI: 'true', NODE_ENV: 'test' }
    };
    const output = formatDebugEnvText(snapshot);
    assert.ok(output.startsWith('GARDA_DEBUG_ENV'));
});

test('formatDebugEnvText includes all key fields', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '2.3.0',
        node_version: 'v20.10.0',
        platform: 'win32',
        arch: 'x64',
        os_release: '10.0.22621',
        hostname: '<host-12345678>',
        cpus: 8,
        total_memory_mb: 16384,
        shell: 'C:\\Windows\\System32\\cmd.exe',
        cwd: '.',
        bundle_present: false,
        bundle_path: 'garda-agent-orchestrator',
        live_version: null,
        env: {}
    };
    const output = formatDebugEnvText(snapshot);
    assert.ok(output.includes('CLI version:    2.3.0'));
    assert.ok(output.includes('Node version:   v20.10.0'));
    assert.ok(output.includes('Platform:       win32'));
    assert.ok(output.includes('Arch:           x64'));
    assert.ok(output.includes('Bundle present: false'));
    assert.ok(output.includes('Live version:   (not found)'));
});

test('formatDebugEnvText shows env vars when present', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '1.0.0',
        node_version: 'v20.0.0',
        platform: 'linux',
        arch: 'x64',
        os_release: '5.15.0',
        hostname: null,
        cpus: 2,
        total_memory_mb: 4096,
        shell: null,
        cwd: '.',
        bundle_present: false,
        bundle_path: 'garda-agent-orchestrator',
        live_version: null,
        env: { CI: 'true', TERM: 'xterm-256color' }
    };
    const output = formatDebugEnvText(snapshot);
    assert.ok(output.includes('Environment:'));
    assert.ok(output.includes('  CI=true'));
    assert.ok(output.includes('  TERM=xterm-256color'));
});

test('formatDebugEnvText shows placeholder when no env keys set', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '1.0.0',
        node_version: 'v20.0.0',
        platform: 'linux',
        arch: 'x64',
        os_release: '5.15.0',
        hostname: null,
        cpus: 2,
        total_memory_mb: 4096,
        shell: null,
        cwd: '.',
        bundle_present: false,
        bundle_path: 'garda-agent-orchestrator',
        live_version: null,
        env: {}
    };
    const output = formatDebugEnvText(snapshot);
    assert.ok(output.includes('(none of the triage keys are set)'));
});

// ---------------------------------------------------------------------------
// formatDebugEnvJson
// ---------------------------------------------------------------------------

test('formatDebugEnvJson returns valid JSON', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '2.0.0',
        node_version: 'v20.0.0',
        platform: 'linux',
        arch: 'x64',
        os_release: '5.15.0',
        hostname: '<host-abcd1234>',
        cpus: 4,
        total_memory_mb: 8192,
        shell: '/bin/bash',
        cwd: '.',
        bundle_present: true,
        bundle_path: 'garda-agent-orchestrator',
        live_version: '1.0.0',
        env: { CI: 'true' }
    };
    const json = formatDebugEnvJson(snapshot);
    const parsed = JSON.parse(json);
    assert.equal(parsed.cli_version, '2.0.0');
    assert.equal(parsed.bundle_present, true);
    assert.equal(parsed.env.CI, 'true');
});

test('formatDebugEnvJson roundtrips all fields', () => {
    const snapshot: DebugEnvSnapshot = {
        cli_version: '3.0.0',
        node_version: 'v22.0.0',
        platform: 'darwin',
        arch: 'arm64',
        os_release: '23.0.0',
        hostname: null,
        cpus: 10,
        total_memory_mb: 32768,
        shell: '/bin/zsh',
        cwd: '/tmp/test',
        bundle_present: false,
        bundle_path: '/tmp/test/garda-agent-orchestrator',
        live_version: null,
        env: {}
    };
    const json = formatDebugEnvJson(snapshot);
    const parsed = JSON.parse(json);
    assert.deepEqual(parsed, snapshot);
});
