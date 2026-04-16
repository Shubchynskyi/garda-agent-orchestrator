import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
    SOURCE_OF_TRUTH_VALUES,
    SOURCE_TO_ENTRYPOINT_MAP,
    resolveBundleName
} from '../core/constants';
import { redactPath } from '../core/redaction';
import { assertValidTaskId } from '../gate-runtime/task-events';
import {
    getProviderOrchestratorProfileDefinitions,
    SHARED_START_TASK_WORKFLOW_RELATIVE_PATH
} from '../materialization/common';
import {
    fileSha256,
    isOrchestratorSourceCheckout,
    joinOrchestratorPath,
    normalizePath,
    resolvePathInsideRepo,
    toPosix
} from './helpers';

export interface HandshakeDiagnosticsArtifact {
    schema_version: 1;
    timestamp_utc: string;
    event_source: 'handshake-diagnostics';
    task_id: string;
    status: 'PASSED' | 'FAILED';
    outcome: 'PASS' | 'FAIL';

    provider: string | null;
    canonical_entrypoint: string | null;
    canonical_entrypoint_exists: boolean;
    provider_bridge: string | null;
    provider_bridge_exists: boolean;
    start_task_router_path: string;
    start_task_router_exists: boolean;
    execution_context: 'source-checkout' | 'materialized-bundle';
    cli_path: string;
    effective_cwd: string;
    workspace_root: string;

    diagnostics: HandshakeDiagnostic[];
    violations: string[];
}

export interface HandshakeDiagnostic {
    check: string;
    status: 'ok' | 'warning' | 'error';
    detail: string;
}

export interface HandshakeEvidenceResult {
    task_id: string | null;
    evidence_path: string | null;
    evidence_hash: string | null;
    evidence_status: string;
    provider: string | null;
    violations: string[];
}

export interface BuildHandshakeDiagnosticsOptions {
    taskId: string;
    repoRoot: string;
    provider?: string | null;
    cliPath?: string | null;
    effectiveCwd?: string | null;
    canonicalEntrypoint?: string | null;
    providerBridge?: string | null;
    precheckViolations?: string[];
}

function resolveProviderFamily(provider: string | null): string | null {
    if (!provider) return null;
    const normalized = String(provider).trim();
    const match = SOURCE_OF_TRUTH_VALUES.find(
        (v) => v.toLowerCase() === normalized.toLowerCase().replace(/\s+/g, '')
    );
    return match || null;
}

function resolveCanonicalEntrypoint(provider: string | null): string | null {
    const family = resolveProviderFamily(provider);
    if (!family) return null;
    const map = SOURCE_TO_ENTRYPOINT_MAP as Record<string, string>;
    return map[family] || null;
}

function resolveProviderBridge(provider: string | null): string | null {
    const family = resolveProviderFamily(provider);
    if (!family) return null;
    const entrypoint = resolveCanonicalEntrypoint(family);
    if (!entrypoint) return null;
    const profiles = getProviderOrchestratorProfileDefinitions();
    const match = profiles.find((p) => p.entrypointFile === entrypoint);
    return match ? match.orchestratorRelativePath : null;
}

function resolveCliPath(repoRoot: string, isSourceCheckout: boolean): string {
    if (isSourceCheckout) {
        return getSourceCliCommand();
    }
    return getBundleCliCommand(resolveBundleName());
}

export function resolveHandshakeArtifactPath(repoRoot: string, taskId: string, artifactPath = ''): string {
    const explicit = String(artifactPath || '').trim();
    if (explicit) {
        const resolved = resolvePathInsideRepo(explicit, repoRoot, { allowMissing: true });
        if (!resolved) {
            throw new Error('HandshakeArtifactPath must not be empty.');
        }
        return resolved;
    }
    return joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews', `${taskId}-handshake.json`));
}

