import * as fs from 'node:fs';
import * as path from 'node:path';

import { SOURCE_TO_ENTRYPOINT_MAP } from '../../core/constants';
import { redactPath } from '../../core/redaction';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { SHARED_START_TASK_WORKFLOW_RELATIVE_PATH } from '../../materialization/common';
import {
    normalizeSourceOfTruthValue,
    resolveReviewerRoutingPolicy,
    resolveRuntimeReviewerIdentity
} from '../review/reviewer-routing';
import {
    isOrchestratorSourceCheckout,
    toPosix
} from '../shared/helpers';
import { resolveCliPath } from './handshake-diagnostics-paths';
import type {
    BuildHandshakeDiagnosticsOptions,
    HandshakeDiagnostic,
    HandshakeDiagnosticsArtifact
} from './handshake-diagnostics-types';

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
            cli_path: options.cliPath ? String(options.cliPath).trim() : resolveCliPath(isSourceCheckout),
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

    const executionContext = isSourceCheckout ? 'source-checkout' : 'materialized-bundle';
    diagnostics.push({
        check: 'execution_context',
        status: 'ok',
        detail: `Execution context: ${executionContext}.`
    });

    const cliPath = options.cliPath
        ? String(options.cliPath).trim()
        : resolveCliPath(isSourceCheckout);
    const expectedCliPath = resolveCliPath(isSourceCheckout);
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

    const effectiveCwd = options.effectiveCwd
        ? String(options.effectiveCwd).trim()
        : toPosix(repoRoot);
    diagnostics.push({
        check: 'effective_cwd',
        status: 'ok',
        detail: `Effective cwd: ${effectiveCwd}.`
    });

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
