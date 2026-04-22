import * as fs from 'node:fs';
import * as path from 'node:path';

import {
    getBundleCliCommand,
    getSourceCliCommand,
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
    normalizeSourceOfTruthValue,
    resolveReviewerRoutingPolicy,
    resolveRuntimeReviewerIdentity
} from './reviewer-routing';
import { getTaskModeEvidence } from './task-mode';
import {
    describePrePreflightCycleAnchor,
    getLatestPrePreflightCycleAnchor
} from './pre-preflight-cycle-anchor';
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
    execution_provider?: string | null;
    canonical_source_of_truth?: string | null;
    canonical_entrypoint: string | null;
    canonical_entrypoint_exists: boolean;
    provider_bridge: string | null;
    provider_bridge_exists: boolean;
    routed_to?: string | null;
    execution_provider_source?: string | null;
    reviewer_capability_level?: string | null;
    reviewer_expected_execution_mode?: string | null;
    reviewer_fallback_allowed?: boolean | null;
    reviewer_fallback_reason_required?: boolean | null;
    reviewer_subagent_launch_status?: string | null;
    reviewer_subagent_launch_route?: string | null;
    reviewer_subagent_launch_reason?: string | null;
    reviewer_subagent_launch_remediation?: string | null;
    runtime_identity_status?: string | null;
    runtime_identity_violations?: string[];
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
    canonicalSourceOfTruth?: string | null;
    cliPath?: string | null;
    effectiveCwd?: string | null;
    canonicalEntrypoint?: string | null;
    providerBridge?: string | null;
    routedTo?: string | null;
    executionProviderSource?: string | null;
    reviewerCapabilityLevel?: string | null;
    reviewerExpectedExecutionMode?: string | null;
    reviewerFallbackAllowed?: boolean | null;
    reviewerFallbackReasonRequired?: boolean | null;
    reviewerSubagentLaunchStatus?: string | null;
    reviewerSubagentLaunchRoute?: string | null;
    reviewerSubagentLaunchReason?: string | null;
    reviewerSubagentLaunchRemediation?: string | null;
    runtimeIdentityStatus?: string | null;
    runtimeIdentityViolations?: string[] | null;
    precheckViolations?: string[];
}