export function buildHandshakeDiagnostics(options: BuildHandshakeDiagnosticsOptions): HandshakeDiagnosticsArtifact {
    const taskId = assertValidTaskId(options.taskId);
    const repoRoot = path.resolve(String(options.repoRoot || '.'));
    const isSourceCheckout = isOrchestratorSourceCheckout(repoRoot);
    const provider = String(options.provider || '').trim() || null;
    const providerFamily = resolveProviderFamily(provider);
    const diagnostics: HandshakeDiagnostic[] = [];
    const precheckViolations = Array.isArray(options.precheckViolations)
        ? options.precheckViolations.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [];
    const violations: string[] = [...precheckViolations];

    if (precheckViolations.length > 0) {
        return {
            schema_version: 1,
            timestamp_utc: new Date().toISOString(),
            event_source: 'handshake-diagnostics',
            task_id: taskId,
            status: 'FAILED',
            outcome: 'FAIL',
            provider: providerFamily,
            canonical_entrypoint: null,
            canonical_entrypoint_exists: false,
            provider_bridge: null,
            provider_bridge_exists: false,
            start_task_router_path: SHARED_START_TASK_WORKFLOW_RELATIVE_PATH,
            start_task_router_exists: false,
            execution_context: isSourceCheckout ? 'source-checkout' : 'materialized-bundle',
            cli_path: options.cliPath ? String(options.cliPath).trim() : resolveCliPath(repoRoot, isSourceCheckout),
            effective_cwd: redactPath(options.effectiveCwd ? String(options.effectiveCwd).trim() : toPosix(repoRoot), repoRoot),
            workspace_root: redactPath(toPosix(repoRoot)),
            diagnostics,
            violations
        };
    }

    // 1. Canonical entrypoint
    const canonicalEntrypoint = options.canonicalEntrypoint
        ? String(options.canonicalEntrypoint).trim()
        : resolveCanonicalEntrypoint(provider);
    const canonicalEntrypointFullPath = canonicalEntrypoint
        ? path.resolve(repoRoot, canonicalEntrypoint)
        : null;
    const canonicalEntrypointExists = canonicalEntrypointFullPath
        ? fs.existsSync(canonicalEntrypointFullPath) && fs.statSync(canonicalEntrypointFullPath).isFile()
        : false;

    if (canonicalEntrypoint) {
        if (canonicalEntrypointExists) {
            diagnostics.push({
                check: 'canonical_entrypoint',
                status: 'ok',
                detail: `Canonical entrypoint '${canonicalEntrypoint}' exists.`
            });
        } else {
            diagnostics.push({
                check: 'canonical_entrypoint',
                status: 'error',
                detail: `Canonical entrypoint '${canonicalEntrypoint}' not found in workspace.`
            });
            violations.push(`Canonical entrypoint '${canonicalEntrypoint}' is missing from workspace root.`);
        }
    } else {
        diagnostics.push({
            check: 'canonical_entrypoint',
            status: 'warning',
            detail: 'No provider specified; canonical entrypoint could not be resolved.'
        });
    }

    // 2. Provider bridge
    const providerBridge = options.providerBridge
        ? String(options.providerBridge).trim()
        : resolveProviderBridge(provider);
    const providerBridgeFullPath = providerBridge
        ? path.resolve(repoRoot, providerBridge)
        : null;
    const providerBridgeExists = providerBridgeFullPath
        ? fs.existsSync(providerBridgeFullPath) && fs.statSync(providerBridgeFullPath).isFile()
        : false;

    if (providerBridge) {
        if (providerBridgeExists) {
            diagnostics.push({
                check: 'provider_bridge',
                status: 'ok',
                detail: `Provider bridge '${providerBridge}' exists.`
            });
        } else {
            diagnostics.push({
                check: 'provider_bridge',
                status: 'error',
                detail: `Provider bridge '${providerBridge}' not found. Expected bridge file is missing for this provider.`
            });
            violations.push(`Provider bridge '${providerBridge}' is missing from workspace. This provider family requires a bridge file.`);
        }
    } else {
        diagnostics.push({
            check: 'provider_bridge',
            status: 'ok',
            detail: 'No provider bridge expected for this provider family (root-entrypoint-only).'
        });
    }

    // 3. Start-task router
    const startTaskRouterPath = SHARED_START_TASK_WORKFLOW_RELATIVE_PATH;
    const startTaskRouterFullPath = path.resolve(repoRoot, startTaskRouterPath);
    const startTaskRouterExists = fs.existsSync(startTaskRouterFullPath) && fs.statSync(startTaskRouterFullPath).isFile();

    if (startTaskRouterExists) {
        diagnostics.push({
            check: 'start_task_router',
            status: 'ok',
            detail: `Shared start-task router '${startTaskRouterPath}' exists.`
        });
    } else {
        diagnostics.push({
            check: 'start_task_router',
            status: 'error',
            detail: `Shared start-task router '${startTaskRouterPath}' not found.`
        });
        violations.push(`Shared start-task router '${startTaskRouterPath}' is missing from workspace.`);
    }

    // 4. Execution context
    const executionContext = isSourceCheckout ? 'source-checkout' : 'materialized-bundle';
    diagnostics.push({
        check: 'execution_context',
        status: 'ok',
        detail: `Execution context: ${executionContext}.`
    });

    // 5. CLI path
    const cliPath = options.cliPath
        ? String(options.cliPath).trim()
        : resolveCliPath(repoRoot, isSourceCheckout);
    const expectedCliPath = resolveCliPath(repoRoot, isSourceCheckout);
    if (cliPath === expectedCliPath) {
        diagnostics.push({
            check: 'cli_path',
            status: 'ok',
            detail: `CLI path '${cliPath}' matches expected path for ${executionContext}.`
        });
    } else {
        diagnostics.push({
            check: 'cli_path',
            status: 'error',
            detail: `CLI path '${cliPath}' differs from expected '${expectedCliPath}' for ${executionContext}. Inconsistent launcher path is a handshake defect.`
        });
        violations.push(
            `CLI path mismatch: got '${cliPath}', expected '${expectedCliPath}' for ${executionContext}. ` +
            'Inconsistent launcher path indicates the session may not be using the correct orchestrator entrypoint.'
        );
    }

    // 6. Effective cwd
    const effectiveCwd = options.effectiveCwd
        ? String(options.effectiveCwd).trim()
        : toPosix(repoRoot);
    diagnostics.push({
        check: 'effective_cwd',
        status: 'ok',
        detail: `Effective cwd: ${effectiveCwd}.`
    });

    // 7. Provider family
    if (providerFamily) {
        diagnostics.push({
            check: 'provider_family',
            status: 'ok',
            detail: `Active provider family: ${providerFamily}.`
        });
    } else if (provider) {
        diagnostics.push({
            check: 'provider_family',
            status: 'warning',
            detail: `Provider '${provider}' is not a recognized provider family.`
        });
    } else {
        diagnostics.push({
            check: 'provider_family',
            status: 'warning',
            detail: 'No provider specified; provider family unknown.'
        });
    }

    const hasErrors = violations.length > 0;
    return {
        schema_version: 1,
        timestamp_utc: new Date().toISOString(),
        event_source: 'handshake-diagnostics',
        task_id: taskId,
        status: hasErrors ? 'FAILED' : 'PASSED',
        outcome: hasErrors ? 'FAIL' : 'PASS',
        provider: providerFamily,
        canonical_entrypoint: canonicalEntrypoint,
        canonical_entrypoint_exists: canonicalEntrypointExists,
        provider_bridge: providerBridge,
        provider_bridge_exists: providerBridgeExists,
        start_task_router_path: startTaskRouterPath,
        start_task_router_exists: startTaskRouterExists,
        execution_context: executionContext,
        cli_path: cliPath,
        effective_cwd: redactPath(effectiveCwd, repoRoot),
        workspace_root: redactPath(toPosix(repoRoot)),
        diagnostics,
        violations
    };
}

