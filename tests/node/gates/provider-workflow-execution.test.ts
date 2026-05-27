/**
 * T-011: Validate real workflow execution per provider family.
 *
 * Router materialization is already well-tested in cross-provider-router-matrix.
 * This file covers the *execution* side: handshake diagnostics, provider
 * compliance scanning, evidence lifecycle, and gate-sequence correctness
 * for every provider family × execution-context combination.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';

import {
    SOURCE_OF_TRUTH_VALUES,
    SOURCE_TO_ENTRYPOINT_MAP,
    ALL_AGENT_ENTRYPOINT_FILES
} from '../../../src/core/constants';
import {
    getCanonicalEntrypointFile,
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../../../src/materialization/common';
import { getProviderEntries } from '../../../src/core/provider-registry';
import {
    MANAGED_START,
    MANAGED_END,
    buildCanonicalManagedBlock,
    buildRedirectManagedBlock,
    buildProviderOrchestratorAgentContent,
    buildSharedStartTaskWorkflowContent
} from '../../../src/materialization/content-builders';
import {
    buildHandshakeDiagnostics,
    getHandshakeEvidence,
    formatHandshakeDiagnosticsResult,
    type HandshakeDiagnosticsArtifact
} from '../../../src/gates/handshake-diagnostics';
import {
    scanProviderCompliance,
    formatProviderComplianceSummary,
    formatProviderComplianceDetail
} from '../../../src/validators/provider-compliance';


const ALL_PROVIDERS = SOURCE_OF_TRUTH_VALUES as readonly string[];
const BRIDGE_PROFILES = getProviderOrchestratorProfileDefinitions();

/** Providers that have dedicated orchestrator bridge files. */
const BRIDGE_PROVIDERS = new Map(
    BRIDGE_PROFILES.map((p) => {
        const sotKey = (Object.entries(SOURCE_TO_ENTRYPOINT_MAP) as [string, string][])
            .find(([, v]) => v === p.entrypointFile)?.[0];
        return [sotKey!, p] as const;
    })
);

/** Providers without a bridge (root-entrypoint-only). */
const ROOT_ONLY_PROVIDERS = ALL_PROVIDERS.filter((p) => !BRIDGE_PROVIDERS.has(p));

const MANDATORY_GATE_NAMES = [
    'enter-task-mode',
    'load-rule-pack',
    'classify-change',
    'compile-gate',
    'build-review-context',
    'required-reviews-check',
    'doc-impact-gate',
    'completion-gate'
];


function createTempDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'garda-provider-exec-'));
}

function removeTempDir(dirPath: string): void {
    fs.rmSync(dirPath, { recursive: true, force: true });
}

interface ScaffoldOptions {
    sourceCheckout?: boolean;
    provider: string;
    writeMaterializedContent?: boolean;
    writeStartTaskRouter?: boolean;
    writeBridge?: boolean;
    writeRedirects?: boolean;
}

/**
 * Scaffolds a realistic workspace for a given provider, optionally writing
 * materialized content (canonical block, bridge, router, redirects) so that
 * execution-time checks see real managed blocks instead of placeholders.
 */
