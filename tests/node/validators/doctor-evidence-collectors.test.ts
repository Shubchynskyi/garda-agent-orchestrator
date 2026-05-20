import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    checkRuntimeMismatch,
    nodeVersionSatisfiesRange,
    checkPermissions,
    checkPartialState,
    checkRollbackHealth,
    checkProfileHealth
} from '../../../src/validators/doctor';
import {
    writeUpdateSentinel,
    writeUninstallSentinel
} from '../../../src/lifecycle/common';
import {
    getRollbackSnapshotsRoot
} from '../../../src/lifecycle/rollback';
import { NODE_ENGINE_RANGE } from '../../../src/core/constants';


test('checkRuntimeMismatch passes for current Node.js version', () => {
    const result = checkRuntimeMismatch();
    assert.equal(result.passed, true);
    assert.equal(result.current_node_version, process.version);
    assert.equal(result.required_range, NODE_ENGINE_RANGE);
    assert.equal(result.violations.length, 0);
});

test('checkRuntimeMismatch evidence includes expected fields', () => {
    const result = checkRuntimeMismatch();
    assert.ok(typeof result.passed === 'boolean');
    assert.ok(typeof result.current_node_version === 'string');
    assert.ok(typeof result.required_range === 'string');
    assert.ok(Array.isArray(result.violations));
    assert.ok(Array.isArray(result.warnings));
});

test('checkRuntimeMismatch warns without failing for unsupported Node versions', () => {
    const originalDescriptor = Object.getOwnPropertyDescriptor(process, 'version');
    try {
        Object.defineProperty(process, 'version', {
            value: 'v23.0.0',
            configurable: true
        });

        const result = checkRuntimeMismatch();

        assert.equal(result.passed, true);
        assert.equal(result.violations.length, 0);
        assert.equal(result.warnings?.length, 1);
        assert.ok(result.warnings?.[0].includes('outside the tested support matrix'));
    } finally {
        if (originalDescriptor) {
            Object.defineProperty(process, 'version', originalDescriptor);
        }
    }
});

test('checkRuntimeMismatch fails closed when the current Node version cannot be parsed', () => {
    const result = checkRuntimeMismatch({ currentVersion: 'not-a-node-version' });

    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0], 'Unable to parse current Node.js version: not-a-node-version');
    assert.equal(result.warnings?.length, 0);
});

test('checkRuntimeMismatch fails closed when the engine range cannot be parsed', () => {
    const result = checkRuntimeMismatch({
        currentVersion: 'v24.11.1',
        requiredRange: 'not-a-supported-range'
    });

    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0], 'Unable to parse engine range: not-a-supported-range');
    assert.equal(result.warnings?.length, 0);
});

test('checkRuntimeMismatch fails closed when the engine range is only partially parseable', () => {
    const result = checkRuntimeMismatch({
        currentVersion: 'v24.11.1',
        requiredRange: '^22.13.0 || not-a-supported-range || >=24.0.0'
    });

    assert.equal(result.passed, false);
    assert.equal(result.violations.length, 1);
    assert.equal(result.violations[0], 'Unable to parse engine range: ^22.13.0 || not-a-supported-range || >=24.0.0');
    assert.equal(result.warnings?.length, 0);
});

test('nodeVersionSatisfiesRange identifies Node 22.13+ and Node 24+ as the tested support matrix', () => {
    const supportedRange = '^22.13.0 || >=24.0.0';

    assert.equal(nodeVersionSatisfiesRange('v22.13.0', supportedRange), true);
    assert.equal(nodeVersionSatisfiesRange('v22.19.1', supportedRange), true);
    assert.equal(nodeVersionSatisfiesRange('v24.0.0', supportedRange), true);
    assert.equal(nodeVersionSatisfiesRange('v26.0.0', supportedRange), true);
    assert.equal(nodeVersionSatisfiesRange('v22.12.0', supportedRange), false);
    assert.equal(nodeVersionSatisfiesRange('v23.0.0', supportedRange), false);
    assert.equal(nodeVersionSatisfiesRange('v20.19.0', supportedRange), false);
});

test('nodeVersionSatisfiesRange fails closed for trailing comparator garbage', () => {
    assert.equal(nodeVersionSatisfiesRange('v24.0.0', '>=22.13.0 <bad'), null);
});