export interface GetHandshakeEvidenceOptions {
    artifactPath?: string;
    timelinePath?: string;
}

interface TimelineEventEntry {
    event_type: string;
    sequence: number;
    details: Record<string, unknown> | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readTimelineEvents(timelinePath: string): TimelineEventEntry[] {
    const lines = fs.readFileSync(timelinePath, 'utf8').split('\n').filter(line => line.trim().length > 0);
    const events: TimelineEventEntry[] = [];
    let sequence = 0;

    for (const line of lines) {
        try {
            const parsed = JSON.parse(line) as Record<string, unknown>;
            const eventType = String(parsed.event_type || '').trim().toUpperCase();
            if (!eventType) {
                sequence += 1;
                continue;
            }
            events.push({
                event_type: eventType,
                sequence,
                details: isRecord(parsed.details) ? parsed.details : null
            });
        } catch {
            // Ignore malformed timeline lines here; upstream timeline collectors surface JSON errors separately.
        }
        sequence += 1;
    }

    return events;
}

function findLatestTimelineEvent(
    events: readonly TimelineEventEntry[],
    eventType: string
): TimelineEventEntry | null {
    const normalizedEventType = String(eventType || '').trim().toUpperCase();
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event.event_type === normalizedEventType) {
            return event;
        }
    }
    return null;
}