function scaffoldProviderWorkspace(root: string, options: ScaffoldOptions): void {
    const { provider, sourceCheckout, writeMaterializedContent, writeBridge, writeStartTaskRouter, writeRedirects } = options;
    const canonicalFile = getCanonicalEntrypointFile(provider);

    // Source-checkout markers
    if (sourceCheckout) {
        fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'garda-agent-orchestrator' }), 'utf8');
        fs.writeFileSync(path.join(root, 'MANIFEST.md'), '# Manifest', 'utf8');
        fs.writeFileSync(path.join(root, 'VERSION'), '1.0.0', 'utf8');
    }

    const initAnswersPath = path.join(root, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
    fs.writeFileSync(initAnswersPath, JSON.stringify({
        SourceOfTruth: provider
    }, null, 2), 'utf8');

    // Neutral template content for canonical block builder
    const templatePath = path.join(process.cwd(), 'template', 'entrypoints', 'canonical-rule-index.md');
    const templateContent = fs.readFileSync(templatePath, 'utf-8');

    // Canonical entrypoint
    const entrypointFullPath = path.join(root, canonicalFile);
    fs.mkdirSync(path.dirname(entrypointFullPath), { recursive: true });
    if (writeMaterializedContent) {
        const block = buildCanonicalManagedBlock(canonicalFile, templateContent);
        fs.writeFileSync(entrypointFullPath, block, 'utf8');
    } else {
        fs.writeFileSync(entrypointFullPath, '# Entrypoint', 'utf8');
    }

    // Start-task router
    if (writeStartTaskRouter !== false) {
        const routerPath = path.join(root, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
        fs.mkdirSync(path.dirname(routerPath), { recursive: true });
        if (writeMaterializedContent) {
            const routerContent = buildSharedStartTaskWorkflowContent(canonicalFile);
            fs.writeFileSync(routerPath, routerContent, 'utf8');
        } else {
            fs.writeFileSync(routerPath, '# Start task router', 'utf8');
        }
    }

    // Provider bridge
    const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
    if (bridgeProfile && writeBridge !== false) {
        const bridgePath = path.join(root, bridgeProfile.orchestratorRelativePath);
        fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
        if (writeMaterializedContent) {
            const bridgeContent = buildProviderOrchestratorAgentContent(
                bridgeProfile.providerLabel, canonicalFile, bridgeProfile.orchestratorRelativePath
            );
            fs.writeFileSync(bridgePath, bridgeContent, 'utf8');
        } else {
            fs.writeFileSync(bridgePath, '# Bridge', 'utf8');
        }
    }

    // Redirects for all other entrypoints
    if (writeRedirects) {
        const bridgePaths = BRIDGE_PROFILES.map((p) => p.orchestratorRelativePath);
        for (const ep of ALL_AGENT_ENTRYPOINT_FILES) {
            if (ep === canonicalFile) continue;
            const redirectPath = path.join(root, ep);
            fs.mkdirSync(path.dirname(redirectPath), { recursive: true });
            const redirectContent = buildRedirectManagedBlock(ep, canonicalFile, bridgePaths);
            fs.writeFileSync(redirectPath, redirectContent, 'utf8');
        }
    }
}

function writeHandshakeArtifact(root: string, taskId: string, artifact: HandshakeDiagnosticsArtifact): string {
    const reviewsDir = path.join(root, 'garda-agent-orchestrator', 'runtime', 'reviews');
    fs.mkdirSync(reviewsDir, { recursive: true });
    const artifactPath = path.join(reviewsDir, `${taskId}-handshake.json`);
    fs.writeFileSync(artifactPath, JSON.stringify(artifact, null, 2), 'utf8');
    return artifactPath;
}

function writeTimelineEvent(root: string, taskId: string, events: Record<string, unknown>[]): string {
    const eventsDir = path.join(root, 'garda-agent-orchestrator', 'runtime', 'task-events');
    fs.mkdirSync(eventsDir, { recursive: true });
    const timelinePath = path.join(eventsDir, `${taskId}.jsonl`);
    const content = events.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(timelinePath, content, 'utf8');
    return timelinePath;
}

// ===========================================================================
// 1. Per-provider handshake diagnostics execution matrix
// ===========================================================================

describe('provider-workflow-execution: handshake per provider family', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);
        const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
        const hasBridge = !!bridgeProfile;
        const routedTo = bridgeProfile?.orchestratorRelativePath ?? canonicalFile;
        const sharedEntrypointProviders = ALL_PROVIDERS.filter((candidate) => (
            getCanonicalEntrypointFile(candidate) === canonicalFile
        ));
        const requiresExplicitProviderForSharedEntrypoint = sharedEntrypointProviders.length > 1;
        const expectedRouteOnlyExecutionProviderSource = hasBridge
            ? 'provider_bridge'
            : 'provider_entrypoint';

        describe(`${provider} (entrypoint=${canonicalFile})`, () => {
            it('PASS in source-checkout context with all required files', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, { provider, sourceCheckout: true });
                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-SC`,
                        repoRoot: dir,
                        routedTo,
                        provider: requiresExplicitProviderForSharedEntrypoint ? provider : undefined
                    });
                    assert.equal(result.status, 'PASSED', `${provider} should pass handshake in source-checkout`);
                    assert.equal(result.outcome, 'PASS');
                    assert.equal(result.provider, provider);
                    assert.equal(result.execution_provider, provider);
                    assert.equal(result.canonical_source_of_truth, provider);
                    assert.equal(result.canonical_entrypoint, canonicalFile);
                    assert.equal(result.canonical_entrypoint_exists, true);
                    assert.equal(result.execution_provider_source, expectedRouteOnlyExecutionProviderSource);
                    assert.equal(result.runtime_identity_status, 'resolved');
                    assert.equal(result.reviewer_subagent_launch_status, 'launchable');
                    assert.equal(result.execution_context, 'source-checkout');
                    assert.equal(result.cli_path, 'node bin/garda.js');
                    assert.equal(result.start_task_router_exists, true);
                    assert.equal(result.violations.length, 0);
                    assert.ok(result.diagnostics.length > 0, 'Should produce diagnostic checks');

                    if (hasBridge) {
                        assert.equal(result.provider_bridge, bridgeProfile!.orchestratorRelativePath);
                        assert.equal(result.provider_bridge_exists, true);
                    } else {
                        assert.equal(result.provider_bridge, null);
                        assert.equal(result.provider_bridge_exists, false);
                    }
                } finally {
                    removeTempDir(dir);
                }
            });

            it('PASS in materialized-bundle context with all required files', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, { provider, sourceCheckout: false });
                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-MB`,
                        repoRoot: dir,
                        routedTo,
                        provider: requiresExplicitProviderForSharedEntrypoint ? provider : undefined
                    });
                    assert.equal(result.status, 'PASSED', `${provider} should pass handshake in materialized-bundle`);
                    assert.equal(result.execution_provider, provider);
                    assert.equal(result.canonical_source_of_truth, provider);
                    assert.equal(result.execution_provider_source, expectedRouteOnlyExecutionProviderSource);
                    assert.equal(result.runtime_identity_status, 'resolved');
                    assert.equal(result.reviewer_subagent_launch_status, 'launchable');
                    assert.equal(result.execution_context, 'materialized-bundle');
                    assert.equal(result.cli_path, 'node garda-agent-orchestrator/bin/garda.js');
                    assert.equal(result.violations.length, 0);
                } finally {
                    removeTempDir(dir);
                }
            });

            it('PASS when runtime stays in a direct provider session with explicit runtime identity', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, { provider, sourceCheckout: true });
                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-DIRECT`,
                        repoRoot: dir,
                        provider
                    });
                    assert.equal(result.status, 'PASSED');
                    assert.equal(result.execution_provider_source, 'explicit_provider');
                    assert.equal(result.reviewer_subagent_launch_status, 'launchable');
                    assert.equal(result.reviewer_subagent_launch_route, routedTo);
                    assert.equal(result.violations.length, 0);
                } finally {
                    removeTempDir(dir);
                }
            });

            if (hasBridge) {
                it('PASS when runtime enters through the canonical root entrypoint', () => {
                    const dir = createTempDir();
                    try {
                        scaffoldProviderWorkspace(dir, { provider, sourceCheckout: true });
                        const result = buildHandshakeDiagnostics({
                            taskId: `T-EXEC-${provider}-ROOTENTRY`,
                            repoRoot: dir,
                            routedTo: canonicalFile
                        });
                        assert.equal(result.status, 'PASSED');
                        assert.equal(result.execution_provider_source, 'provider_entrypoint');
                        assert.equal(result.runtime_identity_status, 'resolved');
                        assert.equal(result.reviewer_subagent_launch_status, 'launchable');
                        assert.equal(result.reviewer_subagent_launch_route, canonicalFile);
                        assert.equal(result.violations.length, 0);
                    } finally {
                        removeTempDir(dir);
                    }
                });
            }

            it('FAIL when canonical entrypoint is missing', () => {
                const dir = createTempDir();
                try {
                    const initAnswersPath = path.join(dir, 'garda-agent-orchestrator', 'runtime', 'init-answers.json');
                    fs.mkdirSync(path.dirname(initAnswersPath), { recursive: true });
                    fs.writeFileSync(initAnswersPath, JSON.stringify({
                        SourceOfTruth: provider
                    }, null, 2), 'utf8');
                    // Only write router, skip entrypoint
                    const routerPath = path.join(dir, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
                    fs.mkdirSync(path.dirname(routerPath), { recursive: true });
                    fs.writeFileSync(routerPath, '# Router', 'utf8');

                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-NOEP`,
                        repoRoot: dir,
                        provider
                    });
                    assert.equal(result.status, 'FAILED');
                    assert.equal(result.canonical_entrypoint_exists, false);
                    assert.ok(result.violations.some((v) => v.includes(canonicalFile)));
                } finally {
                    removeTempDir(dir);
                }
            });

            it('FAIL when start-task router is missing', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, { provider, writeStartTaskRouter: false });
                    // Remove router manually if scaffolding wrote it
                    const routerPath = path.join(dir, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
                    if (fs.existsSync(routerPath)) fs.unlinkSync(routerPath);

                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-NOROUTER`,
                        repoRoot: dir,
                        provider
                    });
                    assert.equal(result.status, 'FAILED');
                    assert.equal(result.start_task_router_exists, false);
                    assert.ok(result.violations.some((v) => v.includes('start-task')));
                } finally {
                    removeTempDir(dir);
                }
            });

            it('cli_path mismatch causes FAIL regardless of other checks', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, { provider, sourceCheckout: false });
                    // Use source-checkout cli path in materialized-bundle context
                    const result = buildHandshakeDiagnostics({
                        taskId: `T-EXEC-${provider}-CLIPATH`,
                        repoRoot: dir,
                        provider,
                        cliPath: 'node bin/garda.js'
                    });
                    assert.equal(result.status, 'FAILED');
                    assert.ok(result.violations.some((v) => v.includes('CLI path mismatch')));
                } finally {
                    removeTempDir(dir);
                }
            });

            if (hasBridge) {
                it('PASS when a direct provider session does not have the optional bridge file on disk', () => {
                    const dir = createTempDir();
                    try {
                        scaffoldProviderWorkspace(dir, { provider, writeBridge: false });
                        const bridgePath = path.join(dir, bridgeProfile!.orchestratorRelativePath);
                        if (fs.existsSync(bridgePath)) fs.unlinkSync(bridgePath);

                        const result = buildHandshakeDiagnostics({
                            taskId: `T-EXEC-${provider}-DIRECT-NOBRIDGE`,
                            repoRoot: dir,
                            provider
                        });
                        assert.equal(result.status, 'PASSED');
                        assert.equal(result.execution_provider_source, 'explicit_provider');
                        assert.equal(result.provider_bridge_exists, false);
                        assert.ok(result.diagnostics.some((entry) => (
                            entry.check === 'provider_bridge'
                            && entry.status === 'warning'
                        )));
                    } finally {
                        removeTempDir(dir);
                    }
                });

                it('FAIL when expected provider bridge is missing', () => {
                    const dir = createTempDir();
                    try {
                        scaffoldProviderWorkspace(dir, { provider, writeBridge: false });
                        // Remove bridge if it still exists
                        const bridgePath = path.join(dir, bridgeProfile!.orchestratorRelativePath);
                        if (fs.existsSync(bridgePath)) fs.unlinkSync(bridgePath);

                        const result = buildHandshakeDiagnostics({
                            taskId: `T-EXEC-${provider}-NOBRIDGE`,
                            repoRoot: dir,
                            routedTo: bridgeProfile!.orchestratorRelativePath
                        });
                        assert.equal(result.status, 'FAILED');
                        assert.equal(result.provider_bridge, bridgeProfile!.orchestratorRelativePath);
                        assert.equal(result.provider_bridge_exists, false);
                        assert.ok(result.violations.some((v) => v.includes('bridge') || v.includes('Provider bridge')));
                    } finally {
                        removeTempDir(dir);
                    }
                });
            }
        });
    }
});

describe('provider-workflow-execution: split canonical/runtime identity', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    it('passes handshake and evidence binding when canonical SourceOfTruth differs from execution provider', () => {
        const taskId = 'T-EXEC-SPLIT-01';
        scaffoldProviderWorkspace(tempDir, { provider: 'Codex', sourceCheckout: true });
        const antigravityBridgePath = path.join(tempDir, '.antigravity', 'agents', 'orchestrator.md');
        fs.mkdirSync(path.dirname(antigravityBridgePath), { recursive: true });
        fs.writeFileSync(antigravityBridgePath, '# Bridge', 'utf8');

        const artifact = buildHandshakeDiagnostics({
            taskId,
            repoRoot: tempDir,
            routedTo: '.antigravity/agents/orchestrator.md'
        });

        assert.equal(artifact.status, 'PASSED');
        assert.equal(artifact.outcome, 'PASS');
        assert.equal(artifact.provider, 'Antigravity');
        assert.equal(artifact.execution_provider, 'Antigravity');
        assert.equal(artifact.canonical_source_of_truth, 'Codex');
        assert.equal(artifact.canonical_entrypoint, 'AGENTS.md');
        assert.equal(artifact.provider_bridge, '.antigravity/agents/orchestrator.md');
        assert.equal(artifact.provider_bridge_exists, true);
        assert.equal(artifact.execution_provider_source, 'provider_bridge');
        assert.equal(artifact.runtime_identity_status, 'resolved');
        assert.equal(artifact.reviewer_subagent_launch_status, 'launchable');
        assert.equal(artifact.violations.length, 0);

        const artifactPath = writeHandshakeArtifact(tempDir, taskId, artifact);
        const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
        const timelinePath = writeTimelineEvent(tempDir, taskId, [
            { event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() },
            { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', timestamp_utc: new Date().toISOString(), details: { artifact_hash: hash } }
        ]);

        const evidence = getHandshakeEvidence(tempDir, taskId, { timelinePath, artifactPath });
        assert.equal(evidence.evidence_status, 'PASS');
        assert.equal(evidence.provider, 'Antigravity');
        assert.equal(evidence.violations.length, 0);
    });
});

// ===========================================================================
// 2. Handshake evidence lifecycle per provider family
// ===========================================================================

describe('provider-workflow-execution: evidence lifecycle per provider', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    for (const provider of ALL_PROVIDERS) {
        it(`${provider}: evidence round-trip (write artifact → verify → timeline binding)`, () => {
            const taskId = `T-EV-${provider}`;
            const canonicalFile = getCanonicalEntrypointFile(provider);
            const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
            const routedTo = bridgeProfile?.orchestratorRelativePath ?? canonicalFile;
            const executionProviderSource = bridgeProfile ? 'provider_bridge' : 'provider_entrypoint';

            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                provider,
                execution_provider: provider,
                canonical_source_of_truth: provider,
                canonical_entrypoint: canonicalFile,
                canonical_entrypoint_exists: true,
                provider_bridge: bridgeProfile?.orchestratorRelativePath ?? null,
                provider_bridge_exists: !!bridgeProfile,
                routed_to: routedTo,
                execution_provider_source: executionProviderSource,
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: routedTo,
                start_task_router_path: SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: tempDir.replace(/\\/g, '/'),
                workspace_root: tempDir.replace(/\\/g, '/'),
                diagnostics: [],
                violations: []
            };

            const artifactPath = writeHandshakeArtifact(tempDir, taskId, artifact);
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');

            // Without timeline: should pass (no timeline path given)
            const evidenceNoTimeline = getHandshakeEvidence(tempDir, taskId);
            assert.equal(evidenceNoTimeline.evidence_status, 'PASS');
            assert.equal(evidenceNoTimeline.provider, provider);

            // With matching timeline event
            const timelinePath = writeTimelineEvent(tempDir, taskId, [
                { event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', timestamp_utc: new Date().toISOString(), details: { artifact_hash: hash } }
            ]);
            const evidenceWithTimeline = getHandshakeEvidence(tempDir, taskId, { timelinePath });
            assert.equal(evidenceWithTimeline.evidence_status, 'PASS');
            assert.equal(evidenceWithTimeline.violations.length, 0);
        });

        it(`${provider}: evidence accepts direct-provider PASS artifacts when timeline binding exists`, () => {
            const taskId = `T-EV-DIRECT-${provider}`;
            const canonicalFile = getCanonicalEntrypointFile(provider);
            const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);

            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                provider,
                execution_provider: provider,
                canonical_source_of_truth: provider,
                canonical_entrypoint: canonicalFile,
                canonical_entrypoint_exists: true,
                provider_bridge: bridgeProfile?.orchestratorRelativePath ?? null,
                provider_bridge_exists: !!bridgeProfile,
                execution_provider_source: 'explicit_provider',
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                start_task_router_path: SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: tempDir.replace(/\\/g, '/'),
                workspace_root: tempDir.replace(/\\/g, '/'),
                diagnostics: [],
                violations: []
            };

            const artifactPath = writeHandshakeArtifact(tempDir, taskId, artifact);
            const hash = crypto.createHash('sha256').update(fs.readFileSync(artifactPath)).digest('hex');
            const timelinePath = writeTimelineEvent(tempDir, taskId, [
                { event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', timestamp_utc: new Date().toISOString(), details: { artifact_hash: hash } }
            ]);

            const evidence = getHandshakeEvidence(tempDir, taskId, { timelinePath });
            assert.equal(evidence.evidence_status, 'PASS');
            assert.equal(evidence.violations.length, 0);
        });

        it(`${provider}: evidence UNBOUND when timeline hash mismatches`, () => {
            const taskId = `T-UNBOUND-${provider}`;
            const canonicalFile = getCanonicalEntrypointFile(provider);
            const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
            const routedTo = bridgeProfile?.orchestratorRelativePath ?? canonicalFile;
            const executionProviderSource = bridgeProfile ? 'provider_bridge' : 'provider_entrypoint';

            const artifact: HandshakeDiagnosticsArtifact = {
                schema_version: 1,
                timestamp_utc: new Date().toISOString(),
                event_source: 'handshake-diagnostics',
                task_id: taskId,
                status: 'PASSED',
                outcome: 'PASS',
                provider,
                execution_provider: provider,
                canonical_source_of_truth: provider,
                canonical_entrypoint: canonicalFile,
                canonical_entrypoint_exists: true,
                provider_bridge: bridgeProfile?.orchestratorRelativePath ?? null,
                provider_bridge_exists: !!bridgeProfile,
                routed_to: routedTo,
                execution_provider_source: executionProviderSource,
                runtime_identity_status: 'resolved',
                reviewer_subagent_launch_status: 'launchable',
                reviewer_subagent_launch_route: routedTo,
                start_task_router_path: SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
                start_task_router_exists: true,
                execution_context: 'source-checkout',
                cli_path: 'node bin/garda.js',
                effective_cwd: '/test',
                workspace_root: '/test',
                diagnostics: [],
                violations: []
            };

            writeHandshakeArtifact(tempDir, taskId, artifact);
            const timelinePath = writeTimelineEvent(tempDir, taskId, [
                { event_type: 'TASK_MODE_ENTERED', timestamp_utc: new Date().toISOString() },
                { event_type: 'HANDSHAKE_DIAGNOSTICS_RECORDED', timestamp_utc: new Date().toISOString(), details: { artifact_hash: 'tampered-hash' } }
            ]);

            const evidence = getHandshakeEvidence(tempDir, taskId, { timelinePath });
            assert.equal(evidence.evidence_status, 'EVIDENCE_TIMELINE_UNBOUND');
            assert.ok(evidence.violations.some((v) => v.includes('hash mismatch')));
        });
    }
});

// ===========================================================================
// 3. Provider compliance scanning per provider family
// ===========================================================================

describe('provider-workflow-execution: provider compliance per family', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);
        const bridgeProfile = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
        const hasBridge = !!bridgeProfile;

        describe(`${provider} compliance`, () => {
            it('passes when fully materialized with managed blocks and router references', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, {
                        provider,
                        writeMaterializedContent: true,
                        writeStartTaskRouter: true
                    });

                    const result = scanProviderCompliance(dir, [canonicalFile]);
                    assert.equal(result.routerExists, true);
                    assert.equal(result.passed, true, `${provider} compliance should pass: ${result.violations.join('; ')}`);

                    // Verify entrypoint was checked
                    const epItem = result.entrypoints.find((e) => e.file === canonicalFile);
                    assert.ok(epItem, `Should have checked entrypoint ${canonicalFile}`);
                    assert.equal(epItem!.exists, true);
                    assert.equal(epItem!.hasManagedBlock, true);
                    assert.equal(epItem!.referencesRouter, true);

                    if (hasBridge) {
                        const bridgeItem = result.entrypoints.find((e) => e.file === bridgeProfile!.orchestratorRelativePath);
                        assert.ok(bridgeItem, `Should have checked bridge ${bridgeProfile!.orchestratorRelativePath}`);
                        assert.equal(bridgeItem!.exists, true);
                        assert.equal(bridgeItem!.kind, 'provider-bridge');
                        assert.equal(bridgeItem!.hasManagedBlock, true);
                    }
                } finally {
                    removeTempDir(dir);
                }
            });

            it('detects missing router', () => {
                const dir = createTempDir();
                try {
                    scaffoldProviderWorkspace(dir, {
                        provider,
                        writeMaterializedContent: true,
                        writeStartTaskRouter: false
                    });
                    // Ensure router does not exist
                    const routerPath = path.join(dir, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
                    if (fs.existsSync(routerPath)) fs.unlinkSync(routerPath);

                    const result = scanProviderCompliance(dir, [canonicalFile]);
                    assert.equal(result.routerExists, false);
                    assert.equal(result.passed, false);
                    assert.ok(result.violations.some((v) => v.includes('start-task router')));
                } finally {
                    removeTempDir(dir);
                }
            });

            it('detects missing managed block in entrypoint', () => {
                const dir = createTempDir();
                try {
                    // Write entrypoint without managed block
                    scaffoldProviderWorkspace(dir, { provider, writeMaterializedContent: false });
                    // Write router with managed reference
                    const routerPath = path.join(dir, SHARED_START_TASK_WORKFLOW_RELATIVE_PATH);
                    fs.writeFileSync(routerPath, `${MANAGED_START}\n# Router\n${MANAGED_END}`, 'utf8');

                    const result = scanProviderCompliance(dir, [canonicalFile]);
                    const epItem = result.entrypoints.find((e) => e.file === canonicalFile);
                    assert.ok(epItem);
                    assert.equal(epItem!.hasManagedBlock, false);
                    assert.equal(result.passed, false);
                } finally {
                    removeTempDir(dir);
                }
            });

            if (hasBridge) {
                it('detects missing bridge file', () => {
                    const dir = createTempDir();
                    try {
                        scaffoldProviderWorkspace(dir, {
                            provider,
                            writeMaterializedContent: true,
                            writeBridge: false
                        });
                        // Ensure bridge does not exist
                        const bridgePath = path.join(dir, bridgeProfile!.orchestratorRelativePath);
                        if (fs.existsSync(bridgePath)) fs.unlinkSync(bridgePath);

                        const result = scanProviderCompliance(dir, [canonicalFile]);
                        const bridgeItem = result.entrypoints.find((e) => e.file === bridgeProfile!.orchestratorRelativePath);
                        assert.ok(bridgeItem);
                        assert.equal(bridgeItem!.exists, false);
                        assert.equal(result.passed, false);
                    } finally {
                        removeTempDir(dir);
                    }
                });
            }
        });
    }
});

