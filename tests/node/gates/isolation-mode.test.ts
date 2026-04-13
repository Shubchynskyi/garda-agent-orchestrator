import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    loadIsolationModeConfig,
    evaluateIsolationModePreTask,
    evaluateIsolationModePostTask,
    isIsolationModeEnabled,
    type IsolationModeConfig
} from '../../../src/gates/isolation-mode';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'gao-isolation-test-'));
}

function setupMinimalWorkspace(root: string): void {
    const bundleRoot = path.join(root, 'garda-agent-orchestrator');
    fs.mkdirSync(path.join(bundleRoot, 'live', 'config'), { recursive: true });
    fs.mkdirSync(path.join(bundleRoot, 'runtime'), { recursive: true });
    fs.writeFileSync(path.join(bundleRoot, 'MANIFEST.md'), '# Manifest\n');
    fs.writeFileSync(path.join(bundleRoot, 'VERSION'), '2.4.2\n');
    fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest\n');
    fs.writeFileSync(path.join(root, 'VERSION'), '2.4.2\n');
}

function writeIsolationConfig(root: string, config: Partial<IsolationModeConfig>): void {
    const configPath = path.join(root, 'garda-agent-orchestrator', 'live', 'config', 'isolation-mode.json');
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

describe('gates/isolation-mode', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
        setupMinimalWorkspace(tempDir);
    });

    afterEach(() => {
        fs.rmSync(tempDir, { recursive: true, force: true });
    });

    describe('loadIsolationModeConfig', () => {
        it('returns defaults when config file is missing', () => {
            const config = loadIsolationModeConfig(tempDir);
            assert.equal(config.enabled, false);
            assert.equal(config.enforcement, 'LOG_ONLY');
            assert.equal(config.require_manifest_match_before_task, true);
            assert.equal(config.refuse_on_preflight_drift, true);
            assert.equal(config.use_sandbox, true);
            assert.ok(config.same_user_limitation_notice.length > 0);
        });

        it('reads enabled=true from config file', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const config = loadIsolationModeConfig(tempDir);
            assert.equal(config.enabled, true);
            assert.equal(config.enforcement, 'STRICT');
        });

        it('normalizes enforcement to LOG_ONLY for unrecognized values', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'UNKNOWN' as any });
            const config = loadIsolationModeConfig(tempDir);
            assert.equal(config.enforcement, 'LOG_ONLY');
        });

        it('returns defaults for malformed JSON', () => {
            const configPath = path.join(tempDir, 'garda-agent-orchestrator', 'live', 'config', 'isolation-mode.json');
            fs.writeFileSync(configPath, 'not json', 'utf8');
            const config = loadIsolationModeConfig(tempDir);
            assert.equal(config.enabled, false);
        });
    });

    describe('isIsolationModeEnabled', () => {
        it('returns false when config is missing', () => {
            assert.equal(isIsolationModeEnabled(tempDir), false);
        });

        it('returns true when enabled in config', () => {
            writeIsolationConfig(tempDir, { enabled: true });
            assert.equal(isIsolationModeEnabled(tempDir), true);
        });
    });

    describe('evaluateIsolationModePreTask', () => {
        it('returns warnings when isolation is disabled', () => {
            const evidence = evaluateIsolationModePreTask(tempDir);
            assert.equal(evidence.isolation_enabled, false);
            assert.ok(evidence.warnings.length > 0);
            assert.equal(evidence.violations.length, 0);
        });

        it('reports MISSING manifest as warning in LOG_ONLY mode', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'LOG_ONLY' });
            const evidence = evaluateIsolationModePreTask(tempDir);
            assert.equal(evidence.isolation_enabled, true);
            assert.equal(evidence.violations.length, 0, 'LOG_ONLY should not produce violations');
            assert.ok(evidence.warnings.some(w => w.includes('LOG_ONLY')), 'Expected LOG_ONLY warning');
        });

        it('reports MISSING manifest violation when enabled with STRICT', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const evidence = evaluateIsolationModePreTask(tempDir);
            assert.equal(evidence.isolation_enabled, true);
            assert.ok(evidence.violations.some(v => v.includes('trusted manifest')));
        });

        it('reports MATCH status when manifest exists and matches', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            // Write a matching manifest
            const manifestPath = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'protected-control-plane-manifest.json');
            const manifest = {
                schema_version: 1,
                event_source: 'refresh-protected-control-plane-manifest',
                timestamp_utc: new Date().toISOString(),
                workspace_root: tempDir.replace(/\\/g, '/'),
                orchestrator_root: path.join(tempDir, 'garda-agent-orchestrator').replace(/\\/g, '/'),
                protected_roots: [],
                protected_snapshot: {},
                is_source_checkout: false
            };
            fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
            const evidence = evaluateIsolationModePreTask(tempDir);
            assert.equal(evidence.manifest_status, 'MATCH');
            assert.equal(evidence.violations.length, 0);
        });
    });

    describe('evaluateIsolationModePostTask', () => {
        it('returns empty violations when isolation is disabled', () => {
            const evidence = evaluateIsolationModePostTask(tempDir, {});
            assert.equal(evidence.isolation_enabled, false);
            assert.equal(evidence.violations.length, 0);
            assert.equal(evidence.drift_files.length, 0);
        });

        it('detects drift in STRICT mode as violation', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const preflight = { 'some/file.ts': 'abc123' };
            const evidence = evaluateIsolationModePostTask(tempDir, preflight);
            assert.equal(evidence.isolation_enabled, true);
            // The file was in preflight but doesn't exist now, so it's drift
            assert.ok(evidence.drift_files.length > 0, 'Expected at least one drift file');
            assert.ok(evidence.violations.length > 0, 'Expected at least one violation in STRICT mode');
        });

        it('detects drift in LOG_ONLY mode as warning', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'LOG_ONLY' });
            const preflight = { 'some/file.ts': 'abc123' };
            const evidence = evaluateIsolationModePostTask(tempDir, preflight);
            assert.ok(evidence.drift_files.length > 0, 'Expected drift files for mismatched snapshot');
            assert.ok(evidence.warnings.some(w => w.includes('LOG_ONLY')), 'Expected LOG_ONLY warning');
            assert.equal(evidence.violations.length, 0, 'LOG_ONLY mode should not produce violations');
        });

        it('reports no drift when snapshots match', () => {
            writeIsolationConfig(tempDir, { enabled: true, enforcement: 'STRICT' });
            const evidence = evaluateIsolationModePostTask(tempDir, {});
            assert.equal(evidence.drift_files.length, 0);
            assert.equal(evidence.violations.length, 0);
        });
    });
});