export function getHandshakeEvidence(repoRoot: string, taskId: string | null, artifactPathOrOptions: string | GetHandshakeEvidenceOptions = ''): HandshakeEvidenceResult {
    const opts: GetHandshakeEvidenceOptions = typeof artifactPathOrOptions === 'string'
        ? { artifactPath: artifactPathOrOptions }
        : artifactPathOrOptions;
    const result: HandshakeEvidenceResult = {
        task_id: taskId,
        evidence_path: null,
        evidence_hash: null,
        evidence_status: 'UNKNOWN',
        provider: null,
        violations: []
    };

    if (!taskId) {
        result.evidence_status = 'TASK_ID_MISSING';
        return result;
    }

    const resolvedTaskId = assertValidTaskId(taskId);
    const resolvedPath = resolveHandshakeArtifactPath(repoRoot, resolvedTaskId, opts.artifactPath || '');
    result.evidence_path = normalizePath(resolvedPath);

    if (!fs.existsSync(resolvedPath) || !fs.statSync(resolvedPath).isFile()) {
        result.evidence_status = 'EVIDENCE_FILE_MISSING';
        result.violations.push(
            `Handshake diagnostics evidence missing: file not found at '${result.evidence_path}'. ` +
            'Run handshake-diagnostics before implementation gates.'
        );
        return result;
    }

    let artifact: Record<string, unknown>;
    try {
        artifact = JSON.parse(fs.readFileSync(resolvedPath, 'utf8')) as Record<string, unknown>;
    } catch {
        result.evidence_status = 'EVIDENCE_INVALID_JSON';
        result.violations.push(`Handshake diagnostics evidence is invalid JSON at '${result.evidence_path}'.`);
        return result;
    }

    result.evidence_hash = fileSha256(resolvedPath);
    result.provider = String(artifact.provider || '').trim() || null;

    const evidenceTaskId = String(artifact.task_id || '').trim();
    if (evidenceTaskId !== resolvedTaskId) {
        result.evidence_status = 'EVIDENCE_TASK_MISMATCH';
        result.violations.push(
            `Handshake diagnostics task mismatch. Expected '${resolvedTaskId}', got '${evidenceTaskId}'.`
        );
        return result;
    }

    const eventSource = String(artifact.event_source || '').trim();
    if (eventSource !== 'handshake-diagnostics') {
        result.evidence_status = 'EVIDENCE_SOURCE_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence source is invalid. Expected 'handshake-diagnostics', got '${eventSource}'.`
        );
        return result;
    }

    // Timeline cross-verification: artifact hash must be bound to a timeline event
    const timelineViolations = verifyHandshakeTimelineBinding(resolvedTaskId, result.evidence_hash, opts.timelinePath);
    if (timelineViolations.length > 0) {
        result.evidence_status = 'EVIDENCE_TIMELINE_UNBOUND';
        result.violations.push(...timelineViolations);
        return result;
    }

    const status = String(artifact.status || '').trim().toUpperCase();
    const outcome = String(artifact.outcome || '').trim().toUpperCase();
    if (status === 'PASSED' && outcome === 'PASS') {
        result.evidence_status = 'PASS';
        return result;
    }

    // Artifact exists but reported violations
    result.evidence_status = 'PASS_WITH_VIOLATIONS';
    const artifactViolations = Array.isArray(artifact.violations) ? artifact.violations : [];
    for (const v of artifactViolations) {
        result.violations.push(`Handshake diagnostic violation: ${String(v)}`);
    }

    return result;
}

/**
 * Verify that a HANDSHAKE_DIAGNOSTICS_RECORDED event exists in the timeline
 * and its latest recorded artifact_hash matches the actual artifact hash on disk.
 * Returns an empty array if verification passes or timeline is unavailable.
 */