function normalizeRoutePath(value: unknown): string | null {
    const text = String(value || '').trim().replace(/\\/g, '/');
    if (!text) {
        return null;
    }
    return text.replace(/^\.\//, '');
}

function isAttestedReviewerSubagentExecutionSource(source: string | null): boolean {
    return source === 'provider_bridge'
        || source === 'provider_entrypoint'
        || source === 'explicit_provider'
        || source === 'task_mode';
}

function resolveCompatibilityReviewerSubagentLaunchStatus(
    repoRoot: string,
    taskId: string,
    taskModePath: string,
    artifactProvider: string | null,
    routedTo: string | null,
    executionProviderSource: string | null,
    runtimeIdentityStatus: string | null,
    recordedStatus: string | null
): string | null {
    const normalizedRecordedStatus = String(recordedStatus || '').trim().toLowerCase() || null;
    if (normalizedRecordedStatus) {
        return normalizedRecordedStatus;
    }
    if (runtimeIdentityStatus !== 'resolved' || !isAttestedReviewerSubagentExecutionSource(executionProviderSource)) {
        return null;
    }

    // Legacy handshake fixtures may omit launchability metadata, but only task-mode
    // evidence from the same task may corroborate a delegated reviewer launch path.
    const taskModeEvidence = getTaskModeEvidence(repoRoot, taskId, taskModePath);
    const normalizedTaskModeEvidencePath = String(taskModeEvidence.evidence_path || '').trim().toLowerCase() || null;
    const normalizedTaskModeTimelineArtifactPath = String(taskModeEvidence.timeline_artifact_path || '').trim().toLowerCase() || null;
    if (
        taskModeEvidence.evidence_status !== 'PASS'
        || taskModeEvidence.evidence_outcome !== 'PASS'
        || !taskModeEvidence.declares_runtime_identity_metadata
        || !taskModeEvidence.timeline_declares_runtime_identity_metadata
        || !normalizedTaskModeEvidencePath
        || !normalizedTaskModeTimelineArtifactPath
        || normalizedTaskModeEvidencePath !== normalizedTaskModeTimelineArtifactPath
        || taskModeEvidence.runtime_identity_status !== 'resolved'
        || taskModeEvidence.reviewer_subagent_launch_status !== 'launchable'
    ) {
        return null;
    }

    if (
        artifactProvider
        && taskModeEvidence.provider
        && taskModeEvidence.provider !== artifactProvider
    ) {
        return null;
    }

    const normalizedTaskModeRoute = normalizeRoutePath(taskModeEvidence.routed_to);
    if (routedTo && normalizedTaskModeRoute && routedTo !== normalizedTaskModeRoute) {
        return null;
    }

    return 'launchable';
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
    const identity = resolveRuntimeReviewerIdentity({
        repoRoot,
        executionProvider: options.provider,
        routedTo: options.routedTo ?? options.providerBridge,
        allowLegacyFallback: true
    });
    const executionProvider = normalizeSourceOfTruthValue(options.provider) ?? identity.execution_provider;
    const canonicalSourceOfTruth = normalizeSourceOfTruthValue(options.canonicalSourceOfTruth)
        ?? identity.canonical_source_of_truth;
    const canonicalEntrypoint = options.canonicalEntrypoint
        ? String(options.canonicalEntrypoint).trim()
        : (canonicalSourceOfTruth
            ? (SOURCE_TO_ENTRYPOINT_MAP as Record<string, string>)[canonicalSourceOfTruth] || null
            : null);
    const providerBridge = options.providerBridge
        ? String(options.providerBridge).trim()
        : identity.provider_bridge;
    const routedTo = String(options.routedTo || '').trim() || identity.routed_to || null;
    const executionProviderSource = String(options.executionProviderSource || '').trim()
        || identity.execution_provider_source
        || null;
    const runtimeIdentityStatus = String(options.runtimeIdentityStatus || '').trim()
        || identity.identity_status
        || null;
    const runtimeIdentityViolations = Array.isArray(options.runtimeIdentityViolations)
        ? options.runtimeIdentityViolations.map((entry) => String(entry || '').trim()).filter(Boolean)
        : [...identity.violations];
    const reviewerPolicy = resolveReviewerRoutingPolicy(executionProvider);
    const reviewerCapabilityLevel = String(options.reviewerCapabilityLevel || '').trim()
        || identity.capability_level
        || reviewerPolicy.capability_level
        || null;
    const reviewerExpectedExecutionMode = String(options.reviewerExpectedExecutionMode || '').trim()
        || identity.expected_execution_mode
        || reviewerPolicy.expected_execution_mode
        || null;
    const reviewerFallbackAllowed = typeof options.reviewerFallbackAllowed === 'boolean'
        ? options.reviewerFallbackAllowed
        : identity.fallback_allowed;
    const reviewerFallbackReasonRequired = typeof options.reviewerFallbackReasonRequired === 'boolean'
        ? options.reviewerFallbackReasonRequired
        : identity.fallback_reason_required;
    const reviewerSubagentLaunchStatus = String(options.reviewerSubagentLaunchStatus || '').trim()
        || identity.reviewer_subagent_launch_status
        || null;
    const reviewerSubagentLaunchRoute = String(options.reviewerSubagentLaunchRoute || '').trim()
        || identity.reviewer_subagent_launch_route
        || null;
    const reviewerSubagentLaunchReason = String(options.reviewerSubagentLaunchReason || '').trim()
        || identity.reviewer_subagent_launch_reason
        || null;
    const reviewerSubagentLaunchRemediation = String(options.reviewerSubagentLaunchRemediation || '').trim()
        || identity.reviewer_subagent_launch_remediation
        || null;
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
            provider: executionProvider,
            execution_provider: executionProvider,
            canonical_source_of_truth: canonicalSourceOfTruth,
            canonical_entrypoint: null,
            canonical_entrypoint_exists: false,
            provider_bridge: null,
            provider_bridge_exists: false,
            routed_to: routedTo,
            execution_provider_source: executionProviderSource,
            reviewer_capability_level: reviewerCapabilityLevel,
            reviewer_expected_execution_mode: reviewerExpectedExecutionMode,
            reviewer_fallback_allowed: reviewerFallbackAllowed,
            reviewer_fallback_reason_required: reviewerFallbackReasonRequired,
            reviewer_subagent_launch_status: reviewerSubagentLaunchStatus,
            reviewer_subagent_launch_route: reviewerSubagentLaunchRoute,
            reviewer_subagent_launch_reason: reviewerSubagentLaunchReason,
            reviewer_subagent_launch_remediation: reviewerSubagentLaunchRemediation,
            runtime_identity_status: runtimeIdentityStatus,
            runtime_identity_violations: runtimeIdentityViolations,
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
    const canonicalEntrypointFullPath = canonicalEntrypoint
        ? path.resolve(repoRoot, canonicalEntrypoint)
        : null;
    const canonicalEntrypointExists = canonicalEntrypointFullPath
        ? fs.existsSync(canonicalEntrypointFullPath) && fs.statSync(canonicalEntrypointFullPath).isFile()
        : false;
    const providerBridgeFullPath = providerBridge
        ? path.resolve(repoRoot, providerBridge)
        : null;
    const providerBridgeExists = providerBridgeFullPath
        ? fs.existsSync(providerBridgeFullPath) && fs.statSync(providerBridgeFullPath).isFile()
        : false;

    if (runtimeIdentityViolations.length > 0) {
        for (const violation of runtimeIdentityViolations) {
            if (!violations.includes(violation)) {
                violations.push(violation);
            }
        }
    }

    if (runtimeIdentityStatus === 'resolved') {
        diagnostics.push({
            check: 'runtime_identity',
            status: 'ok',
            detail: `Runtime identity resolved: execution_provider=${executionProvider || 'unknown'}, source=${executionProviderSource || 'unknown'}, routed_to=${routedTo || 'none'}.`
        });
    } else if (runtimeIdentityStatus === 'legacy_fallback') {
        diagnostics.push({
            check: 'runtime_identity',
            status: 'error',
            detail: 'Runtime identity fell back to canonical SourceOfTruth. New task cycles require provider bridge, routed entrypoint, or explicit provider selection.'
        });
        violations.push(
            'Runtime execution identity relied on legacy SourceOfTruth fallback. ' +
            'Re-enter task mode with a deterministic routed entrypoint/bridge or explicit provider selection before handshake.'
        );
    } else if (runtimeIdentityStatus === 'missing') {
        diagnostics.push({
            check: 'runtime_identity',
            status: 'error',
            detail: 'Runtime execution identity is missing. Handshake requires provider bridge, routed entrypoint, or explicit provider selection.'
        });
        violations.push(
            'Runtime execution identity is missing. Handshake requires provider bridge, routed entrypoint, or explicit provider selection.'
        );
    } else {
        diagnostics.push({
            check: 'runtime_identity',
            status: 'error',
            detail: `Runtime execution identity is contradictory. Source=${executionProviderSource || 'unknown'}, routed_to=${routedTo || 'none'}.`
        });
    }

    if (reviewerSubagentLaunchStatus === 'launchable') {
        diagnostics.push({
            check: 'reviewer_subagent_launch',
            status: 'ok',
            detail: reviewerSubagentLaunchReason || `Reviewer subagent launch is attested for provider '${executionProvider || 'unknown'}'.`
        });
    } else if (reviewerSubagentLaunchStatus === 'blocked') {
        diagnostics.push({
            check: 'reviewer_subagent_launch',
            status: 'error',
            detail: reviewerSubagentLaunchReason || 'Reviewer subagent launch is blocked for this runtime session.'
        });
        violations.push(
            reviewerSubagentLaunchRemediation
                ? `${reviewerSubagentLaunchReason || 'Reviewer subagent launch is blocked for this runtime session.'} ${reviewerSubagentLaunchRemediation}`
                : (reviewerSubagentLaunchReason || 'Reviewer subagent launch is blocked for this runtime session.')
        );
    } else {
        diagnostics.push({
            check: 'reviewer_subagent_launch',
            status: 'error',
            detail: reviewerSubagentLaunchReason || 'Reviewer subagent launchability is unknown for this runtime session.'
        });
        violations.push(
            reviewerSubagentLaunchRemediation
                ? `${reviewerSubagentLaunchReason || 'Reviewer subagent launchability is unknown for this runtime session.'} ${reviewerSubagentLaunchRemediation}`
                : (reviewerSubagentLaunchReason || 'Reviewer subagent launchability is unknown for this runtime session.')
        );
    }

    if (!canonicalSourceOfTruth) {
        diagnostics.push({
            check: 'canonical_source_of_truth',
            status: 'error',
            detail: 'Canonical SourceOfTruth is missing. Handshake requires explicit workspace ownership from init answers or version metadata.'
        });
        violations.push(
            'Canonical SourceOfTruth is missing. Handshake requires explicit workspace ownership from init answers or version metadata.'
        );
    }

    // 1. Canonical entrypoint
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
    if (providerBridge) {
        if (providerBridgeExists) {
            diagnostics.push({
                check: 'provider_bridge',
                status: 'ok',
                detail: `Provider bridge '${providerBridge}' exists.`
            });
        } else if (executionProviderSource === 'provider_bridge') {
            diagnostics.push({
                check: 'provider_bridge',
                status: 'error',
                detail: `Provider bridge '${providerBridge}' not found. Expected bridge file is missing for this bridge-routed runtime session.`
            });
            violations.push(`Provider bridge '${providerBridge}' is missing from workspace for the active bridge-routed runtime session.`);
        } else {
            diagnostics.push({
                check: 'provider_bridge',
                status: 'warning',
                detail: `Provider bridge '${providerBridge}' not found, but the current runtime session is '${executionProviderSource || 'unknown'}' so bridge presence is telemetry-only here.`
            });
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
    if (executionProvider) {
        diagnostics.push({
            check: 'provider_family',
            status: 'ok',
            detail: `Active execution provider: ${executionProvider}.`
        });
    } else if (options.provider) {
        diagnostics.push({
            check: 'provider_family',
            status: 'warning',
            detail: `Provider '${String(options.provider).trim()}' is not a recognized provider family.`
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
        provider: executionProvider,
        execution_provider: executionProvider,
        canonical_source_of_truth: canonicalSourceOfTruth,
        canonical_entrypoint: canonicalEntrypoint,
        canonical_entrypoint_exists: canonicalEntrypointExists,
        provider_bridge: providerBridge,
        provider_bridge_exists: providerBridgeExists,
        routed_to: routedTo,
        execution_provider_source: executionProviderSource,
        reviewer_capability_level: reviewerCapabilityLevel,
        reviewer_expected_execution_mode: reviewerExpectedExecutionMode,
        reviewer_fallback_allowed: reviewerFallbackAllowed,
        reviewer_fallback_reason_required: reviewerFallbackReasonRequired,
        reviewer_subagent_launch_status: reviewerSubagentLaunchStatus,
        reviewer_subagent_launch_route: reviewerSubagentLaunchRoute,
        reviewer_subagent_launch_reason: reviewerSubagentLaunchReason,
        reviewer_subagent_launch_remediation: reviewerSubagentLaunchRemediation,
        runtime_identity_status: runtimeIdentityStatus,
        runtime_identity_violations: runtimeIdentityViolations,
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
    taskModePath?: string;
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
    result.provider = String(artifact.execution_provider || artifact.provider || '').trim() || null;

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
    const artifactProvider = String(artifact.execution_provider || artifact.provider || '').trim() || null;
    const executionProviderSource = String(artifact.execution_provider_source || '').trim().toLowerCase() || null;
    const routedTo = normalizeRoutePath(artifact.routed_to);
    const runtimeIdentityStatus = String(artifact.runtime_identity_status || '').trim().toLowerCase() || null;
    const reviewerSubagentLaunchStatus = resolveCompatibilityReviewerSubagentLaunchStatus(
        repoRoot,
        resolvedTaskId,
        String(opts.taskModePath || '').trim(),
        artifactProvider,
        routedTo,
        executionProviderSource,
        runtimeIdentityStatus,
        String(artifact.reviewer_subagent_launch_status || '').trim()
    );
    if (!isAttestedReviewerSubagentExecutionSource(executionProviderSource)) {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            executionProviderSource
                ? `Handshake diagnostics evidence is not usable because execution_provider_source is '${executionProviderSource}', ` +
                    'which does not attest launchable reviewer subagents. Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics.'
                : 'Handshake diagnostics evidence is not usable because execution_provider_source is missing. ' +
                    'Re-enter task mode with explicit runtime identity and rerun handshake-diagnostics.'
        );
        return result;
    }
    if (runtimeIdentityStatus !== 'resolved') {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence is not usable because runtime_identity_status is '${runtimeIdentityStatus || 'unknown'}'. ` +
            'Re-enter task mode through a launchable provider route and rerun handshake-diagnostics.'
        );
        return result;
    }
    if (reviewerSubagentLaunchStatus !== 'launchable') {
        result.evidence_status = 'EVIDENCE_RUNTIME_SESSION_INVALID';
        result.violations.push(
            `Handshake diagnostics evidence is not usable because reviewer_subagent_launch_status is '${reviewerSubagentLaunchStatus || 'unknown'}'. ` +
            'Re-enter task mode through a launchable provider route and rerun handshake-diagnostics.'
        );
        return result;
    }
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
    const latestCycleAnchor = getLatestPrePreflightCycleAnchor(events);
    const latestHandshake = findLatestTimelineEvent(events, 'HANDSHAKE_DIAGNOSTICS_RECORDED');

    if (!latestCycleAnchor) {
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

    if (latestHandshake.sequence < latestCycleAnchor.sequence) {
        return [
            `Latest HANDSHAKE_DIAGNOSTICS_RECORDED evidence in '${normalizePath(resolvedTimeline)}' predates the ` +
            `${describePrePreflightCycleAnchor(latestCycleAnchor)} ` +
            `(handshake seq ${latestHandshake.sequence}). ` +
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
        case 'EVIDENCE_RUNTIME_SESSION_INVALID':
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
        `ExecutionProvider: ${artifact.execution_provider || artifact.provider || 'unknown'}`,
        `CanonicalSourceOfTruth: ${artifact.canonical_source_of_truth || 'unknown'}`,
        `CanonicalEntrypoint: ${artifact.canonical_entrypoint || 'none'} (${artifact.canonical_entrypoint_exists ? 'exists' : 'missing'})`,
        `ProviderBridge: ${artifact.provider_bridge || 'none'} (${artifact.provider_bridge_exists ? 'exists' : 'not expected or missing'})`,
        `RoutedTo: ${artifact.routed_to || 'none'}`,
        `ExecutionProviderSource: ${artifact.execution_provider_source || 'unknown'}`,
        `RuntimeIdentityStatus: ${artifact.runtime_identity_status || 'unknown'}`,
        `ReviewerCapabilityLevel: ${artifact.reviewer_capability_level || 'unknown'}`,
        `ReviewerExpectedExecutionMode: ${artifact.reviewer_expected_execution_mode || 'unknown'}`,
        `ReviewerSubagentLaunchStatus: ${artifact.reviewer_subagent_launch_status || 'unknown'}`,
        `ReviewerSubagentLaunchRoute: ${artifact.reviewer_subagent_launch_route || 'none'}`,
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

    if (Array.isArray(artifact.runtime_identity_violations) && artifact.runtime_identity_violations.length > 0) {
        lines.push('RuntimeIdentityViolations:');
        for (const violation of artifact.runtime_identity_violations) {
            lines.push(`  - ${violation}`);
        }
    }

    return lines;
}