// ===========================================================================
// 4. Cross-provider execution context consistency
// ===========================================================================

describe('provider-workflow-execution: cross-provider execution context', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    it('shared canonical entrypoints stay explicit and limited to the approved provider set', () => {
        const providersByEntrypoint = new Map<string, string[]>();
        for (const provider of ALL_PROVIDERS) {
            const file = getCanonicalEntrypointFile(provider);
            assert.ok(file, `${provider} should resolve to an entrypoint`);
            const providers = providersByEntrypoint.get(file) || [];
            providers.push(provider);
            providersByEntrypoint.set(file, providers);
        }
        assert.deepEqual(providersByEntrypoint.get('AGENTS.md'), ['Codex', 'Cursor']);
        for (const [entrypoint, providers] of providersByEntrypoint.entries()) {
            if (entrypoint === 'AGENTS.md') {
                continue;
            }
            assert.equal(providers.length, 1, `Entrypoint ${entrypoint} should stay unique outside the approved shared-entrypoint contract`);
        }
    });

    it('bridge providers are a strict subset of all providers', () => {
        for (const [provider] of BRIDGE_PROVIDERS) {
            assert.ok(ALL_PROVIDERS.includes(provider), `Bridge provider ${provider} must be in ALL_PROVIDERS`);
        }
    });

    it('root-entrypoint-only providers have no bridge profile', () => {
        for (const provider of ROOT_ONLY_PROVIDERS) {
            const canonicalFile = getCanonicalEntrypointFile(provider);
            const bridge = BRIDGE_PROFILES.find((p) => p.entrypointFile === canonicalFile);
            assert.equal(bridge, undefined, `${provider} should have no bridge profile`);
        }
    });

    it('source-checkout context uses bin/garda.js for all providers', () => {
        for (const provider of ALL_PROVIDERS) {
            const dir = createTempDir();
            try {
                scaffoldProviderWorkspace(dir, { provider, sourceCheckout: true });
                const result = buildHandshakeDiagnostics({
                    taskId: `T-CTX-SC-${provider}`,
                    repoRoot: dir,
                    provider
                });
                assert.equal(result.cli_path, 'node bin/garda.js',
                    `${provider} source-checkout should use bin/garda.js`);
                assert.equal(result.execution_context, 'source-checkout');
            } finally {
                removeTempDir(dir);
            }
        }
    });

    it('materialized-bundle context uses garda-agent-orchestrator/bin/garda.js for all providers', () => {
        for (const provider of ALL_PROVIDERS) {
            const dir = createTempDir();
            try {
                scaffoldProviderWorkspace(dir, { provider, sourceCheckout: false });
                const result = buildHandshakeDiagnostics({
                    taskId: `T-CTX-MB-${provider}`,
                    repoRoot: dir,
                    provider
                });
                assert.equal(result.cli_path, 'node garda-agent-orchestrator/bin/garda.js',
                    `${provider} materialized-bundle should use garda-agent-orchestrator/bin/garda.js`);
                assert.equal(result.execution_context, 'materialized-bundle');
            } finally {
                removeTempDir(dir);
            }
        }
    });

    it('format output includes provider family name for all providers', () => {
        for (const provider of ALL_PROVIDERS) {
            const dir = createTempDir();
            try {
                scaffoldProviderWorkspace(dir, { provider });
                const result = buildHandshakeDiagnostics({
                    taskId: `T-FMT-${provider}`,
                    repoRoot: dir,
                    provider
                });
                const lines = formatHandshakeDiagnosticsResult(result);
                const joined = lines.join('\n');
                assert.ok(joined.includes(provider), `Formatted output should mention ${provider}`);
            } finally {
                removeTempDir(dir);
            }
        }
    });
});

