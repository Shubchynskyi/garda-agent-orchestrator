import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
    buildHandshakeDiagnostics,
    formatHandshakeDiagnosticsResult,
    getHandshakeEvidence,
    getHandshakeEvidenceViolations,
    resolveHandshakeArtifactPath,
    type HandshakeDiagnosticsArtifact
} from '../../../src/gates/handshake-diagnostics';

function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-handshake-test-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

function scaffoldWorkspace(root: string, options: {
    sourceCheckout?: boolean;
    entrypoint?: string;
    bridge?: string;
    startTaskRouter?: boolean;
} = {}): void {
    if (options.sourceCheckout) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    }
    if (options.entrypoint) {
        const entrypointPath = path.join(root, options.entrypoint);
        fs.mkdirSync(path.dirname(entrypointPath), { recursive: true });
        fs.writeFileSync(entrypointPath, '# Entrypoint', 'utf8');
    }
    if (options.bridge) {
        const bridgePath = path.join(root, options.bridge);
        fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
        fs.writeFileSync(bridgePath, '# Bridge', 'utf8');
    }
    if (options.startTaskRouter !== false) {
        const routerPath = path.join(root, '.agents', 'workflows', 'start-task.md');
        fs.mkdirSync(path.dirname(routerPath), { recursive: true });
        fs.writeFileSync(routerPath, '# Start task router', 'utf8');
    }
}