function verifyHandshakeTimelineBinding(
    taskId: string,
    artifactHash: string | null,
    timelinePath?: string
): string[] {
    if (!timelinePath) return [];

    const resolvedTimeline = path.resolve(timelinePath);
    if (!fs.existsSync(resolvedTimeline) || !fs.statSync(resolvedTimeline).isFile()) {
        return [];
    }

    const events = readTimelineEvents(resolvedTimeline);
    const latestTaskMode = findLatestTimelineEvent(events, 'TASK_MODE_ENTERED');
    const latestHandshake = findLatestTimelineEvent(events, 'HANDSHAKE_DIAGNOSTICS_RECORDED');

    if (!latestTaskMode) {
        return [
            `Handshake diagnostics evidence is not bound to an active task cycle for '${taskId}'. ` +
            `Task timeline '${normalizePath(resolvedTimeline)}' is missing TASK_MODE_ENTERED. ` +
            'Run enter-task-mode before handshake-diagnostics and downstream preflight gates.'
        ];
    }

    if (!latestHandshake) {
        return [
            `Handshake diagnostics evidence is not bound to task timeline for '${taskId}'. ` +
            `HANDSHAKE_DIAGNOSTICS_RECORDED event is missing from '${normalizePath(resolvedTimeline)}'. ` +
            'Run handshake-diagnostics gate to emit proper lifecycle evidence.'
        ];
    }

    if (latestHandshake.sequence < latestTaskMode.sequence) {
        return [
            `Latest HANDSHAKE_DIAGNOSTICS_RECORDED evidence in '${normalizePath(resolvedTimeline)}' predates the latest TASK_MODE_ENTERED ` +
            `(handshake seq ${latestHandshake.sequence}, task-mode seq ${latestTaskMode.sequence}). ` +
            'Re-run handshake-diagnostics for the current task cycle before shell-smoke-preflight, classify-change, or compile-gate. ' +
            'Do not parallelize enter-task-mode, handshake-diagnostics, and shell-smoke-preflight for the same task cycle.'
        ];
    }

    const recordedHash = latestHandshake.details && typeof latestHandshake.details.artifact_hash === 'string'
        ? latestHandshake.details.artifact_hash
        : null;
    if (artifactHash && recordedHash && artifactHash !== recordedHash) {
        return [
            `Handshake diagnostics artifact hash mismatch: file hash '${artifactHash}' ` +
            `does not match timeline-recorded hash '${recordedHash}'. ` +
            'The artifact may have been modified after the handshake gate ran.'
        ];
    }

    return [];
}

export function getHandshakeEvidenceViolations(result: HandshakeEvidenceResult): string[] {
    switch (result.evidence_status) {
        case 'PASS':
        case 'PASS_WITH_VIOLATIONS':
            return result.violations;
        case 'TASK_ID_MISSING':
            return ['Handshake diagnostics evidence cannot be verified: task id is missing.'];
        case 'EVIDENCE_FILE_MISSING':
            return result.violations;
        case 'EVIDENCE_INVALID_JSON':
            return result.violations;
        case 'EVIDENCE_TASK_MISMATCH':
            return result.violations;
        case 'EVIDENCE_SOURCE_INVALID':
            return result.violations;
        case 'EVIDENCE_TIMELINE_UNBOUND':
            return result.violations;
        default:
            return ['Handshake diagnostics evidence is missing or invalid. Run handshake-diagnostics gate.'];
    }
}

export function formatHandshakeDiagnosticsResult(artifact: HandshakeDiagnosticsArtifact): string[] {
    const lines: string[] = [
        artifact.outcome === 'PASS' ? 'HANDSHAKE_DIAGNOSTICS_PASSED' : 'HANDSHAKE_DIAGNOSTICS_FAILED',
        `TaskId: ${artifact.task_id}`,
        `Provider: ${artifact.provider || 'unknown'}`,
        `CanonicalEntrypoint: ${artifact.canonical_entrypoint || 'none'} (${artifact.canonical_entrypoint_exists ? 'exists' : 'missing'})`,
        `ProviderBridge: ${artifact.provider_bridge || 'none'} (${artifact.provider_bridge_exists ? 'exists' : 'not expected or missing'})`,
        `StartTaskRouter: ${artifact.start_task_router_path} (${artifact.start_task_router_exists ? 'exists' : 'missing'})`,
        `ExecutionContext: ${artifact.execution_context}`,
        `CliPath: ${artifact.cli_path}`,
        `EffectiveCwd: ${artifact.effective_cwd}`,
        `WorkspaceRoot: ${artifact.workspace_root}`
    ];

    if (artifact.diagnostics.length > 0) {
        lines.push('Diagnostics:');
        for (const d of artifact.diagnostics) {
            const icon = d.status === 'ok' ? '+' : d.status === 'warning' ? '~' : '-';
            lines.push(`  [${icon}] ${d.check}: ${d.detail}`);
        }
    }

    if (artifact.violations.length > 0) {
        lines.push('Violations:');
        for (const v of artifact.violations) {
            lines.push(`  - ${v}`);
        }
    }

    return lines;
}