// ===========================================================================
// 5. Materialized workflow content execution validation
// ===========================================================================

describe('provider-workflow-execution: materialized workflow gate sequence', () => {
    const templatePath = path.join(process.cwd(), 'template', 'entrypoints', 'canonical-rule-index.md');
    const templateContent = fs.readFileSync(templatePath, 'utf-8');

    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        it(`${provider}: start-task router contains all mandatory gates in order`, () => {
            const routerContent = buildSharedStartTaskWorkflowContent(canonicalFile);
            let lastIndex = -1;
            for (const gate of MANDATORY_GATE_NAMES) {
                const idx = routerContent.indexOf(`gate ${gate}`);
                assert.ok(idx >= 0, `Router for ${provider} must contain 'gate ${gate}'`);
                assert.ok(idx > lastIndex, `Gate '${gate}' must appear after previous gate in router for ${provider}`);
                lastIndex = idx;
            }
        });

        it(`${provider}: canonical entrypoint references start-task router`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, templateContent);
            assert.ok(block.includes(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH),
                `Canonical block for ${provider} must reference start-task router`);
        });

        it(`${provider}: canonical entrypoint contains managed markers`, () => {
            const block = buildCanonicalManagedBlock(canonicalFile, templateContent);
            assert.ok(block.includes(MANAGED_START));
            assert.ok(block.includes(MANAGED_END));
        });

        it(`${provider}: start-task router includes POST_PREFLIGHT reload step`, () => {
            const routerContent = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(routerContent.includes('POST_PREFLIGHT'),
                `Router for ${provider} must include POST_PREFLIGHT reload`);
        });

        it(`${provider}: start-task router hard stops include COMPLETION_GATE_PASSED`, () => {
            const routerContent = buildSharedStartTaskWorkflowContent(canonicalFile);
            assert.ok(routerContent.includes('COMPLETION_GATE_PASSED'),
                `Router for ${provider} must mention COMPLETION_GATE_PASSED`);
        });
    }
});

