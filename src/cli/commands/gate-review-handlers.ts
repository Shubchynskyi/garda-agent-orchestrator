import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    applyReviewerRoutingMetadata,
    buildReviewReceipt,
    normalizeReviewerExecutionMode
} from '../../gate-runtime/review-context';
import { assertValidTaskId } from '../../gate-runtime/task-events';
import { fileSha256 } from '../../gate-runtime/hash';
import {
    emitReviewerDelegationRoutedEventAsync,
    emitReviewRecordedEventAsync
} from '../../gate-runtime/lifecycle-events';
import { writeReviewArtifactJson } from '../../gate-runtime/review-artifacts';
import * as gateHelpers from '../../gates/helpers';
import { normalizePath } from '../../gates/helpers';
import { assertReviewLifecycleGuard } from '../../gates/review-lifecycle-guard';
import {
    runDocImpactGateCommand,
    runRequiredReviewsCheckCommand
} from './gates';
import {
    parseOptions,
    normalizePathValue
} from './cli-helpers';
import {
    type ParsedOptionsRecord,
    requireResolvedPath,
    removeArtifactIfExists
} from './shared-command-utils';

export async function handleRequiredReviewsCheck(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--task-mode-path': { key: 'taskModePath', type: 'string' },
        '--rule-pack-path': { key: 'rulePackPath', type: 'string' },
        '--code-review-verdict': { key: 'codeReviewVerdict', type: 'string' },
        '--db-review-verdict': { key: 'dbReviewVerdict', type: 'string' },
        '--security-review-verdict': { key: 'securityReviewVerdict', type: 'string' },
        '--refactor-review-verdict': { key: 'refactorReviewVerdict', type: 'string' },
        '--api-review-verdict': { key: 'apiReviewVerdict', type: 'string' },
        '--test-review-verdict': { key: 'testReviewVerdict', type: 'string' },
        '--performance-review-verdict': { key: 'performanceReviewVerdict', type: 'string' },
        '--infra-review-verdict': { key: 'infraReviewVerdict', type: 'string' },
        '--dependency-review-verdict': { key: 'dependencyReviewVerdict', type: 'string' },
        '--skip-reviews': { key: 'skipReviews', type: 'string' },
        '--skip-reason': { key: 'skipReason', type: 'string' },
        '--override-artifact-path': { key: 'overrideArtifactPath', type: 'string' },
        '--compile-evidence-path': { key: 'compileEvidencePath', type: 'string' },
        '--reviews-root': { key: 'reviewsRoot', type: 'string' },
        '--review-evidence-path': { key: 'reviewEvidencePath', type: 'string' },
        '--no-op-artifact-path': { key: 'noOpArtifactPath', type: 'string' },
        '--output-filters-path': { key: 'outputFiltersPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runRequiredReviewsCheckCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleDocImpactGate(gateArgv: string[]): Promise<void> {
    const defs = {
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--task-id': { key: 'taskId', type: 'string' },
        '--decision': { key: 'decision', type: 'string' },
        '--behavior-changed': { key: 'behaviorChanged', type: 'boolean' },
        '--docs-updated': { key: 'docsUpdated', type: 'string[]' },
        '--changelog-updated': { key: 'changelogUpdated', type: 'boolean' },
        '--sensitive-scope-reviewed': { key: 'sensitiveScopeReviewed', type: 'boolean' },
        '--sensitive-reviewed': { key: 'sensitiveReviewed', type: 'boolean' },
        '--rationale': { key: 'rationale', type: 'string' },
        '--artifact-path': { key: 'artifactPath', type: 'string' },
        '--metrics-path': { key: 'metricsPath', type: 'string' },
        '--emit-metrics': { key: 'emitMetrics', type: 'boolean' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options } = parseOptions(gateArgv, defs);
    const result = runDocImpactGateCommand(options);
    process.stdout.write(`${result.outputLines.join('\n')}\n`);
    if (result.exitCode !== 0) {
        process.exitCode = result.exitCode;
    }
}

export async function handleRecordReviewRouting(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-routing', 'review_phase');
    const reviewsRoot = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'reviews'));
    const preferredContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const fallbackContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-context.json`);
    const resolvedContextOverride = options.reviewContextPath
        ? gateHelpers.resolvePathInsideRepo(String(options.reviewContextPath), repoRoot, { allowMissing: true })
        : null;
    if (
        resolvedContextOverride &&
        resolvedContextOverride !== preferredContextPath &&
        resolvedContextOverride !== fallbackContextPath
    ) {
        throw new Error(
            `ReviewContextPath must point to the canonical review-context artifact for '${reviewType}'. ` +
            `Allowed paths: ${normalizePath(preferredContextPath)} or ${normalizePath(fallbackContextPath)}.`
        );
    }
    const contextPath = resolvedContextOverride || (fs.existsSync(preferredContextPath) ? preferredContextPath : fallbackContextPath);
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (!reviewerExecutionMode) {
        throw new Error("ReviewerExecutionMode is required. Expected one of 'delegated_subagent' or 'same_agent_fallback'.");
    }
    if (!reviewerIdentity) {
        throw new Error('ReviewerIdentity is required.');
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review routing cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review routing requires an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (!reviewerIdentity.startsWith('self:')) {
        throw new Error("Fallback review routing requires a self-scoped reviewer identity (prefix 'self:').");
    }

    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const capabilityLevel = String(currentRouting?.capability_level || '').trim().toLowerCase();
    const expectedExecutionMode = normalizeReviewerExecutionMode(currentRouting?.expected_execution_mode);
    const fallbackAllowed = currentRouting?.fallback_allowed !== false;
    const fallbackReasonRequired = currentRouting?.fallback_reason_required === true;
    if (
        reviewerExecutionMode === 'delegated_subagent' &&
        (capabilityLevel === 'single_agent_only' || expectedExecutionMode === 'same_agent_fallback')
    ) {
        throw new Error(
            `Review '${reviewType}' cannot record delegated_subagent routing for provider ` +
            `'${String(currentRouting?.source_of_truth || 'unknown')}'. Explicit fallback is required instead.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && !fallbackAllowed) {
        throw new Error(
            `Review '${reviewType}' does not allow same_agent_fallback for provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }
    if (reviewerExecutionMode === 'same_agent_fallback' && fallbackReasonRequired && !reviewerFallbackReason) {
        throw new Error(
            `Review '${reviewType}' requires --reviewer-fallback-reason for same_agent_fallback ` +
            `on provider '${String(currentRouting?.source_of_truth || 'unknown')}'.`
        );
    }

    const routingUpdate = applyReviewerRoutingMetadata(contextPath, {
        actualExecutionMode: reviewerExecutionMode,
        reviewerSessionId: reviewerIdentity,
        fallbackReason: reviewerFallbackReason
    });
    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    await emitReviewerDelegationRoutedEventAsync(
        orchestratorRoot,
        taskId,
        reviewType,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason
    );
    console.log(
        `REVIEW_ROUTING_RECORDED: ${reviewType} ` +
        `(Context: ${normalizePath(contextPath)}, Sha256: ${routingUpdate.contextSha256 || 'n/a'})`
    );
}

export async function handleRecordReviewReceipt(gateArgv: string[]): Promise<void> {
    const defs = {
        '--task-id': { key: 'taskId', type: 'string' },
        '--review-type': { key: 'reviewType', type: 'string' },
        '--preflight-path': { key: 'preflightPath', type: 'string' },
        '--review-context-path': { key: 'reviewContextPath', type: 'string' },
        '--reviewer-execution-mode': { key: 'reviewerExecutionMode', type: 'string' },
        '--reviewer-identity': { key: 'reviewerIdentity', type: 'string' },
        '--reviewer-fallback-reason': { key: 'reviewerFallbackReason', type: 'string' },
        '--repo-root': { key: 'repoRoot', type: 'string' }
    };
    const { options: rawOptions } = parseOptions(gateArgv, defs, { allowPositionals: false });
    const options = rawOptions as ParsedOptionsRecord;
    const taskId = assertValidTaskId(options.taskId);
    const reviewType = String(options.reviewType || '').trim().toLowerCase();
    if (!reviewType) throw new Error('ReviewType is required.');

    const repoRoot = normalizePathValue(options.repoRoot || '.');
    assertReviewLifecycleGuard(repoRoot, taskId, 'record-review-receipt', 'review_phase');
    const preflightPath = path.resolve(repoRoot, String(options.preflightPath || ''));
    if (!fs.existsSync(preflightPath)) throw new Error(`Preflight artifact not found: ${preflightPath}`);
    const preflight = JSON.parse(fs.readFileSync(preflightPath, 'utf8'));
    const preflightSha256 = fileSha256(preflightPath);

    const reviewsRoot = path.dirname(preflightPath);
    const artifactPath = path.join(reviewsRoot, `${taskId}-${reviewType}.md`);
    if (!fs.existsSync(artifactPath)) throw new Error(`Review artifact not found: ${artifactPath}`);
    const artifactSha256 = fileSha256(artifactPath);

    const preferredContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-review-context.json`);
    const fallbackContextPath = path.join(reviewsRoot, `${taskId}-${reviewType}-context.json`);
    const resolvedContextOverride = options.reviewContextPath
        ? gateHelpers.resolvePathInsideRepo(String(options.reviewContextPath), repoRoot, { allowMissing: true })
        : null;
    if (
        resolvedContextOverride &&
        resolvedContextOverride !== preferredContextPath &&
        resolvedContextOverride !== fallbackContextPath
    ) {
        throw new Error(
            `ReviewContextPath must point to the canonical review-context artifact for '${reviewType}'. ` +
            `Allowed paths: ${normalizePath(preferredContextPath)} or ${normalizePath(fallbackContextPath)}.`
        );
    }
    const contextPath = resolvedContextOverride || (fs.existsSync(preferredContextPath) ? preferredContextPath : fallbackContextPath);
    if (!fs.existsSync(contextPath) || !fs.statSync(contextPath).isFile()) {
        throw new Error(`Review context artifact not found: ${normalizePath(contextPath)}.`);
    }

    const rawReviewerExecutionMode = options.reviewerExecutionMode
        ? String(options.reviewerExecutionMode).trim()
        : null;
    const reviewerExecutionMode = normalizeReviewerExecutionMode(rawReviewerExecutionMode);
    const reviewerIdentity = options.reviewerIdentity
        ? String(options.reviewerIdentity).trim()
        : null;
    const reviewerFallbackReason = options.reviewerFallbackReason
        ? String(options.reviewerFallbackReason).trim()
        : null;
    if (rawReviewerExecutionMode && !reviewerExecutionMode) {
        throw new Error(
            `ReviewerExecutionMode '${rawReviewerExecutionMode}' is invalid. ` +
            "Expected one of 'delegated_subagent' or 'same_agent_fallback'."
        );
    }
    if (reviewerExecutionMode === 'delegated_subagent') {
        if (!reviewerIdentity) {
            throw new Error('Delegated review receipts require --reviewer-identity.');
        }
        if (reviewerIdentity.startsWith('self:')) {
            throw new Error('Delegated review receipts cannot use a self-scoped reviewer identity.');
        }
        if (!reviewerIdentity.startsWith('agent:')) {
            throw new Error("Delegated review receipts require an agent-scoped reviewer identity (prefix 'agent:').");
        }
    } else if (reviewerExecutionMode === 'same_agent_fallback') {
        if (!reviewerIdentity) {
            throw new Error('Fallback review receipts require --reviewer-identity.');
        }
        if (!reviewerIdentity.startsWith('self:')) {
            throw new Error("Fallback review receipts require a self-scoped reviewer identity (prefix 'self:').");
        }
    }
    const parsedReviewContext = JSON.parse(fs.readFileSync(contextPath, 'utf8')) as Record<string, unknown>;
    const currentRouting = parsedReviewContext.reviewer_routing
        && typeof parsedReviewContext.reviewer_routing === 'object'
        && !Array.isArray(parsedReviewContext.reviewer_routing)
        ? parsedReviewContext.reviewer_routing as Record<string, unknown>
        : null;
    const currentExecutionMode = normalizeReviewerExecutionMode(currentRouting?.actual_execution_mode);
    const currentReviewerSessionId = currentRouting?.reviewer_session_id != null
        ? String(currentRouting.reviewer_session_id).trim()
        : '';
    if (currentExecutionMode !== reviewerExecutionMode) {
        throw new Error(
            `Review receipt execution mode (${reviewerExecutionMode}) must match pre-recorded ` +
            `reviewer_routing.actual_execution_mode (${currentExecutionMode || 'missing'}) in ${normalizePath(contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (!currentReviewerSessionId) {
        throw new Error(
            `Review receipts require pre-recorded reviewer_routing.reviewer_session_id in ${normalizePath(contextPath)}. ` +
            "Record review routing before writing the receipt."
        );
    }
    if (currentReviewerSessionId !== reviewerIdentity) {
        throw new Error(
            `Review receipt reviewer identity (${reviewerIdentity}) must match pre-recorded ` +
            `reviewer_routing.reviewer_session_id (${currentReviewerSessionId}).`
        );
    }
    const currentFallbackReason = currentRouting?.fallback_reason != null
        ? String(currentRouting.fallback_reason).trim()
        : '';
    if (reviewerExecutionMode === 'same_agent_fallback' && currentFallbackReason !== (reviewerFallbackReason || '')) {
        throw new Error(
            `Review receipt fallback reason (${reviewerFallbackReason || 'missing'}) must match pre-recorded ` +
            `reviewer_routing.fallback_reason (${currentFallbackReason || 'missing'}).`
        );
    }

    const timelinePath = gateHelpers.joinOrchestratorPath(repoRoot, path.join('runtime', 'task-events', `${taskId}.jsonl`));
    const hasMatchingRoutingEvent = fs.existsSync(timelinePath) && fs.statSync(timelinePath).isFile()
        ? fs.readFileSync(timelinePath, 'utf8')
            .split('\n')
            .filter((line) => line.trim().length > 0)
            .some((line) => {
                try {
                    const parsed = JSON.parse(line) as Record<string, unknown>;
                    const details = parsed.details && typeof parsed.details === 'object' && !Array.isArray(parsed.details)
                        ? parsed.details as Record<string, unknown>
                        : null;
                    const eventFallbackReason = String((details?.reviewer_fallback_reason ?? details?.reviewerFallbackReason) || '').trim();
                    return String(parsed.event_type || '').trim().toUpperCase() === 'REVIEWER_DELEGATION_ROUTED'
                        && String(details?.review_type || details?.reviewType || '').trim().toLowerCase() === reviewType
                        && normalizeReviewerExecutionMode(details?.reviewer_execution_mode ?? details?.reviewerExecutionMode) === reviewerExecutionMode
                        && String((details?.reviewer_session_id ?? details?.reviewerSessionId) || '').trim() === reviewerIdentity
                        && (reviewerExecutionMode !== 'same_agent_fallback' || eventFallbackReason === (reviewerFallbackReason || ''));
                } catch {
                    return false;
                }
            })
        : false;
    if (!hasMatchingRoutingEvent) {
        throw new Error(
            `Review receipts require pre-recorded REVIEWER_DELEGATION_ROUTED telemetry for '${reviewType}' ` +
            `with reviewer '${reviewerIdentity}' and execution mode '${reviewerExecutionMode}'.`
        );
    }
    const contextSha256 = fileSha256(contextPath);

    const receipt = buildReviewReceipt({
        taskId,
        reviewType,
        preflightSha256,
        scopeSha256: preflight.metrics?.changed_files_sha256 || null,
        reviewContextSha256: contextSha256,
        reviewArtifactSha256: artifactSha256,
        reviewerExecutionMode,
        reviewerIdentity,
        reviewerFallbackReason,
        trustLevel: 'LOCAL_AUDITED'
    });

    const receiptPath = artifactPath.replace(/\.md$/, '-receipt.json');
    writeReviewArtifactJson(receiptPath, receipt);

    const orchestratorRoot = gateHelpers.joinOrchestratorPath(repoRoot, '');
    try {
        await emitReviewRecordedEventAsync(orchestratorRoot, taskId, reviewType, receipt);
    } catch (error: unknown) {
        removeArtifactIfExists(receiptPath);
        throw error;
    }
    console.log(`REVIEW_RECORDED: ${reviewType} (Receipt: ${normalizePath(receiptPath)})`);
}