describe('gates/handshake-diagnostics', () => {
    let tempDir: string;

    beforeEach(() => {
        tempDir = createTempDir();
    });

    afterEach(() => {
        removeTempDir(tempDir);
    });

    describe('buildHandshakeDiagnostics', () => {
        it('produces PASS for a complete GitHubCopilot source-checkout workspace', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: '.github/copilot-instructions.md',
                bridge: '.github/agents/orchestrator.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-01',
                repoRoot: tempDir,
                provider: 'GitHubCopilot'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.task_id, 'T-TEST-01');
            assert.equal(result.provider, 'GitHubCopilot');
            assert.equal(result.canonical_entrypoint, '.github/copilot-instructions.md');
            assert.equal(result.canonical_entrypoint_exists, true);
            assert.equal(result.provider_bridge, '.github/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, true);
            assert.equal(result.start_task_router_exists, true);
            assert.equal(result.execution_context, 'source-checkout');
            assert.equal(result.cli_path, 'node bin/garda.js');
            assert.equal(result.violations.length, 0);
            assert.equal(result.schema_version, 1);
            assert.equal(result.event_source, 'handshake-diagnostics');
        });

        it('produces PASS for Claude root-entrypoint-only workspace', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-02',
                repoRoot: tempDir,
                provider: 'Claude'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.equal(result.provider, 'Claude');
            assert.equal(result.canonical_entrypoint, 'CLAUDE.md');
            assert.equal(result.canonical_entrypoint_exists, true);
            assert.equal(result.provider_bridge, null);
            assert.equal(result.provider_bridge_exists, false);
            assert.equal(result.execution_context, 'materialized-bundle');
        });

        it('reports FAIL when canonical entrypoint is missing', () => {
            scaffoldWorkspace(tempDir, { startTaskRouter: true });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-03',
                repoRoot: tempDir,
                provider: 'Windsurf'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.canonical_entrypoint_exists, false);
            assert.ok(result.violations.some(v => v.includes('.windsurf/rules/rules.md')));
        });

        it('reports FAIL when start-task router is missing', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'AGENTS.md',
                startTaskRouter: false
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-04',
                repoRoot: tempDir,
                provider: 'Codex'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.start_task_router_exists, false);
            assert.ok(result.violations.some(v => v.includes('start-task')));
        });

        it('uses materialized-bundle context when not source checkout', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: false,
                entrypoint: 'GEMINI.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-05',
                repoRoot: tempDir,
                provider: 'Gemini'
            });

            assert.equal(result.execution_context, 'materialized-bundle');
            assert.equal(result.cli_path, 'node garda-agent-orchestrator/bin/garda.js');
        });

        it('records all 8 supported providers', () => {
            const providers = ['Claude', 'Codex', 'Gemini', 'Qwen', 'GitHubCopilot', 'Windsurf', 'Junie', 'Antigravity'];
            for (const provider of providers) {
                const providerDir = createTempDir();
                try {
                    scaffoldWorkspace(providerDir, { startTaskRouter: true });
                    const result = buildHandshakeDiagnostics({
                        taskId: 'T-TEST-06',
                        repoRoot: providerDir,
                        provider
                    });
                    assert.equal(result.provider, provider, `Provider family should match for ${provider}`);
                    assert.ok(result.canonical_entrypoint, `Should resolve entrypoint for ${provider}`);
                } finally {
                    removeTempDir(providerDir);
                }
            }
        });

        it('handles null provider gracefully', () => {
            scaffoldWorkspace(tempDir, { startTaskRouter: true });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-07',
                repoRoot: tempDir,
                provider: null
            });

            assert.equal(result.provider, null);
            assert.equal(result.canonical_entrypoint, null);
            assert.ok(result.diagnostics.some(d => d.check === 'provider_family' && d.status === 'warning'));
        });

        it('records explicit cliPath and effectiveCwd overrides and fails on cli_path mismatch', () => {
            scaffoldWorkspace(tempDir, { startTaskRouter: true });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-08',
                repoRoot: tempDir,
                provider: 'Claude',
                cliPath: 'node custom/path.js',
                effectiveCwd: '/custom/cwd'
            });

            assert.equal(result.cli_path, 'node custom/path.js');
            assert.equal(result.effective_cwd, '/custom/cwd');
            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some(v => v.includes('CLI path mismatch')));
            assert.ok(result.diagnostics.some(d => d.check === 'cli_path' && d.status === 'error'));
        });

        it('detects Antigravity bridge', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: '.antigravity/rules.md',
                bridge: '.antigravity/agents/orchestrator.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-09',
                repoRoot: tempDir,
                provider: 'Antigravity'
            });

            assert.equal(result.provider_bridge, '.antigravity/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, true);
        });

        it('reports FAIL when expected provider bridge is missing', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: '.github/copilot-instructions.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-10',
                repoRoot: tempDir,
                provider: 'GitHubCopilot'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.provider_bridge, '.github/agents/orchestrator.md');
            assert.equal(result.provider_bridge_exists, false);
            assert.ok(result.violations.some(v => v.includes('Provider bridge') && v.includes('missing')));
        });

        it('cli_path mismatch alone causes FAIL even when all other checks pass', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-01',
                repoRoot: tempDir,
                provider: 'Claude',
                cliPath: 'node wrong/cli.js'
            });

            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.equal(result.violations.length, 1);
            assert.ok(result.violations[0].includes('CLI path mismatch'));
            assert.ok(result.violations[0].includes('wrong/cli.js'));
        });

        it('cli_path matching expected path does not add violations', () => {
            scaffoldWorkspace(tempDir, {
                sourceCheckout: true,
                entrypoint: 'CLAUDE.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-02',
                repoRoot: tempDir,
                provider: 'Claude',
                cliPath: 'node bin/garda.js'
            });

            assert.equal(result.status, 'PASSED');
            assert.equal(result.outcome, 'PASS');
            assert.ok(!result.violations.some(v => v.includes('CLI path')));
            assert.ok(result.diagnostics.some(d => d.check === 'cli_path' && d.status === 'ok'));
        });

        it('cli_path mismatch in materialized-bundle context uses correct expected path', () => {
            scaffoldWorkspace(tempDir, {
                entrypoint: 'AGENTS.md',
                startTaskRouter: true
            });

            const result = buildHandshakeDiagnostics({
                taskId: 'T-TEST-CLIPATH-03',
                repoRoot: tempDir,
                provider: 'Codex',
                cliPath: 'node bin/garda.js'
            });

            assert.equal(result.execution_context, 'materialized-bundle');
            assert.equal(result.status, 'FAILED');
            assert.equal(result.outcome, 'FAIL');
            assert.ok(result.violations.some(v => v.includes('CLI path mismatch') && v.includes('garda-agent-orchestrator/bin/garda.js')));
        });
    });

    describe('getHandshakeEvidence', () => {
        it('returns PASS for valid artifact', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-EVIDENCE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-EVIDENCE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-EVIDENCE-01');
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('returns EVIDENCE_FILE_MISSING when no artifact exists', () => {
            const evidence = getHandshakeEvidence(tempDir, 'T-MISSING-01');
            assert.equal(evidence.evidence_status, 'EVIDENCE_FILE_MISSING');
            assert.ok(evidence.violations.length > 0);
        });

        it('returns TASK_ID_MISSING for null task id', () => {
            const evidence = getHandshakeEvidence(tempDir, null);
            assert.equal(evidence.evidence_status, 'TASK_ID_MISSING');
        });

        it('returns EVIDENCE_TASK_MISMATCH for wrong task id', () => {
            const artifact = {
                event_source: 'handshake-diagnostics',
                task_id: 'T-OTHER',
                status: 'PASSED',
                outcome: 'PASS'
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            fs.writeFileSync(
                path.join(reviewsDir, 'T-MISMATCH-01-handshake.json'),
                JSON.stringify(artifact),
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-MISMATCH-01');
            assert.equal(evidence.evidence_status, 'EVIDENCE_TASK_MISMATCH');
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when timeline lacks HANDSHAKE_DIAGNOSTICS_RECORDED', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-TIMELINE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-TIMELINE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-TIMELINE-01.jsonl');
            fs.writeFileSync(timelinePath, JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() }) + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-TIMELINE-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some(v => v.includes('HANDSHAKE_DIAGNOSTICS_RECORDED')));
        });

        it('returns EVIDENCE_TIMELINE_UNBOUND when artifact hash mismatches timeline hash', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASH-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASH-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASH-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-16T09:00:00.000Z'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: 'wrong-hash-value' }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HASH-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some(v => v.includes('hash mismatch')));
        });

        it('passes when timeline has matching HANDSHAKE_DIAGNOSTICS_RECORDED hash', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASHOK-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASHOK-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASHOK-01.jsonl');
            fs.writeFileSync(timelinePath, [
                JSON.stringify({
                    event_type: 'TASK_MODE_ENTERED',
                    timestamp_utc: '2026-04-16T09:00:00.000Z'
                }),
                JSON.stringify({
                    event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                    timestamp_utc: new Date().toISOString(),
                    details: { artifact_hash: hash }
                })
            ].join('\n') + '\n', 'utf8');

            const evidence = getHandshakeEvidence(tempDir, 'T-HASHOK-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('uses the latest HANDSHAKE_DIAGNOSTICS_RECORDED event when the gate is rerun', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HASHLATEST-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Claude',
                canonical_entrypoint: 'CLAUDE.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HASHLATEST-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HASHLATEST-01.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({
                        event_type: 'TASK_MODE_ENTERED',
                        timestamp_utc: '2026-04-16T09:00:00.000Z'
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-03T10:00:00.000Z',
                        details: { artifact_hash: 'old-stale-hash' }
                    }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-03T10:05:00.000Z',
                        details: { artifact_hash: hash }
                    })
                ].join('\n') + '\n',
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-HASHLATEST-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it('rejects handshake evidence when a newer task-mode cycle already superseded it', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-HANDSHAKE-STALE-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'Codex',
                canonical_entrypoint: 'AGENTS.md',
                canonical_entrypoint_exists: true,
                provider_bridge: null,
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
            fs.mkdirSync(reviewsDir, { recursive: true });
            const artifactPath = path.join(reviewsDir, 'T-HANDSHAKE-STALE-01-handshake.json');
            fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');

            const crypto = require('node:crypto');
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            const timelineDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'task-events');
            fs.mkdirSync(timelineDir, { recursive: true });
            const timelinePath = path.join(timelineDir, 'T-HANDSHAKE-STALE-01.jsonl');
            fs.writeFileSync(
                timelinePath,
                [
                    JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-16T09:00:00.000Z' }),
                    JSON.stringify({
                        event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED',
                        timestamp_utc: '2026-04-16T09:01:00.000Z',
                        details: { artifact_hash: hash }
                    }),
                    JSON.stringify({ event_type: 'TASK_MODE_ENTERED', timestamp_utc: '2026-04-16T09:02:00.000Z' })
                ].join('\n') + '\n',
                'utf8'
            );

            const evidence = getHandshakeEvidence(tempDir, 'T-HANDSHAKE-STALE-01', { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some((violation) => violation.includes('predates the latest TASK_MODE_ENTERED')));
        });
    });

    describe('getHandshakeEvidenceViolations', () => {
        it('returns empty array for PASS status', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: 'abc',
                evidence_status: 'PASS',
                provider: 'Claude',
                violations: []
            });
            assert.deepEqual(result, []);
        });

        it('returns violations for EVIDENCE_FILE_MISSING', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: null,
                evidence_status: 'EVIDENCE_FILE_MISSING',
                provider: null,
                violations: ['Handshake diagnostics evidence missing: file not found at \'/test\'. Run handshake-diagnostics before implementation gates.']
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('missing'));
        });

        it('returns generic message for unknown status', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: null,
                evidence_hash: null,
                evidence_status: 'UNKNOWN',
                provider: null,
                violations: []
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('missing or invalid'));
        });

        it('returns violations for EVIDENCE_TIMELINE_UNBOUND', () => {
            const result = getHandshakeEvidenceViolations({
                task_id: 'T-01',
                evidence_path: '/test',
                evidence_hash: 'abc123',
                evidence_status: 'EVIDENCE_TIMELINE_UNBOUND',
                provider: 'Claude',
                violations: ['Handshake diagnostics evidence is not bound to task timeline for \'T-01\'.']
            });
            assert.ok(result.length > 0);
            assert.ok(result[0].includes('not bound'));
        });
    });

    describe('formatHandshakeDiagnosticsResult', () => {
        it('formats PASSED result correctly', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-FMT-01',
                status: 'PASSED',
                outcome: 'PASS',
                provider: 'GitHubCopilot',
                canonical_entrypoint: '.github/copilot-instructions.md',
                canonical_entrypoint_exists: true,
                provider_bridge: '.github/agents/orchestrator.md',
                provider_bridge_exists: true,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [
                    { check: 'canonical_entrypoint', status: 'ok', detail: 'Exists.' }
                ],
                violations: []
            };

            const lines = formatHandshakeDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('HANDSHAKE_DIAGNOSTICS_PASSED'));
            assert.ok(lines.some(l => l.includes('GitHubCopilot')));
        });

        it('formats FAILED result with violations', () => {
            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: 'T-FMT-02',
                status: 'FAILED',
                outcome: 'FAIL',
                provider: 'Windsurf',
                canonical_entrypoint: '.windsurf/rules/rules.md',
                canonical_entrypoint_exists: false,
                provider_bridge: '.windsurf/agents/orchestrator.md',
                provider_bridge_exists: false,
                start_task_router_path: '.agents/workflows/start-task.md',
                start_task_router_exists: false,
                execution_context: 'materialized-bundle',
                cli_path: 'node garda-agent-orchestrator/bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: ['Missing entrypoint', 'Missing router']
            };

            const lines = formatHandshakeDiagnosticsResult(artifact);
            assert.ok(lines[0].includes('HANDSHAKE_DIAGNOSTICS_FAILED'));
            assert.ok(lines.some(l => l.includes('Violations:')));
        });
    });

    describe('resolveHandshakeArtifactPath', () => {
        it('generates default path when no explicit path given', () => {
            const result = resolveHandshakeArtifactPath(tempDir, 'T-PATH-01');
            assert.ok(result.includes('T-PATH-01-handshake.json'));
        });

        it('uses explicit path when provided', () => {
            const customPath = path.join(tempDir, 'custom-handshake.json');
            const result = resolveHandshakeArtifactPath(tempDir, 'T-PATH-02', customPath);
            assert.ok(result.includes('custom-handshake.json'));
        });
    });
});