// ===========================================================================
// 6. Bridge provider execution contract validation
// ===========================================================================

describe('provider-workflow-execution: bridge execution contracts', () => {
    for (const [provider, profile] of BRIDGE_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        describe(`${provider} (bridge=${profile.orchestratorRelativePath})`, () => {
            it('bridge content references canonical entrypoint', () => {
                const content = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                assert.ok(content.includes(canonicalFile),
                    `Bridge for ${provider} must reference ${canonicalFile}`);
            });

            it('bridge content references start-task router', () => {
                const content = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                assert.ok(content.includes(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH),
                    `Bridge for ${provider} must reference start-task router`);
            });

            it('bridge content references TASK.md', () => {
                const content = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                assert.ok(content.includes('TASK.md'),
                    `Bridge for ${provider} must reference TASK.md`);
            });

            it('bridge content contains managed markers', () => {
                const content = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                assert.ok(content.includes(MANAGED_START));
                assert.ok(content.includes(MANAGED_END));
            });

            it('bridge references its own path', () => {
                const content = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                assert.ok(content.includes(profile.orchestratorRelativePath),
                    `Bridge for ${provider} must self-reference`);
            });

            if (profile.providerLabel !== 'Antigravity') {
                it('non-Antigravity bridge contains Required Execution Contract', () => {
                    const content = buildProviderOrchestratorAgentContent(
                        profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                    );
                    assert.ok(content.includes('Required Execution Contract'),
                        `Bridge for ${provider} must contain execution contract`);
                });

                it('non-Antigravity bridge contains gate enter-task-mode', () => {
                    const content = buildProviderOrchestratorAgentContent(
                        profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                    );
                    assert.ok(content.includes('gate enter-task-mode'),
                        `Bridge for ${provider} must reference enter-task-mode gate`);
                });

                it('non-Antigravity bridge contains Reviewer Launch Mapping', () => {
                    const content = buildProviderOrchestratorAgentContent(
                        profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                    );
                    assert.ok(content.includes('Reviewer Launch Mapping'),
                        `Bridge for ${provider} must contain reviewer mapping`);
                });

                it('non-Antigravity bridge contains POST_PREFLIGHT reload', () => {
                    const content = buildProviderOrchestratorAgentContent(
                        profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                    );
                    assert.ok(content.includes('POST_PREFLIGHT'),
                        `Bridge for ${provider} must include POST_PREFLIGHT`);
                });
            }
        });
    }
});