test('checkPermissions passes for accessible workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-perm-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });
    fs.mkdirSync(path.join(bundlePath, 'live', 'config'), { recursive: true });
    fs.writeFileSync(path.join(bundlePath, 'VERSION'), '1.0.0\n', 'utf8');
    fs.writeFileSync(path.join(bundlePath, 'MANIFEST.md'), '- bin/garda.js\n', 'utf8');

    try {
        const result = checkPermissions(tmpDir);
        assert.equal(result.passed, true);
        assert.ok(result.checks.length > 0);
        for (const check of result.checks) {
            if (check.exists) {
                assert.equal(check.accessible, true, check.path + ' should be accessible');
            }
        }
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPermissions reports when critical paths do not exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-perm-empty-'));
    try {
        const result = checkPermissions(tmpDir);
        assert.ok(typeof result.passed === 'boolean');
        assert.ok(result.checks.length > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


test('checkPartialState passes for clean workspace', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-clean-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.update_sentinel, null);
        assert.equal(result.uninstall_sentinel, null);
        assert.equal(result.lifecycle_lock_exists, false);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects interrupted update sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-update-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    writeUpdateSentinel(bundlePath, {
        startedAt: '2026-04-01T10:00:00.000Z',
        fromVersion: '2.3.0',
        toVersion: '2.4.0'
    });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.update_sentinel !== null);
        assert.equal(result.update_sentinel!.fromVersion, '2.3.0');
        assert.ok(result.violations.some(function (v) { return v.includes('Interrupted update'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects interrupted uninstall sentinel', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-uninstall-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'runtime'), { recursive: true });

    writeUninstallSentinel(tmpDir, {
        startedAt: '2026-04-01T11:00:00.000Z',
        operation: 'uninstall'
    });

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.uninstall_sentinel !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('Interrupted uninstall'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkPartialState detects stale lifecycle operation lock', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-partial-lock-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const lockPath = path.join(bundlePath, 'runtime', '.lifecycle-operation.lock');
    fs.mkdirSync(lockPath, { recursive: true });
    fs.writeFileSync(path.join(lockPath, 'owner.json'), JSON.stringify({
        pid: 999999,
        hostname: os.hostname(),
        operation: 'update',
        acquired_at_utc: '2026-04-01T10:00:00.000Z',
        target_root: tmpDir
    }, null, 2), 'utf8');

    try {
        const result = checkPartialState(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.lifecycle_lock_exists, true);
        assert.ok(result.lifecycle_lock_owner !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('Lifecycle operation lock'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


test('checkRollbackHealth passes for empty rollback directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-empty-'));
    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.snapshot_count, 0);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth passes for valid snapshot with records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-valid-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        JSON.stringify([{ relativePath: 'some/file.txt', existed: true, pathType: 'file' }]),
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.snapshot_count, 1);
        assert.equal(result.snapshots[0].has_records, true);
        assert.equal(result.snapshots[0].records_valid, true);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot missing rollback-records.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-norec-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshot_count, 1);
        assert.equal(result.snapshots[0].has_records, false);
        assert.ok(result.violations.some(function (v) { return v.includes('missing rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot with corrupt records', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-corrupt-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        'not valid json!!!',
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshots[0].has_records, true);
        assert.equal(result.snapshots[0].records_valid, false);
        assert.ok(result.snapshots[0].records_error !== null);
        assert.ok(result.violations.some(function (v) { return v.includes('corrupt rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkRollbackHealth fails for snapshot with invalid records structure', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-rollback-invalid-'));
    const snapshotsRoot = getRollbackSnapshotsRoot(tmpDir);
    const snapshotDir = path.join(snapshotsRoot, 'update-20260401-100000');
    fs.mkdirSync(snapshotDir, { recursive: true });
    fs.writeFileSync(
        path.join(snapshotDir, 'rollback-records.json'),
        JSON.stringify([{ noRelativePath: true }]),
        'utf8'
    );

    try {
        const result = checkRollbackHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.snapshots[0].records_valid, false);
        assert.ok(result.violations.some(function (v) { return v.includes('Invalid rollback-records.json'); }));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});


test('checkProfileHealth returns NOT_CONFIGURED when profiles.json is absent', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundlePath, 'live', 'config'), { recursive: true });

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, false);
        assert.equal(result.active_profile, null);
        assert.equal(result.profile_source, null);
        assert.equal(result.profile_count, 0);
        assert.ok(result.violations.length > 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth passes for valid profiles.json with built-in active profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'balanced',
        built_in_profiles: {
            balanced: { description: 'Default', depth: 2 },
            fast: { description: 'Fast', depth: 1 }
        },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.config_exists, true);
        assert.equal(result.active_profile, 'balanced');
        assert.equal(result.profile_source, 'built_in');
        assert.equal(result.profile_count, 2);
        assert.equal(result.violations.length, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth passes for user-defined active profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'my-custom',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: { 'my-custom': { description: 'Custom', depth: 3 } }
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, true);
        assert.equal(result.active_profile, 'my-custom');
        assert.equal(result.profile_source, 'user');
        assert.equal(result.profile_count, 2);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when active profile does not match any defined profile', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'nonexistent',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, true);
        assert.equal(result.active_profile, 'nonexistent');
        assert.equal(result.profile_source, null);
        assert.ok(result.violations.some(v => v.includes('does not match')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when no active_profile is set', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: '',
        built_in_profiles: { balanced: { description: 'Default', depth: 2 } },
        user_profiles: {}
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('no active_profile')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails when no built-in profiles exist', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), JSON.stringify({
        version: 1,
        active_profile: 'custom',
        built_in_profiles: {},
        user_profiles: { custom: { description: 'Only user', depth: 2 } }
    }), 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.ok(result.violations.some(v => v.includes('built-in profile')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('checkProfileHealth fails for invalid JSON', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'doctor-profile-'));
    const bundlePath = path.join(tmpDir, 'garda-agent-orchestrator');
    const configDir = path.join(bundlePath, 'live', 'config');
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, 'profiles.json'), '{ broken json', 'utf8');

    try {
        const result = checkProfileHealth(tmpDir);
        assert.equal(result.passed, false);
        assert.equal(result.config_exists, true);
        assert.ok(result.violations.some(v => v.includes('invalid JSON')));
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});