// ===========================================================================
// 7. Multi-provider active workspace compliance
// ===========================================================================

describe('provider-workflow-execution: multi-provider active workspace', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    it('compliance passes with all providers active and fully materialized', () => {
        // Materialize using Claude as canonical (arbitrary choice)
        const primaryProvider = 'Claude';
        scaffoldProviderWorkspace(tempDir, {
            provider: primaryProvider,
            writeMaterializedContent: true,
            writeRedirects: true
        });

        // Write all bridge files for active bridge providers
        for (const profile of BRIDGE_PROFILES) {
            const bridgePath = path.join(tempDir, profile.orchestratorRelativePath);
            if (!fs.existsSync(bridgePath)) {
                fs.mkdirSync(path.dirname(bridgePath), { recursive: true });
                const canonicalFile = getCanonicalEntrypointFile(primaryProvider);
                const bridgeContent = buildProviderOrchestratorAgentContent(
                    profile.providerLabel, canonicalFile, profile.orchestratorRelativePath
                );
                fs.writeFileSync(bridgePath, bridgeContent, 'utf8');
            }
        }

        const allFiles = ALL_AGENT_ENTRYPOINT_FILES as readonly string[];
        const result = scanProviderCompliance(tempDir, allFiles);
        assert.equal(result.routerExists, true);
        assert.equal(result.passed, true, `Multi-provider compliance should pass: ${result.violations.join('; ')}`);
    });

    it('compliance detects partial materialization', () => {
        // Only write Claude, leave others active but missing
        scaffoldProviderWorkspace(tempDir, {
            provider: 'Claude',
            writeMaterializedContent: true
        });

        // Declare GitHubCopilot as active but don't materialize it
        const result = scanProviderCompliance(tempDir, ['CLAUDE.md', '.github/copilot-instructions.md']);
        assert.equal(result.routerExists, true);
        // GitHubCopilot entrypoint and bridge are missing
        const epItem = result.entrypoints.find((e) => e.file === '.github/copilot-instructions.md');
        assert.ok(epItem);
        assert.equal(epItem!.exists, false);
        assert.equal(result.passed, false);
    });

    it('handshake artifact staleness detected for active task', () => {
        scaffoldProviderWorkspace(tempDir, { provider: 'Codex', writeMaterializedContent: true });

        // Write a handshake artifact
        const reviewsDir = path.join(tempDir, 'garda-agent-orchestrator', 'runtime', 'reviews');
        fs.mkdirSync(reviewsDir, { recursive: true });
        const handshakePath = path.join(reviewsDir, 'T-STALE-01-handshake.json');
        fs.writeFileSync(handshakePath, JSON.stringify({
            schema_version: 1, event_source: 'handshake-diagnostics', task_id: 'T-STALE-01',
            status: 'PASSED', outcome: 'PASS', provider: 'Codex'
        }), 'utf8');

        // Write a newer task-mode artifact to trigger staleness
        const taskModePath = path.join(reviewsDir, 'T-STALE-01-task-mode.json');
        // Ensure task-mode mtime is clearly after handshake (2 seconds later)
        const futureTime = new Date(Date.now() + 2000);
        fs.writeFileSync(taskModePath, JSON.stringify({ task_id: 'T-STALE-01' }), 'utf8');
        fs.utimesSync(taskModePath, futureTime, futureTime);

        const result = scanProviderCompliance(tempDir, ['AGENTS.md'], { activeTaskId: 'T-STALE-01' });
        const staleArtifact = result.handshakeArtifacts.find((a) => a.taskId === 'T-STALE-01');
        assert.ok(staleArtifact);
        assert.equal(staleArtifact!.stale, true);
        assert.equal(result.passed, false);
    });
});

// ===========================================================================
// 8. Redirect entrypoint execution-readiness per provider
// ===========================================================================

describe('provider-workflow-execution: redirect entrypoints reference router', () => {
    const templatePath = path.join(process.cwd(), 'template', 'entrypoints', 'canonical-rule-index.md');
    const templateContent = fs.readFileSync(templatePath, 'utf-8');
    const bridgePaths = BRIDGE_PROFILES.map((p) => p.orchestratorRelativePath);

    for (const provider of ALL_PROVIDERS) {
        const canonicalFile = getCanonicalEntrypointFile(provider);

        it(`redirects to ${provider} reference start-task router`, () => {
            for (const ep of ALL_AGENT_ENTRYPOINT_FILES) {
                if (ep === canonicalFile) continue;
                const redirect = buildRedirectManagedBlock(ep, canonicalFile, bridgePaths);
                assert.ok(redirect.includes(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH),
                    `Redirect from ${ep} to ${canonicalFile} must reference start-task router`);
            }
        });

        it(`redirects to ${provider} reference canonical file`, () => {
            for (const ep of ALL_AGENT_ENTRYPOINT_FILES) {
                if (ep === canonicalFile) continue;
                const redirect = buildRedirectManagedBlock(ep, canonicalFile, bridgePaths);
                assert.ok(redirect.includes(canonicalFile),
                    `Redirect from ${ep} must reference canonical ${canonicalFile}`);
            }
        });
    }
});

// ===========================================================================
// 9. Compliance format output covers all provider families
// ===========================================================================

describe('provider-workflow-execution: compliance format output', () => {
    let tempDir: string;

    beforeEach(() => { tempDir = createTempDir(); });
    afterEach(() => { removeTempDir(tempDir); });

    it('summary format includes router and entrypoint status', () => {
        scaffoldProviderWorkspace(tempDir, {
            provider: 'GitHubCopilot',
            writeMaterializedContent: true
        });

        const result = scanProviderCompliance(tempDir, ['.github/copilot-instructions.md']);
        const summary = formatProviderComplianceSummary(result);
        const joined = summary.join('\n');
        assert.ok(joined.includes('Provider Control Compliance'));
        assert.ok(joined.includes('.agents/workflows/start-task.md'));
    });

    it('detail format shows managed-block and references-router for each entrypoint', () => {
        scaffoldProviderWorkspace(tempDir, {
            provider: 'Windsurf',
            writeMaterializedContent: true
        });

        const result = scanProviderCompliance(tempDir, ['.windsurf/rules/rules.md']);
        const detail = formatProviderComplianceDetail(result);
        const joined = detail.join('\n');
        assert.ok(joined.includes('managed_block'));
        assert.ok(joined.includes('references_router'));
    });
});

// ===========================================================================
// 10. Structural invariants: drift detection guards
// ===========================================================================

describe('provider-workflow-execution: structural invariants', () => {
    it('shared-entrypoint providers keep more providers than unique entrypoint files', () => {
        assert.ok(
            ALL_PROVIDERS.length > ALL_AGENT_ENTRYPOINT_FILES.length,
            'Provider count should exceed unique entrypoint file count once shared entrypoints are supported'
        );
    });

    it('every provider in SOURCE_OF_TRUTH_VALUES resolves to a valid entrypoint', () => {
        const entrypointFiles = ALL_AGENT_ENTRYPOINT_FILES as readonly string[];
        for (const provider of ALL_PROVIDERS) {
            const file = getCanonicalEntrypointFile(provider);
            assert.ok(file, `${provider} must resolve to an entrypoint file`);
            assert.ok(entrypointFiles.includes(file),
                `${provider} entrypoint ${file} must be in ALL_AGENT_ENTRYPOINT_FILES`);
        }
    });

    it('every bridge profile maps to a known provider entrypoint', () => {
        const entrypointFiles = ALL_AGENT_ENTRYPOINT_FILES as readonly string[];
        for (const profile of BRIDGE_PROFILES) {
            assert.ok(entrypointFiles.includes(profile.entrypointFile),
                `Bridge entrypoint ${profile.entrypointFile} must be in ALL_AGENT_ENTRYPOINT_FILES`);
        }
    });

    it('bridge profile count matches provider registry bridge definitions', () => {
        const registryBridgeCount = getProviderEntries().filter((entry) => entry.bridge !== null).length;
        assert.equal(BRIDGE_PROFILES.length, registryBridgeCount);
    });

    it('root-entrypoint-only providers match provider registry non-bridge definitions', () => {
        const expected = new Set(
            getProviderEntries()
                .filter((entry) => entry.bridge === null)
                .map((entry) => entry.id)
        );
        const actual = new Set(ROOT_ONLY_PROVIDERS);
        assert.deepEqual(actual, expected);
    });

    it('SHARED_START_TASK_WORKFLOW_RELATIVE_PATH is .agents/workflows/start-task.md', () => {
        assert.equal(SHARED_START_TASK_WORKFLOW_RELATIVE_PATH, '.agents/workflows/start-task.md');
    });

    it('provider count matches provider registry definitions', () => {
        assert.equal(ALL_PROVIDERS.length, getProviderEntries().length);
    });
});
